// Tests for the hourly evidence job (assistant-written). Run: node --test deploy/jobs/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkLocal, summary, uptimeSec } from "./hourly.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("up: 200 with models -> local up, model count, no error", async () => {
  const srv = await serve((req, res) => {
    assert.equal(req.url, "/api/tags");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "gemma4-a3:e2b" }] }));
  });
  const r = await checkLocal(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.equal(r.local, "up");
  assert.equal(r.status, 200);
  assert.equal(r.models, 1);
  assert.equal(r.error, undefined);
});

test("forwarder 502 (laptop unreachable) -> down with http code", async () => {
  const srv = await serve((req, res) => {
    res.statusCode = 502;
    res.end("bad gateway");
  });
  const r = await checkLocal(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.deepEqual([r.local, r.status, r.error], ["down", 502, "http-502"]);
});

test("nothing listening -> down/unreachable; hang -> down/timeout; never throws", async () => {
  const dead = await serve(() => {});
  const port = dead.address().port;
  dead.close();
  assert.equal((await checkLocal(`http://127.0.0.1:${port}`)).error, "unreachable");

  const hang = await serve(() => {}); // never responds
  const r = await checkLocal(`http://127.0.0.1:${hang.address().port}`, { timeoutMs: 200 });
  hang.closeAllConnections();
  hang.close();
  assert.deepEqual([r.local, r.error], ["down", "timeout"]);
});

test("uptime from A3_BOOT_TS; unknown -> null; summary text", () => {
  assert.equal(uptimeSec("1000", 4600_000), 3600);
  assert.equal(uptimeSec(undefined), null);
  assert.equal(uptimeSec("junk"), null);
  assert.equal(summary({ local: "up", latencyMs: 42 }, 5400), "hourly: local up (42 ms), uptime 1.5 h");
  assert.equal(summary({ local: "down", error: "timeout" }, null), "hourly: local down (timeout), uptime ? h");
});
