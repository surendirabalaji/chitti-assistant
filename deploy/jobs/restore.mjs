// Restore OpenClaw state from the newest good bucket snapshot (M7). Run by startup.sh at boot, before
// anything else touches $OPENCLAW_STATE_DIR (config step, gateway). Uses OpenClaw's own
// `openclaw backup restore` (verifies the archive and its SQLite databases, extracts into an empty
// staging dir, never in place; docs cli/backup.md), then moves the state folder into place.
// Falls back to older snapshots. If snapshots exist but none restores, it writes a marker that blocks
// new snapshots (snapshot.mjs), so fresh empty state can't push the good ones out of retention.
// Never exits non-zero: the agent should still boot (ChatGPT sign-in then needed again).
// Assistant-written at the student's request (Nov 14).
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logOps } from "./lib.mjs";
import { RESTORE_FAILED_MARKER, SNAP_DIR, isSnapshotName } from "./snapshot.mjs";

const OC_STATE = process.env.OPENCLAW_STATE_DIR ?? "/home/agent/.openclaw";
const MAX_TRIES = 3;

/** Pure: snapshot names to try, newest first. */
export function candidates(names, max = MAX_TRIES) {
  return names.filter(isSnapshotName).sort().reverse().slice(0, max);
}

/** Pure: "snap-20261115T021500123Z.tar.gz" -> Date (or null). */
export function snapshotTime(name) {
  const m = /^snap-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`) : null;
}

/** Pure: the extracted folder that holds the state asset, from the archive manifest. */
export function stateAssetPath(manifest) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const a = assets.find((x) => x?.kind === "state" && typeof x.archivePath === "string");
  if (!a || a.archivePath.includes("..")) return null;
  return a.archivePath;
}

function restoreOne(name, work) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "cli-state"), { recursive: true });
  const archive = join(work, "archive.tar.gz");
  copyFileSync(join(SNAP_DIR, name), archive); // read from the bucket once, restore from local disk
  const target = join(work, "out");
  // The CLI gets a throwaway state dir, so it can't create anything in the live one.
  const env = { ...process.env, OPENCLAW_STATE_DIR: join(work, "cli-state"), OPENCLAW_CONFIG_PATH: join(work, "cli-state", "openclaw.json") };
  const out = execFileSync("openclaw", ["backup", "restore", archive, "--target", target, "--json"], { encoding: "utf8", env, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  const res = JSON.parse(out);
  if (res.ok !== true) throw new Error("restore not ok");
  const manifest = JSON.parse(readFileSync(join(target, res.archiveRoot, "manifest.json"), "utf8"));
  const rel = stateAssetPath(manifest);
  if (!rel) throw new Error("no state asset in manifest");
  const src = join(target, rel);
  if (!existsSync(join(src, "state", "openclaw.sqlite"))) throw new Error("state db missing in archive");
  return { src, createdAt: res.createdAt, sqliteVerified: res.sqliteInventoryVerified === true };
}

function moveInto(src, dest) {
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(src)) {
    const to = join(dest, entry);
    rmSync(to, { recursive: true, force: true });
    try {
      renameSync(join(src, entry), to);
    } catch {
      cpSync(join(src, entry), to, { recursive: true });
    }
    n++;
  }
  return n;
}

if (import.meta.main) {
  if (existsSync(join(OC_STATE, "state", "openclaw.sqlite"))) {
    logOps("state-restore-skipped", { reason: "local-state-present" });
    process.exit(0);
  }
  let names = [];
  try {
    names = readdirSync(SNAP_DIR);
  } catch {
    // no snapshot folder yet
  }
  const list = candidates(names);
  if (list.length === 0) {
    logOps("state-restore-none", { reason: "no snapshots in bucket (first boot)" });
    process.exit(0);
  }
  const work = "/tmp/a3-restore";
  for (const name of list) {
    try {
      const r = restoreOne(name, work);
      const entries = moveInto(r.src, OC_STATE);
      const t = snapshotTime(name);
      logOps("state-restored", { snapshot: name, createdAt: r.createdAt, ageSec: t ? Math.round((Date.now() - t.getTime()) / 1000) : null, entries, sqliteVerified: r.sqliteVerified });
      rmSync(work, { recursive: true, force: true });
      process.exit(0);
    } catch (err) {
      logOps("state-restore-attempt-failed", { snapshot: name, error: String(err?.message ?? "error").slice(0, 120).replace(/[^\w .:-]/g, "") });
    }
  }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(RESTORE_FAILED_MARKER, new Date().toISOString());
  logOps("state-restore-failed", { tried: list.length, snapshotsBlocked: true });
}
