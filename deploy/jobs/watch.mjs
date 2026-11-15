// Change watch (Nov 15, after the Telegram failure tests). Command job every 5 minutes, no model call.
// 1. Memory poisoning: USER.md and MEMORY.md are loaded into every chat and the agent can rewrite them
//    (only a prompt rule asks it to confirm). Every change is reported to the owner's Telegram with the
//    changed lines, and the previous version is kept on the bucket (watch-history/) for restore.
// 2. Agent-created jobs: the agent can schedule its own jobs (cloud test: a 2 AM reminder). Any job that
//    is not one of ours is reported once, with commands to inspect or remove it.
// Detection, not prevention: a bad line works until the owner reverts it. Prints NO_REPLY when quiet.
// Assistant-written at the student's request (Nov 15).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, clockLA, cleanTitle, logOps, readJson, writeJsonAtomic } from "./lib.mjs";

const OC_STATE = process.env.OPENCLAW_STATE_DIR ?? "/home/agent/.openclaw";
const WORKSPACE = process.env.A3_WORKSPACE ?? join(OC_STATE, "workspace");
const WATCH_FILE = join(STATE_DIR, "watch.json");
const HISTORY_DIR = join(STATE_DIR, "watch-history");
export const WATCHED = ["USER.md", "MEMORY.md"];
export const KNOWN_JOBS = new Set([
  "a3-alerts", "a3-hourly-health", "a3-hourly-cloud", "a3-briefing", "a3-recap", "a3-state-snapshot", "a3-watch",
]);
const SYSTEM_KEY = /^[a-z][a-z0-9-]*:[a-z0-9:-]+$/;
const KEEP_HISTORY = 20; // copies per file
const MAX_SHOWN = 12; // changed lines shown per file

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Pure: lines added and removed (multiset difference, order kept; blank lines ignored). */
export function lineDiff(oldText, newText) {
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const split = (t) => t.split(/\r?\n/).filter((l) => l.trim() !== "");
  const a = split(oldText), b = split(newText);
  const left = count(a), right = count(b);
  const added = [], removed = [];
  for (const l of b) {
    if ((left.get(l) ?? 0) > 0) left.set(l, left.get(l) - 1);
    else added.push(l);
  }
  for (const l of a) {
    if ((right.get(l) ?? 0) > 0) right.set(l, right.get(l) - 1);
    else removed.push(l);
  }
  return { added, removed };
}

/** Pure: Telegram text for one changed file. The lines are untrusted text: one line each, bounded. */
export function formatFileChange(name, diff, at) {
  const shown = [...diff.removed.map((l) => `− ${cleanTitle(l, 160)}`), ...diff.added.map((l) => `+ ${cleanTitle(l, 160)}`)];
  const more = shown.length > MAX_SHOWN ? [`… and ${shown.length - MAX_SHOWN} more`] : [];
  return [
    `🛡️ ${name} changed at ${clockLA(at)} (+${diff.added.length} / −${diff.removed.length} lines):`,
    ...shown.slice(0, MAX_SHOWN),
    ...more,
    `Not you? Tell Chitti to undo it, or restore the saved copy (deploy/LOGIN.md "Restore a watched file").`,
  ].join("\n");
}

/** Pure: jobs that are not ours and were not reported before. */
export function newJobs(listJson, seen, known = KNOWN_JOBS) {
  const jobs = Array.isArray(listJson) ? listJson : Array.isArray(listJson?.jobs) ? listJson.jobs : [];
  return jobs
    // OpenClaw's own jobs carry a namespaced declaration key ("heartbeat:main",
    // "memory-core:memory-dreaming-promotion"; seen in a local gateway Nov 15). Agent-created jobs have none.
    .filter((j) => j && typeof j.id === "string" && seen[j.id] === undefined)
    .filter((j) => !known.has(j.declarationKey) && !known.has(j.name) && !SYSTEM_KEY.test(j.declarationKey ?? ""))
    .map((j) => ({
      id: cleanTitle(j.id, 80),
      name: cleanTitle(j.name ?? j.displayName, 60),
      schedule: cleanTitle(scheduleText(j.schedule), 60),
      enabled: j.enabled !== false,
    }));
}

function scheduleText(s) {
  if (typeof s === "string") return s;
  if (!s || typeof s !== "object") return "schedule unknown";
  return [s.kind, s.expr ?? s.cron ?? s.at ?? s.everyMs ?? "", s.tz ?? ""].filter((x) => x !== undefined && x !== "").join(" ");
}

export function formatJobs(jobs) {
  return [
    `🛡️ New scheduled job${jobs.length > 1 ? "s" : ""} not created by the setup:`,
    ...jobs.map((j) => `• "${j.name}" (${j.schedule}, ${j.enabled ? "enabled" : "disabled"}) id ${j.id}`),
    "If you didn't ask for it, remove it over SSH: openclaw automations rm <id>",
  ].join("\n");
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null; // missing file
  }
}

function saveHistory(name, text, now) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  writeFileSync(join(HISTORY_DIR, `${name}.${stamp}.prev`), text);
  const mine = readdirSync(HISTORY_DIR).filter((f) => f.startsWith(`${name}.`)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_HISTORY))) rmSync(join(HISTORY_DIR, old), { force: true });
}

function listJobs() {
  const env = { ...process.env };
  if (!env.OPENCLAW_GATEWAY_TOKEN) {
    const tokenFile = join(OC_STATE, ".gateway-token");
    if (existsSync(tokenFile)) env.OPENCLAW_GATEWAY_TOKEN = readFileSync(tokenFile, "utf8").trim();
  }
  const out = execFileSync("openclaw", ["cron", "list", "--all", "--json", "--timeout", "60000"], {
    encoding: "utf8", timeout: 75000, stdio: ["ignore", "pipe", "pipe"], env,
  });
  return JSON.parse(out);
}

if (import.meta.main) {
  const now = new Date();
  const state = readJson(WATCH_FILE, {});
  const files = state.files ?? {};
  const seenJobs = state.jobs ?? {};
  const messages = [];

  for (const name of WATCHED) {
    const text = readText(join(WORKSPACE, name)) ?? "";
    const prev = files[name];
    const hash = sha256(text);
    if (!prev) {
      files[name] = { sha256: hash, text };
      logOps("watch-baseline", { file: name, bytes: text.length });
    } else if (prev.sha256 !== hash) {
      const diff = lineDiff(prev.text ?? "", text);
      try {
        saveHistory(name, prev.text ?? "", now);
      } catch {
        logOps("watch-history-failed", { file: name });
      }
      files[name] = { sha256: hash, text };
      logOps("watch-file-changed", { file: name, added: diff.added.length, removed: diff.removed.length });
      messages.push(formatFileChange(name, diff, now));
    }
  }

  try {
    const fresh = newJobs(listJobs(), seenJobs);
    for (const j of fresh) seenJobs[j.id] = now.getTime();
    if (fresh.length > 0) {
      logOps("watch-new-jobs", { count: fresh.length });
      messages.push(formatJobs(fresh));
    }
  } catch (err) {
    logOps("watch-jobs-failed", { reason: err?.code === "ETIMEDOUT" ? "timeout" : "cli-error" });
  }

  writeJsonAtomic(WATCH_FILE, { files, jobs: seenJobs }); // mark first: a repeated alert is worse than a lost one
  if (messages.length === 0) {
    logOps("watch-check", { changed: 0 });
    process.stdout.write("NO_REPLY\n");
  } else {
    process.stdout.write(messages.join("\n\n") + "\n");
  }
}
