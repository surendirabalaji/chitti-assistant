// Tests for router/src/forwarder.ts (Lesson A10). Written by the assistant (student decision Nov 12).
// Requirements: Host rewrite (STATUS.md M1 403 finding), streaming, one `ollama_call` line per call
// with model/status/latency and NO prompt text (hard rule 6), clean 502 when the laptop is off.
import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import type { Server as TcpServer, Socket } from "node:net";
import {
  parseConfig, forwardableHeaders, upstreamHeaders, modelFromBody, formatCall, createForwarder,
  type ForwarderConfig,
} from "../src/forwarder.ts";

describe("parseConfig", () => {
  it("reads the container env (Dockerfile values)", () => {
    expect(parseConfig({
      FORWARDER_LISTEN: "127.0.0.1:11435",
      OLLAMA_UPSTREAM: "http://surendiras-macbook-air.tail9bf1e8.ts.net:11434",
      SOCKS_PROXY: "socks5h://127.0.0.1:1055",
    })).toEqual({
      listenHost: "127.0.0.1", listenPort: 11435,
      upstreamHost: "surendiras-macbook-air.tail9bf1e8.ts.net", upstreamPort: 11434,
      socks: { host: "127.0.0.1", port: 1055 },
      hostHeader: "127.0.0.1:11434", logHealthPolls: false,
    });
  });
  it("empty SOCKS_PROXY means direct (laptop testing)", () => {
    expect(parseConfig({ SOCKS_PROXY: "" }).socks).toBeNull();
  });
  it("refuses socks5:// (local DNS can't resolve MagicDNS) and non-loopback listen", () => {
    expect(() => parseConfig({ SOCKS_PROXY: "socks5://127.0.0.1:1055" })).toThrow(/socks5h/);
    expect(() => parseConfig({ FORWARDER_LISTEN: "0.0.0.0:11435" })).toThrow(/loopback/);
  });
});

describe("headers", () => {
  const incoming: IncomingHttpHeaders = {
    host: "127.0.0.1:11435", "content-type": "application/json", connection: "keep-alive, x-drop",
    "keep-alive": "timeout=5", "transfer-encoding": "chunked", "x-drop": "1", origin: "http://evil", "x-keep": "1",
  };
  it("drops hop-by-hop headers and headers named in Connection", () => {
    expect(forwardableHeaders(incoming)).toEqual({
      host: "127.0.0.1:11435", "content-type": "application/json", origin: "http://evil", "x-keep": "1",
    });
  });
  it("our x-a3-purpose label is never sent upstream", () => {
    expect(upstreamHeaders({ "x-a3-purpose": "route-classify" }, "127.0.0.1:11434", 0)).not.toHaveProperty("x-a3-purpose");
  });
  it("upstream: Host rewritten, Origin removed, exact content-length", () => {
    expect(upstreamHeaders(incoming, "127.0.0.1:11434", 42)).toEqual({
      host: "127.0.0.1:11434", "content-type": "application/json", "x-keep": "1", "content-length": "42",
    });
  });
});

describe("modelFromBody", () => {
  it.each([
    ['{"model":"gemma4-a3:e2b","messages":[]}', "gemma4-a3:e2b"],
    ["", "none"],
    ["not json", "unparseable"],
    ['{"messages":[]}', "unknown"],
    ['{"model":"has spaces and secrets"}', "unknown"],
    ["null", "unknown"],
  ])("%s → %s", (body, expected) => {
    expect(modelFromBody(Buffer.from(body))).toBe(expected);
  });
});

describe("formatCall", () => {
  it("has exactly the allowlisted fields", () => {
    const line = formatCall(
      { method: "POST", path: "/api/chat", model: "m", status: 200, latencyMs: 12, ttfbMs: 3 },
      new Date("2026-11-13T10:00:00.000Z"),
    );
    expect(JSON.parse(line)).toStrictEqual({
      component: "a3-router", kind: "ollama_call", ts: "2026-11-13T10:00:00.000Z",
      method: "POST", path: "/api/chat", model: "m", status: 200, latencyMs: 12, ttfbMs: 3,
    });
    expect(line.startsWith("{")).toBe(true);
    expect(line).not.toContain("\n");
  });
});

