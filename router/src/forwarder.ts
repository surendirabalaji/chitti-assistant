// Ollama forwarder (Lesson A10): 127.0.0.1:11435 -> Tailscale SOCKS5 (127.0.0.1:1055) -> laptop
// Ollama (tailscale serve tcp:11434). Logs one `ollama_call` JSON line per completed call.
// Written by the assistant at the student's request (Nov 13); explained in the session.
//
// Why it exists (DESIGN.md, STATUS.md M1 finding):
//  - userspace tailscaled gives the container no tailnet route or MagicDNS; SOCKS5 is the way in
//  - Ollama answers 403 to the tailnet Host header, so Host is rewritten to 127.0.0.1:11434
//  - only Ollama traffic uses it (OpenClaw's ollama baseUrl); ChatGPT/Telegram never do
// Privacy: request bodies contain prompts. Only `model` is read from them; nothing else is logged.
// Started by deploy/startup.sh as `node /app/router/src/forwarder.ts` (Node type stripping,
// node: built-ins only).
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { socks5Connect } from "./socks5.ts";

export interface ForwarderConfig {
  listenHost: string;
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  socks: { host: string; port: number } | null; // null = connect directly (laptop tests)
  hostHeader: string; // Host sent upstream; Ollama only accepts loopback hosts
  logHealthPolls: boolean; // log successful GET /api/tags too (health poller: every 10 s)
}

export type LineWriter = (line: string) => void;
export const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line + "\n");
};

type Env = Record<string, string | undefined>;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY_BYTES = 16 * 1024 * 1024; // a 32K-token chat is a few hundred KB
const CONNECT_TIMEOUT_MS = 5000; // tunnel setup only; OpenClaw's own 300 s timeout covers the reply

function port(url: URL, fallback: number): number {
  return url.port === "" ? fallback : Number(url.port);
}

export function parseConfig(env: Env): ForwarderConfig {
  const listen = new URL(`http://${env.FORWARDER_LISTEN ?? "127.0.0.1:11435"}`);
  // Anything that can reach this port can use the laptop's model: never listen beyond loopback.
  if (!LOOPBACK.has(listen.hostname)) throw new Error("FORWARDER_LISTEN must be a loopback address");

  const upstream = new URL(env.OLLAMA_UPSTREAM ?? "http://127.0.0.1:11434");
  if (upstream.protocol !== "http:") throw new Error("OLLAMA_UPSTREAM must be http://");

  let socks: ForwarderConfig["socks"] = null;
  const socksRaw = (env.SOCKS_PROXY ?? "").trim();
  if (socksRaw !== "") {
    const s = new URL(socksRaw);
    // socks5h only: the hostname must be resolved by tailscaled (MagicDNS), not by us.
    if (s.protocol !== "socks5h:") throw new Error("SOCKS_PROXY must be socks5h://host:port");
    socks = { host: s.hostname, port: port(s, 1080) };
  }

  return {
    listenHost: listen.hostname.replace(/^\[|\]$/g, ""),
    listenPort: port(listen, 11435),
    upstreamHost: upstream.hostname,
    upstreamPort: port(upstream, 80),
    socks,
    hostHeader: env.OLLAMA_HOST_HEADER ?? "127.0.0.1:11434",
    logHealthPolls: env.FORWARDER_LOG_HEALTH === "1",
  };
}

// Headers that describe one connection, not the message (RFC 9110 §7.6.1). Never forwarded.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export function forwardableHeaders(incoming: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  // Headers named in `Connection: a, b` are hop-by-hop for this connection too.
  const named = String(incoming.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  hostHeader: string,
  bodyLength: number,
): Record<string, string | string[]> {
  const out = forwardableHeaders(incoming);
  out.host = hostHeader; // M1 finding: tailnet Host -> 403
  delete out.origin; // Ollama also checks Origin; a server-to-server call has none
  delete out["x-a3-purpose"]; // our own label, for the log only
  out["content-length"] = String(bodyLength); // body was buffered, so the length is known
  return out;
}

// Reads only the `model` field. Never throws and never returns other body content.
export function modelFromBody(body: Buffer): string {
  if (body.length === 0) return "none";
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const model = (parsed as { model?: unknown } | null)?.model;
    if (typeof model === "string" && /^[\w.:\/-]{1,100}$/.test(model)) return model;
    return "unknown";
  } catch {
    return "unparseable";
  }
}

export interface CallRecord {
  method: string;
  path: string; // endpoint only, query string removed
  model: string;
  status: number; // upstream status, 502 when unreachable, 499 when the client hung up first
  latencyMs: number; // request received -> response finished
  ttfbMs?: number; // request received -> upstream response headers (time to first byte)
  error?: string; // short code only
  purpose?: string; // e.g. "route-classify" (router v2 classifier) ; absent for chat turns
}

export function formatCall(rec: CallRecord, now: Date): string {
  // Allowlist every field (same style as log.ts): nothing from the body can slip in.
  return JSON.stringify({
    component: "a3-router",
    kind: "ollama_call",
    ts: now.toISOString(),
    method: rec.method,
    path: rec.path,
    model: rec.model,
    status: rec.status,
    latencyMs: rec.latencyMs,
    ...(rec.ttfbMs === undefined ? {} : { ttfbMs: rec.ttfbMs }),
    ...(rec.error === undefined ? {} : { error: rec.error }),
    ...(rec.purpose === undefined ? {} : { purpose: rec.purpose }),
  });
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.message === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.message)) return e.message;
  return "error";
}

