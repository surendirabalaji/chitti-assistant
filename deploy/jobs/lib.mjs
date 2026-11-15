// Shared helpers for the A3 scheduled command jobs (M6). Assistant-written at the student's request
// (Nov 14, "you write the code and explain it"). node: built-ins only.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TZ = "America/Los_Angeles";
// startup.sh tails this file to container stdout, so these lines reach Cloud Logging.
export const OPS_LOG = process.env.A3_OPS_LOG ?? "/tmp/a3-ops.log";
// Durable job state lives on the bucket mount, so it survives container restarts.
export const STATE_DIR = process.env.A3_JOB_STATE_DIR ?? "/mnt/state/a3";

// One JSON line, metadata only (never event titles, email text or message text).
export function opsLine(event, fields = {}, now = new Date()) {
  return JSON.stringify({ component: "a3-ops", kind: "ops", event, ts: now.toISOString(), ...fields });
}

export function logOps(event, fields = {}) {
  try {
    appendFileSync(OPS_LOG, opsLine(event, fields) + "\n");
  } catch {
    // evidence logging must never break the job
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write to a temp file, then rename: a crash mid-write never leaves a half-written state file.
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

// "3:30 PM" in Pacific time.
export function clockLA(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(date);
}

// Calendar text is untrusted: one line, no control characters, bounded length.
export function cleanTitle(value, max = 100) {
  const s = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!s) return "(no title)";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
