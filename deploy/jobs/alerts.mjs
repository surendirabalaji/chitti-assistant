// Proactive alerts (M6): every 5 minutes, warn about calendar events starting in 15-30 minutes.
// Command job (no model call): runs in the OpenClaw scheduler, prints the alert text (delivered to the
// owner's Telegram by the job's announce route) or NO_REPLY (suppressed). Dedupe by event id + start
// time in a state file on the bucket, so an alert is sent once even across container restarts.
// Assistant-written at the student's request (Nov 14).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { STATE_DIR, clockLA, cleanTitle, logOps, readJson, writeJsonAtomic } from "./lib.mjs";

const MIN = 60 * 1000;
export const WINDOW = { fromMin: 15, toMin: 30 };
const KEEP_MS = 2 * 24 * 60 * MIN; // forget sent keys after 2 days
const SENT_FILE = join(STATE_DIR, "alerts-sent.json");

/**
 * Pure: which events need an alert now?
 * @param {unknown} raw gog JSON ({ events: [...] } or an array)
 * @param {number} nowMs
 * @param {Record<string, number>} sent key -> sentAt ms
 * @returns {{ key: string, title: string, start: Date, minutes: number }[]}
 */
export function dueAlerts(raw, nowMs, sent, window = WINDOW) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : Array.isArray(raw?.items) ? raw.items : [];
  const due = [];
  for (const ev of list) {
    if (!ev || typeof ev !== "object" || ev.status === "cancelled") continue;
    const startIso = ev.start?.dateTime; // all-day events ({ date }) get no alert
    if (typeof startIso !== "string") continue;
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) continue;
    const minutes = (start.getTime() - nowMs) / MIN;
    if (minutes < window.fromMin || minutes > window.toMin) continue;
    const key = `${typeof ev.id === "string" ? ev.id : cleanTitle(ev.summary)}@${start.toISOString()}`;
    if (sent[key] !== undefined) continue; // already alerted (a moved event gets a new key)
    due.push({ key, title: cleanTitle(ev.summary), start, minutes: Math.round(minutes) });
  }
  return due.sort((a, b) => a.start - b.start);
}

export function formatAlerts(due) {
  return due.map((d) => `⏰ In ${d.minutes} min: ${d.title} at ${clockLA(d.start)}`).join("\n");
}

export function pruneSent(sent, nowMs) {
  return Object.fromEntries(Object.entries(sent).filter(([, at]) => typeof at === "number" && nowMs - at < KEEP_MS));
}

function fetchEvents(now) {
  const from = new Date(now.getTime() + (WINDOW.fromMin - 1) * MIN).toISOString();
  const to = new Date(now.getTime() + (WINDOW.toMin + 1) * MIN).toISOString();
  const out = execFileSync("/usr/local/bin/gog", ["calendar", "events", "primary", "--from", from, "--to", to, "--json"], {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

if (import.meta.main) {
  const now = new Date();
  let raw;
  try {
    raw = fetchEvents(now);
  } catch (err) {
    logOps("alert-check-failed", { reason: err?.code === "ETIMEDOUT" ? "timeout" : "gog-error" });
    process.stderr.write("alerts: calendar read failed\n");
    process.exit(1); // job error -> OpenClaw failure alert after repeated failures
  }
  const sent = pruneSent(readJson(SENT_FILE, {}), now.getTime());
  const due = dueAlerts(raw, now.getTime(), sent);
  if (due.length === 0) {
    writeJsonAtomic(SENT_FILE, sent);
    logOps("alert-check", { due: 0 });
    process.stdout.write("NO_REPLY\n");
  } else {
    for (const d of due) sent[d.key] = now.getTime();
    writeJsonAtomic(SENT_FILE, sent); // mark first: a duplicate alert is worse than a rare lost one
    logOps("alert-sent", { count: due.length, minutes: due.map((d) => d.minutes) });
    process.stdout.write(formatAlerts(due) + "\n");
  }
}