// ---------- end to end: fake Ollama + fake SOCKS5 proxy (real tunnel) + forwarder ----------
let closers: Array<() => void> = [];
afterEach(() => {
  closers.forEach((c) => c());
  closers = [];
});

function listen(server: HttpServer | TcpServer): Promise<number> {
  closers.push(() => {
    (server as HttpServer).closeAllConnections?.();
    server.close();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
}

interface Seen { host?: string; origin?: string; body?: string; closedEarly?: boolean }

// Streams 3 NDJSON lines, 150 ms apart, like /api/chat with stream:true.
async function fakeOllama(seen: Seen): Promise<number> {
  const server = createHttpServer((req, res) => {
    seen.host = req.headers.host;
    seen.origin = req.headers.origin as string | undefined;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.body = Buffer.concat(chunks).toString();
      if (req.headers.host !== "127.0.0.1:11434") {
        res.writeHead(403).end();
        return;
      }
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"models":[]}');
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let i = 0;
      const t = setInterval(() => {
        res.write(JSON.stringify({ i, done: i === 2 }) + "\n");
        if (++i === 3) {
          clearInterval(t);
          res.end();
        }
      }, 150);
      res.on("close", () => {
        clearInterval(t);
        if (!res.writableFinished) seen.closedEarly = true;
      });
    });
  });
  return listen(server);
}

// Minimal real SOCKS5 proxy: resolves "laptop.test" to 127.0.0.1 (like MagicDNS in tailscaled).
async function fakeSocks(targetPort: number, seenHost: { name?: string }): Promise<number> {
  const server = createTcpServer((client: Socket) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(3);
        stage = 1;
        client.write(Buffer.from([5, 0]));
      }
      if (stage === 1 && buf.length >= 5 && buf.length >= 7 + buf[4]!) {
        seenHost.name = buf.subarray(5, 5 + buf[4]!).toString();
        const rest = buf.subarray(7 + buf[4]!);
        stage = 2;
        client.off("data", onData);
        const up = connect({ host: "127.0.0.1", port: targetPort }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          client.pipe(up).pipe(client);
        });
        up.on("error", () => client.destroy());
        client.on("error", () => up.destroy());
      }
    };
    client.on("data", onData);
  });
  return listen(server);
}

