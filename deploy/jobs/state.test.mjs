// Tests for snapshot/restore helpers (assistant-written). Run: node --test deploy/jobs/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authFingerprint, isDue, isSnapshotName, snapshotName, toPrune } from "./snapshot.mjs";
import { candidates, snapshotTime, stateAssetPath } from "./restore.mjs";

const T0 = Date.parse("2026-11-15T02:15:00.123Z");

test("snapshot names sort by time and round-trip to a Date", () => {
  const n = snapshotName(new Date(T0));
  assert.equal(n, "snap-20261115T021500123Z.tar.gz");
  assert.ok(isSnapshotName(n));
  assert.equal(snapshotTime(n).getTime(), T0);
  assert.ok(snapshotName(new Date(T0 + 60000)) > n);
  assert.equal(isSnapshotName(".partial-" + n), false);
  assert.equal(snapshotTime("junk"), null);
});

test("isDue: first, forced, interval, auth change; not due within 5 min", () => {
  assert.equal(isDue(null, T0, "a").reason, "first");
  assert.equal(isDue({ at: T0, authFp: "a" }, T0 + 60000, "a").due, false);
  assert.equal(isDue({ at: T0, authFp: "a" }, T0 + 300000, "a").reason, "interval");
  assert.equal(isDue({ at: T0, authFp: "a" }, T0 + 60000, "b").reason, "auth-changed");
  assert.equal(isDue({ at: T0, authFp: "a" }, T0 + 60000, null).due, false); // unknown fingerprint never triggers
  assert.equal(isDue({ at: T0, authFp: "a" }, T0, "a", { force: true }).reason, "forced");
});

test("toPrune keeps the newest 6 snapshots and ignores other files", () => {
  const names = Array.from({ length: 8 }, (_, i) => snapshotName(new Date(T0 + i * 300000)));
  const pruned = toPrune([...names, ".partial-x", "notes.txt"]);
  assert.deepEqual(pruned, [names[1], names[0]]);
  assert.deepEqual(toPrune(names.slice(0, 3)), []);
});

test("restore candidates: newest first, at most 3, snapshots only", () => {
  const names = Array.from({ length: 5 }, (_, i) => snapshotName(new Date(T0 + i * 300000)));
  assert.deepEqual(candidates([...names, ".partial-y"]), [names[4], names[3], names[2]]);
  assert.deepEqual(candidates([]), []);
});

test("stateAssetPath reads the state asset from the manifest; rejects traversal", () => {
  const m = { assets: [{ kind: "workspace", archivePath: "r/payload/w" }, { kind: "state", archivePath: "r/payload/posix/home/agent/.openclaw" }] };
  assert.equal(stateAssetPath(m), "r/payload/posix/home/agent/.openclaw");
  assert.equal(stateAssetPath({ assets: [{ kind: "state", archivePath: "../etc" }] }), null);
  assert.equal(stateAssetPath({}), null);
});

test("authFingerprint: changes when login rows change, ignores authProfiles.state, 'none' without rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "a3-fp-"));
  mkdirSync(join(dir, "state"));
  mkdirSync(join(dir, "agents", "main", "agent"), { recursive: true });
  const shared = new DatabaseSync(join(dir, "state", "openclaw.sqlite"));
  shared.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)");
  const agent = new DatabaseSync(join(dir, "agents", "main", "agent", "openclaw-agent.sqlite"));
  agent.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)");
  assert.equal(authFingerprint(dir), "none");
  shared.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run("authProfiles.store", '{"t":"r1"}');
  const a = authFingerprint(dir);
  shared.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run("authProfiles.state", '{"usage":1}');
  assert.equal(authFingerprint(dir), a);
  shared.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run('{"t":"r2"}', "authProfiles.store");
  assert.notEqual(authFingerprint(dir), a);
  shared.close();
  agent.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(authFingerprint(join(dir, "missing")), "none");
});
