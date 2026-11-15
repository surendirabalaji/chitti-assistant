// a3-activity (M6): today's activity as counts, for the 6 PM recap. Installed root-owned at
// /usr/local/bin/a3-activity and allowlisted (args: optional --date YYYY-MM-DD), so the recap job can
// run it unattended. Reads two metadata-only logs on local disk: the router mirror
// (/tmp/a3-router.log, plugin config logMirrorFile) and the ops log (/tmp/a3-ops.log). No message
// text exists in either file, so none can be printed. Both live in /tmp: counts cover the time since
// the container started; the output says so when the logs begin after midnight.
// Assistant-written at the student's request (Nov 14).
import { readFileSync } from "node:fs";
import { OPS_LOG, TZ } from "./lib.mjs";

const ROUTER_LOG = process.env.A3_ROUTER_LOG ?? "/tmp/a3-router.log";

// "2026-11-16" for an instant, in Pacific time.
export function dayLA(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip partial lines
    }
  }
  return out;
}

/** Pure: count one Pacific day's records. */
export function summarize(records, day) {
  const s = {
    day,
    firstTs: null,
    results: 0,
    byTarget: { local: 0, cloud: 0, held: 0, none: 0 },
    failed: 0,
    scheduled: 0,
    alertsSent: 0,
    hourly: { up: 0, down: 0 },
  };
  for (const r of records) {
    if (!r || typeof r.ts !== "string") continue;
    const t = new Date(r.ts);
    if (Number.isNaN(t.getTime())) continue;
    if (s.firstTs === null || t < s.firstTs) s.firstTs = t; // earliest line overall = log coverage start
    if (dayLA(t) !== day) continue;
    if (r.component === "a3-router" && r.kind === "route_result") {
      s.results++;
      if (r.target in s.byTarget) s.byTarget[r.target]++;
      if (r.ok === false && r.target !== "held" && r.target !== "none") s.failed++;
    } else if (r.component === "a3-router" && r.kind === "route_decision" && Array.isArray(r.signals) && r.signals.includes("trigger:cron")) {
      s.scheduled++;
    } else if (r.component === "a3-ops" && r.event === "alert-sent") {
      s.alertsSent += typeof r.count === "number" ? r.count : 1;
    } else if (r.component === "a3-ops" && r.event === "hourly") {
      if (r.local === "up") s.hourly.up++;
      else s.hourly.down++;
    }
  }
  return s;
}

export function format(s) {
  const lines = [
    `Activity ${s.day} (Pacific):`,
    `requests answered: ${s.results} (local Gemma ${s.byTarget.local}, cloud ChatGPT ${s.byTarget.cloud}, held ${s.byTarget.held}, unavailable ${s.byTarget.none}); failed ${s.failed}`,
    `scheduled job turns: ${s.scheduled}`,
    `meeting alerts sent: ${s.alertsSent}`,
    `hourly laptop checks: ${s.hourly.up} up, ${s.hourly.down} down`,
  ];
  if (s.firstTs && dayLA(s.firstTs) === s.day) {
    const hhmm = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(s.firstTs);
    lines.push(`(logs start at ${hhmm}, when the agent last started; earlier activity today is not counted)`);
  } else if (!s.firstTs) {
    lines.push("(no activity logs found)");
  }
  return lines.join("\n");
}

function readOr(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let day = dayLA(new Date());
  if (args.length === 2 && args[0] === "--date" && /^\d{4}-\d{2}-\d{2}$/.test(args[1])) day = args[1];
  else if (args.length !== 0) {
    process.stderr.write("usage: a3-activity [--date YYYY-MM-DD]\n");
    process.exit(2);
  }
  const records = [...parseLines(readOr(ROUTER_LOG)), ...parseLines(readOr(OPS_LOG))];
  process.stdout.write(format(summarize(records, day)) + "\n");
}