async function startForwarder(cfg: Partial<ForwarderConfig>, lines: string[]): Promise<string> {
  const full: ForwarderConfig = {
    listenHost: "127.0.0.1", listenPort: 0, upstreamHost: "laptop.test", upstreamPort: 1,
    socks: null, hostHeader: "127.0.0.1:11434", logHealthPolls: false, ...cfg,
  };
  const port = await listen(createForwarder(full, { writeLine: (l) => lines.push(l) }));
  return `http://127.0.0.1:${port}`;
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("forwarder end to end", () => {
  it("tunnels via SOCKS5h, rewrites Host, streams, and logs one line without prompt text", async () => {
    const seen: Seen = {};
    const socksSeen: { name?: string } = {};
    const ollamaPort = await fakeOllama(seen);
    const socksPort = await fakeSocks(ollamaPort, socksSeen);
    const lines: string[] = [];
    const base = await startForwarder({ upstreamHost: "laptop.test", upstreamPort: 11434, socks: { host: "127.0.0.1", port: socksPort } }, lines);

    const body = JSON.stringify({ model: "gemma4-a3:e2b", messages: [{ role: "user", content: "zebra-secret" }], stream: true });
    const t0 = Date.now();
    const res = await fetch(`${base}/api/chat`, { method: "POST", body, headers: { origin: "http://x" } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now() - t0;
    let text = new TextDecoder().decode(first.value);
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += new TextDecoder().decode(r.value);
    const totalAt = Date.now() - t0;

    expect(socksSeen.name).toBe("laptop.test"); // hostname went to the proxy (socks5h)
    expect(seen.host).toBe("127.0.0.1:11434");
    expect(seen.origin).toBeUndefined();
    expect(seen.body).toBe(body); // body forwarded unchanged
    expect(text.trim().split("\n")).toHaveLength(3);
    expect(firstAt).toBeLessThan(totalAt - 200); // first chunk arrived well before the end: streamed

    await waitFor(() => lines.length > 0);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ component: "a3-router", kind: "ollama_call", method: "POST", path: "/api/chat", model: "gemma4-a3:e2b", status: 200 });
    expect(rec.latencyMs).toBeGreaterThanOrEqual(rec.ttfbMs);
    expect(lines.join("")).not.toContain("zebra");
  });

  it("logs purpose for classifier calls (x-a3-purpose), nothing for chat turns", async () => {
    const ollamaPort = await fakeOllama({});
    const lines: string[] = [];
    const base = await startForwarder({ upstreamHost: "127.0.0.1", upstreamPort: ollamaPort, logHealthPolls: true }, lines);
    await (await fetch(`${base}/api/tags`, { headers: { "x-a3-purpose": "route-classify" } })).text();
    await (await fetch(`${base}/api/tags`, { headers: { "x-a3-purpose": "BAD value!" } })).text();
    await waitFor(() => lines.length >= 2);
    expect(JSON.parse(lines[0]!).purpose).toBe("route-classify");
    expect(JSON.parse(lines[1]!)).not.toHaveProperty("purpose");
  });

  it("laptop off: 502 + one log line with a short code, and the forwarder keeps serving", async () => {
    const tmp = createTcpServer();
    const deadPort = await listen(tmp);
    tmp.close();
    const lines: string[] = [];
    const base = await startForwarder({ upstreamHost: "127.0.0.1", upstreamPort: deadPort }, lines);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/chat`, { method: "POST", body: '{"model":"gemma4-a3:e2b"}' });
      expect(res.status).toBe(502);
    }
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { status: 502, error: "ECONNREFUSED", model: "gemma4-a3:e2b" },
      { status: 502, error: "ECONNREFUSED" },
    ]);
  });

  it("SOCKS refusal (tailnet path down) also becomes 502", async () => {
    const tmp = createTcpServer();
    const deadPort = await listen(tmp);
    tmp.close();
    const lines: string[] = [];
    const base = await startForwarder({ socks: { host: "127.0.0.1", port: deadPort } }, lines);
    const res = await fetch(`${base}/api/tags`);
    expect(res.status).toBe(502);
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: "/api/tags", status: 502, error: "ECONNREFUSED" });
  });

  it("successful health polls (GET /api/tags 200) are not logged unless enabled", async () => {
    const ollamaPort = await fakeOllama({});
    const quiet: string[] = [];
    const loud: string[] = [];
    const a = await startForwarder({ upstreamHost: "127.0.0.1", upstreamPort: ollamaPort }, quiet);
    const b = await startForwarder({ upstreamHost: "127.0.0.1", upstreamPort: ollamaPort, logHealthPolls: true }, loud);
    expect((await fetch(`${a}/api/tags`)).status).toBe(200);
    expect((await fetch(`${b}/api/tags`)).status).toBe(200);
    await waitFor(() => loud.length > 0);
    expect(quiet).toHaveLength(0);
    expect(JSON.parse(loud[0]!)).toMatchObject({ path: "/api/tags", status: 200, model: "none" });
  });

  it("client hang-up mid-stream stops the upstream request and logs client_aborted", async () => {
    const seen: Seen = {};
    const ollamaPort = await fakeOllama(seen);
    const lines: string[] = [];
    const base = await startForwarder({ upstreamHost: "127.0.0.1", upstreamPort: ollamaPort }, lines);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/chat`, { method: "POST", body: '{"model":"gemma4-a3:e2b"}', signal: ac.signal });
    await res.body!.getReader().read(); // first chunk
    ac.abort();
    await waitFor(() => seen.closedEarly === true && lines.length > 0);
    expect(seen.closedEarly).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: 200, error: "client_aborted" });
  });
});