// Direct TCP, resolved only once connected so "laptop off" becomes a clean 502.
function directConnect(host: string, portNum: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: portNum });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect_timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function openUpstream(cfg: ForwarderConfig): Promise<Socket> {
  return cfg.socks
    ? socks5Connect(cfg.socks.host, cfg.socks.port, cfg.upstreamHost, cfg.upstreamPort, CONNECT_TIMEOUT_MS)
    : directConnect(cfg.upstreamHost, cfg.upstreamPort, CONNECT_TIMEOUT_MS);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendError(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: `a3-forwarder: ${code}` });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export interface ForwarderDeps {
  writeLine?: LineWriter;
  open?: (cfg: ForwarderConfig) => Promise<Socket>;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ForwarderConfig,
  writeLine: LineWriter,
  open: (cfg: ForwarderConfig) => Promise<Socket>,
): Promise<void> {
  const started = performance.now();
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0]!.slice(0, 100);
  const purposeRaw = req.headers["x-a3-purpose"];
  const purpose = typeof purposeRaw === "string" && /^[a-z-]{1,30}$/.test(purposeRaw) ? purposeRaw : undefined;
  let model = "none";
  let status = 0;
  let ttfbMs: number | undefined;
  let logged = false;

  // Exactly one line per call, whichever way it ends.
  const log = (finalStatus: number, error?: string): void => {
    if (logged) return;
    logged = true;
    const quietHealthPoll = !cfg.logHealthPolls && path === "/api/tags" && finalStatus === 200 && !error;
    if (quietHealthPoll) return;
    try {
      writeLine(formatCall(
        { method, path, model, status: finalStatus, latencyMs: Math.round(performance.now() - started), ttfbMs, error, purpose },
        new Date(),
      ));
    } catch {
      // Logging must never break forwarding.
    }
  };

  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const code = errorCode(err);
    sendError(res, code === "body_too_large" ? 413 : 400, code);
    log(code === "body_too_large" ? 413 : 400, code);
    return;
  }
  model = modelFromBody(body);

  let socket: Socket;
  try {
    socket = await open(cfg);
  } catch (err) {
    const code = errorCode(err);
    sendError(res, 502, code);
    log(502, code);
    return;
  }

  const upstream = request({
    host: cfg.upstreamHost,
    port: cfg.upstreamPort,
    method,
    path: req.url ?? "/",
    headers: upstreamHeaders(req.headers, cfg.hostHeader, body.length),
    // No `agent` option on purpose: `agent: false` makes Node create a fresh default Agent, which
    // ignores createConnection, resolves the tailnet name itself, and bypasses SOCKS (ENOTFOUND).
    // Without an agent, Node uses our socket: one fresh tunnel per call, no pooling.
    createConnection: () => socket, // speak HTTP over our (already tunnelled) socket
  });
  // socks5Connect paused the socket; http has attached its parser by the time 'socket' fires.
  upstream.on("socket", (s: Socket) => s.resume());

  upstream.on("response", (up) => {
    status = up.statusCode ?? 502;
    ttfbMs = Math.round(performance.now() - started);
    res.writeHead(status, forwardableHeaders(up.headers));
    up.pipe(res); // stream NDJSON chunks as they arrive (no buffering)
    up.on("error", () => {
      res.destroy();
      log(status, "upstream_reset");
    });
    up.on("aborted", () => log(status, "upstream_aborted"));
  });

  upstream.on("error", (err) => {
    const code = errorCode(err);
    const midStream = res.headersSent; // read before sendError() sends its own headers
    sendError(res, 502, code);
    log(midStream ? status : 502, code);
  });

  res.on("finish", () => log(status));
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy(); // client gave up (e.g. user cancelled): stop Gemma generating
      log(status === 0 ? 499 : status, "client_aborted");
    }
  });

  upstream.end(body);
}

export function createForwarder(cfg: ForwarderConfig, deps: ForwarderDeps = {}): Server {
  const writeLine = deps.writeLine ?? stdoutWriter;
  const open = deps.open ?? openUpstream;
  return createServer((req, res) => {
    handle(req, res, cfg, writeLine, open).catch((err) => {
      sendError(res, 502, "forwarder_bug");
      try {
        writeLine(JSON.stringify({ component: "a3-router", kind: "forwarder", event: "handler_error", error: errorCode(err), ts: new Date().toISOString() }));
      } catch {
        // ignore
      }
    });
  });
}

if (import.meta.main) {
  const cfg = parseConfig(process.env);
  const server = createForwarder(cfg);
  const ops = (event: string, extra: Record<string, unknown> = {}): void =>
    stdoutWriter(JSON.stringify({ component: "a3-router", kind: "forwarder", event, ts: new Date().toISOString(), ...extra }));

  server.on("error", (err) => {
    ops("fatal", { error: errorCode(err) });
    process.exit(1); // startup.sh notices and the container restarts
  });
  server.listen(cfg.listenPort, cfg.listenHost, () => {
    ops("listening", {
      listen: `${cfg.listenHost}:${cfg.listenPort}`,
      upstream: `${cfg.upstreamHost}:${cfg.upstreamPort}`,
      via: cfg.socks ? "socks5h" : "direct",
    });
  });
  const stop = (): void => {
    ops("stopping");
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
