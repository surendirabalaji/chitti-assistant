// Unit tests for router/src/socks5.ts (Lesson A10). Written by the assistant (student decision Nov 12).
// Byte layouts from RFC 1928. The handshake is tested against a tiny fake SOCKS5 server.
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import {
  buildGreeting, checkGreetingReply, buildConnectRequest,
  connectReplyLength, checkConnectReply, socks5Connect,
} from "../src/socks5.ts";

describe("byte builders and parsers", () => {
  it("greeting offers exactly one method: no auth", () => {
    expect([...buildGreeting()]).toEqual([0x05, 0x01, 0x00]);
  });

  it("greeting reply: accepts 05 00, rejects refusal and wrong version", () => {
    expect(() => checkGreetingReply(Buffer.from([5, 0]))).not.toThrow();
    expect(() => checkGreetingReply(Buffer.from([5, 0xff]))).toThrow("socks_auth_refused");
    expect(() => checkGreetingReply(Buffer.from([4, 0]))).toThrow("socks_bad_version");
  });

  it("connect request sends the hostname (socks5h) and a big-endian port", () => {
    expect([...buildConnectRequest("ab.ts.net", 11434)]).toEqual([
      0x05, 0x01, 0x00, 0x03, 9, ...Buffer.from("ab.ts.net"), 0x2c, 0xaa,
    ]);
  });

  it("rejects empty or >255-byte hosts and bad ports", () => {
    expect(() => buildConnectRequest("", 80)).toThrow("socks_bad_host");
    expect(() => buildConnectRequest("a".repeat(256), 80)).toThrow("socks_bad_host");
    expect(() => buildConnectRequest("h", 0)).toThrow("socks_bad_port");
    expect(() => buildConnectRequest("h", 70000)).toThrow("socks_bad_port");
  });

  it.each([
    ["IPv4", [5, 0, 0, 1, 0], 10],
    ["IPv6", [5, 0, 0, 4, 0], 22],
    ["domain of 7 bytes", [5, 0, 0, 3, 7], 14],
  ])("reply length for %s", (_name, head, len) => {
    expect(connectReplyLength(Buffer.from(head))).toBe(len);
  });

  it("reply length is unknown (null) until 5 bytes arrived; bad ATYP throws", () => {
    expect(connectReplyLength(Buffer.from([5, 0, 0, 1]))).toBeNull();
    expect(() => connectReplyLength(Buffer.from([5, 0, 0, 9, 0]))).toThrow("socks_bad_atyp");
  });

  it("non-zero REP becomes a short code", () => {
    expect(() => checkConnectReply(Buffer.from([5, 0]))).not.toThrow();
    expect(() => checkConnectReply(Buffer.from([5, 4]))).toThrow("socks_rep_4");
  });
});

// Fake proxy: records the CONNECT target, replies with `rep`, then echoes bytes back.
// `split` sends the replies one byte at a time (TCP may fragment).
function fakeProxy(opts: { rep?: number; split?: boolean; silent?: boolean } = {}) {
  const seen: { host?: string; port?: number } = {};
  const server = createServer((s: Socket) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const send = (bytes: number[]) => {
      if (!opts.split) return void s.write(Buffer.from(bytes));
      bytes.forEach((b, i) => setTimeout(() => s.write(Buffer.from([b])), i * 2));
    };
    s.on("data", (d) => {
      if (stage === 2) return void s.write(d); // tunnel: echo
      buf = Buffer.concat([buf, d]);
      if (opts.silent) return;
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(3);
        stage = 1;
        send([5, 0]);
      }
      if (stage === 1 && buf.length >= 5 && buf.length >= 7 + buf[4]!) {
        seen.host = buf.subarray(5, 5 + buf[4]!).toString();
        seen.port = buf.readUInt16BE(5 + buf[4]!);
        stage = 2;
        send([5, opts.rep ?? 0, 0, 1, 100, 64, 0, 1, 0x04, 0x17]);
      }
    });
  });
  return { server, seen };
}

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
}

describe("socks5Connect against a fake proxy", () => {
  it("sends the destination hostname/port and returns a working tunnel", async () => {
    const { server, seen } = fakeProxy();
    const port = await listen(server);
    const sock = await socks5Connect("127.0.0.1", port, "laptop.tail.ts.net", 11434, 1000);
    expect(seen).toEqual({ host: "laptop.tail.ts.net", port: 11434 });
    sock.resume(); // socks5Connect leaves it paused for the caller
    const echoed = new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
    sock.write("ping");
    expect(await echoed).toBe("ping");
    sock.destroy();
  });

  it("handles replies split into single bytes", async () => {
    const { server } = fakeProxy({ split: true });
    const port = await listen(server);
    const sock = await socks5Connect("127.0.0.1", port, "h", 1, 2000);
    sock.destroy();
  });

  it("rejects with socks_rep_<n> when the proxy refuses (e.g. laptop unreachable)", async () => {
    const { server } = fakeProxy({ rep: 4 });
    const port = await listen(server);
    await expect(socks5Connect("127.0.0.1", port, "h", 1, 1000)).rejects.toThrow("socks_rep_4");
  });

  it("rejects with socks_timeout when the proxy never answers", async () => {
    const { server } = fakeProxy({ silent: true });
    const port = await listen(server);
    await expect(socks5Connect("127.0.0.1", port, "h", 1, 100)).rejects.toThrow("socks_timeout");
  });

  it("rejects with the errno code when nothing listens on the proxy port", async () => {
    const tmp = createServer();
    const port = await listen(tmp);
    tmp.close();
    await expect(socks5Connect("127.0.0.1", port, "h", 1, 1000)).rejects.toThrow("ECONNREFUSED");
  });
});

