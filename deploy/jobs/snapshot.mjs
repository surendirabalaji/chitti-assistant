// State snapshots to the bucket (M7). Run every minute as an OpenClaw command job (install-jobs.sh) and
// once more by startup.sh on SIGTERM. A snapshot is only taken when it is due: 5 minutes since the last
// one, or the ChatGPT login rows changed (OAuth refresh tokens are single-use, so a refreshed token must
// reach the bucket quickly or a restart would restore a dead one).
// The archive itself is OpenClaw's own `openclaw backup create --verify` (consistent SQLite snapshots +
// manifest, docs cli/backup.md); this script only schedules it, uploads it and prunes old ones.
// The archive contains the ChatGPT login and chat history: it goes only to the private bucket.
// Assistant-written at the student's request (Nov 14).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATE_DIR as JOB_STATE_DIR, logOps, readJson, writeJsonAtomic } from "./lib.mjs";

export const SNAP_DIR = process.env.A3_SNAP_DIR ?? join(JOB_STATE_DIR, "snapshots");
const OC_STATE = process.env.OPENCLAW_STATE_DIR ?? "/home/agent/.openclaw";
const LAST_FILE = process.env.A3_SNAP_LAST ?? "/tmp/a3-snapshot-last.json"; // local disk: per boot
export const RESTORE_FAILED_MARKER = "/tmp/a3-restore-failed";
export const INTERVAL_MS = 5 * 60 * 1000;
export const KEEP = 6;
const NAME_RE = /^snap-\d{8}T\d{6}\d{3}Z\.tar\.gz$/;

// snap-20261115T021500123Z.tar.gz: sorts by time as a string.
export function snapshotName(date) {
  return `snap-${date.toISOString().replace(/[-:.]/g, "")}.tar.gz`;
}

export function isSnapshotName(name) {
  return NAME_RE.test(name);
}

/** Pure: is a snapshot due? */
export function isDue(last, nowMs, authFp, { force = false, intervalMs = INTERVAL_MS } = {}) {
  if (force) return { due: true, reason: "forced" };
  if (!last || typeof last.at !== "number") return { due: true, reason: "first" };
  if (authFp !== null && authFp !== last.authFp) return { due: true, reason: "auth-changed" };
  if (nowMs - last.at >= intervalMs) return { due: true, reason: "interval" };
  return { due: false, reason: "not-due" };
}

/** Pure: snapshot names to delete (keep the newest `keep`). */
export function toPrune(names, keep = KEEP) {
  return names.filter(isSnapshotName).sort().reverse().slice(keep);
}

// Hash of the login rows only (never logged, never written to the bucket; kept in /tmp to detect change).
// Shared login: state/openclaw.sqlite config_machine_state keys authProfiles.store + auth.sharedStore;
// agent overrides: agents/main/agent/openclaw-agent.sqlite auth_profile_store (installed 2026.10.9 schema).
// authProfiles.state is left out on purpose: it holds usage/cooldown data that changes on every call.
export function authFingerprint(stateDir = OC_STATE) {
  const h = createHash("sha256");
  let found = false;
  const read = (file, sql) => {
    if (!existsSync(file)) return;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of db.prepare(sql).all()) {
        h.update(JSON.stringify(row));
        found = true;
      }
    } finally {
      db.close();
    }
  };
  try {
    read(join(stateDir, "state", "openclaw.sqlite"),
      "SELECT state_key, value_json FROM config_machine_state WHERE state_key IN ('authProfiles.store','auth.sharedStore') ORDER BY state_key");
    read(join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      "SELECT store_key, store_json FROM auth_profile_store ORDER BY store_key");
  } catch {
    return null; // schema/lock problem: fall back to the 5-minute interval
  }
  return found ? h.digest("hex") : "none";
}

export function takeSnapshot({ reason, verify = true, timeoutMs = 110000 } = {}) {
  const t0 = Date.now();
  const work = mkdtempSync("/tmp/a3-snap-");
  try {
    const args = ["-n", "10", "openclaw", "backup", "create", "--output", work, "--json", ...(verify ? ["--verify"] : [])];
    const out = execFileSync("nice", args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    const res = JSON.parse(out);
    if (typeof res.archivePath !== "string") throw new Error("no archivePath");
    const name = snapshotName(new Date());
    const partial = join(SNAP_DIR, `.partial-${name}`);
    execFileSync("mkdir", ["-p", SNAP_DIR]);
    copyFileSync(res.archivePath, partial); // the bucket object is complete when the copy closes
    renameSync(partial, join(SNAP_DIR, name)); // restore only considers snap-*, never .partial-*
    const bytes = statSync(join(SNAP_DIR, name)).size;
    let pruned = 0;
    const names = readdirSync(SNAP_DIR);
    for (const old of toPrune(names)) {
      try {
        unlinkSync(join(SNAP_DIR, old));
        pruned++;
      } catch {
        // a concurrent run may have pruned it
      }
    }
    for (const n of names) {
      // leftovers from a run killed mid-copy
      if (n.startsWith(".partial-")) {
        try {
          if (Date.now() - statSync(join(SNAP_DIR, n)).mtimeMs > 3600000) unlinkSync(join(SNAP_DIR, n));
        } catch {}
      }
    }
    return { ok: true, name, bytes, verified: res.verified === true, pruned, ms: Date.now() - t0, reason };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const verify = !args.includes("--no-verify");
  const reasonArg = args.includes("--reason") ? args[args.indexOf("--reason") + 1] : undefined;
  if (existsSync(RESTORE_FAILED_MARKER)) {
    // Boot could not restore although snapshots exist: don't let fresh empty state push them out.
    logOps("snapshot-blocked", { reason: "restore-failed-at-boot" });
    process.stderr.write("snapshot blocked: restore failed at boot (see deploy/LOGIN.md)\n");
    process.exit(1);
  }
  const fp = authFingerprint();
  const last = readJson(LAST_FILE, null);
  const d = isDue(last, Date.now(), fp, { force });
  if (!d.due) process.exit(0); // quiet: no output, no ops line (runs every minute)
  // One scheduled/manual run at a time (mkdir is atomic). The forced shutdown snapshot skips the lock:
  // it must not wait, and a parallel run only means one extra archive.
  const LOCK = "/tmp/a3-snapshot.lock";
  if (!force) {
    try {
      mkdirSync(LOCK);
    } catch {
      let stale = false;
      try {
        stale = Date.now() - statSync(LOCK).mtimeMs > 180000;
      } catch {}
      if (!stale) process.exit(0); // another run is in progress
    }
    process.on("exit", () => rmSync(LOCK, { recursive: true, force: true }));
  }
  try {
    const r = takeSnapshot({ reason: reasonArg ?? d.reason, verify });
    writeJsonAtomic(LAST_FILE, { at: Date.now(), authFp: fp });
    logOps("snapshot", { reason: r.reason, name: r.name, bytes: r.bytes, verified: r.verified, pruned: r.pruned, ms: r.ms });
    process.stdout.write(`snapshot ${r.name} (${r.reason}, ${r.bytes} bytes)\n`);
  } catch (err) {
    logOps("snapshot-failed", { reason: reasonArg ?? d.reason, error: err?.code === "ETIMEDOUT" ? "timeout" : String(err?.message ?? "error").slice(0, 120).replace(/[^\w .:-]/g, "") });
    process.stderr.write("snapshot failed\n");
    process.exit(1);
  }
}
