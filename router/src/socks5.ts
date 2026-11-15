// SOCKS5 CONNECT client (RFC 1928): no authentication, domain-name addressing ("socks5h").
// Lesson A10. Written by the assistant at the student's request (Nov 13); explained in the session.
// Only node: built-ins: the image copies router/src without node_modules and runs it with Node's
// own type stripping (erasable syntax, explicit .ts imports).
import { connect } from "node:net";
import type { Socket } from "node:net";

const VERSION = 0x05;
const NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

// Step 1 (client -> proxy): "version 5, I offer 1 auth method: none".
export function buildGreeting(): Buffer {
  return Buffer.from([VERSION, 1, NO_AUTH]);
}

// Step 2 (proxy -> client), exactly 2 bytes: version, chosen method. Throws a short code on refusal.
export function checkGreetingReply(buf: Buffer): void {
  if (buf.length < 2 || buf[0] !== VERSION) throw new Error("socks_bad_version");
  if (buf[1] !== NO_AUTH) throw new Error("socks_auth_refused");
}

// Step 3 (client -> proxy): CONNECT to host:port, host sent as a name so the proxy resolves it.
export function buildConnectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, "utf8");
  if (name.length === 0 || name.length > 255) throw new Error("socks_bad_host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("socks_bad_port");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, name.length]),
    name,
    portBytes,
  ]);
}

// Step 4 (proxy -> client): VER REP RSV ATYP ADDR PORT. Its length depends on ATYP.
// Returns the full length, or null while too few bytes have arrived to know it.
export function connectReplyLength(buf: Buffer): number | null {
  if (buf.length < 5) return null; // need ATYP (byte 3) and, for domains, the length byte (4)
  switch (buf[3]) {
    case ATYP_IPV4:
      return 4 + 4 + 2;
    case ATYP_IPV6:
      return 4 + 16 + 2;
    case ATYP_DOMAIN:
      return 4 + 1 + buf[4]! + 2;
    default:
      throw new Error("socks_bad_atyp");
  }
}

// REP 0 = success; anything else (e.g. 4 host unreachable, 5 refused) becomes "socks_rep_<n>".
export function checkConnectReply(buf: Buffer): void {
  if (buf[0] !== VERSION) throw new Error("socks_bad_version");
  if (buf[1] !== 0x00) throw new Error(`socks_rep_${buf[1]}`);
}

// Opens TCP to the proxy, runs the handshake, and resolves with the same socket, which is now a
// raw tunnel to destHost:destPort. Rejects with an Error whose message is a short code.
export function socks5Connect(
  proxyHost: string,
  proxyPort: number,
  destHost: string,
  destPort: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxyHost, port: proxyPort });
    let pending = Buffer.alloc(0); // TCP is a stream: bytes may arrive split or merged
    let stage: "greeting" | "connect" = "greeting";
    let settled = false;

    const fail = (code: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(code));
    };
    const timer = setTimeout(() => fail("socks_timeout"), timeoutMs);
    const onError = (err: NodeJS.ErrnoException): void => fail(err.code ?? "socks_error");
    const onClose = (): void => fail("socks_closed");
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    function onData(chunk: Buffer): void {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (stage === "greeting") {
          if (pending.length < 2) return;
          checkGreetingReply(pending);
          pending = pending.subarray(2);
          stage = "connect";
          socket.write(buildConnectRequest(destHost, destPort));
        }
        const need = connectReplyLength(pending);
        if (need === null || pending.length < need) return;
        checkConnectReply(pending);
        if (pending.length > need) {
          // The destination spoke first (HTTP servers don't); give the bytes back to the stream.
          socket.unshift(pending.subarray(need));
        }
        settled = true;
        cleanup(); // remove our listener, or it would swallow the HTTP response
        // Removing the listener does not stop a flowing stream: pause so no byte is emitted to
        // nobody before the caller attaches its own reader (the caller must resume()).
        socket.pause();
        resolve(socket);
      } catch (err) {
        fail(err instanceof Error ? err.message : "socks_error");
      }
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", () => socket.write(buildGreeting()));
  });
}
