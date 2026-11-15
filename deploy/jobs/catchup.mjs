// Missed-job catch-up at boot (M6). The template sets cron.skipMissedJobs: true, so OpenClaw never
// replays old slots by itself (no 6 PM recap at 2 AM after a restart). Instead install-jobs.sh pipes
// `openclaw cron list --all --json` into this script, which prints the ids of daily jobs that
// missed today's slot and are still inside their catch-up window (DESIGN: "briefing not delivered
// and before noon -> run once"). install-jobs.sh then runs each one with `openclaw cron run <id>`.
// Assistant-written at the student's request (Nov 14).
import { TZ } from "./lib.mjs";

// declarationKey -> [slot, window end] as Pacific "HH:MM".
export const WINDOWS = {
  "a3-briefing": ["07:30", "12:00"],
  "a3-recap": ["18:00", "22:00"],
};

function partsLA(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

/**
 * Pure: which jobs to run now?
 * @param {unknown} listJson output of `openclaw cron list --all --json` ({ jobs: [...] } or an array)
 * @param {number} nowMs
 * @returns {{ id: string, key: string }[]}
 */
export function missedJobs(listJson, nowMs, windows = WINDOWS) {
  const jobs = Array.isArray(listJson) ? listJson : Array.isArray(listJson?.jobs) ? listJson.jobs : [];
  const now = partsLA(new Date(nowMs));
  const out = [];
  for (const job of jobs) {
    const key = job?.declarationKey;
    const win = typeof key === "string" ? windows[key] : undefined;
    if (!win || typeof job.id !== "string" || job.enabled === false) continue;
    const [slot, end] = win;
    if (now.hhmm < slot || now.hhmm >= end) continue; // outside the catch-up window
    const last = job.state?.lastRunAtMs;
    if (typeof last === "number" && partsLA(new Date(last)).day === now.day && partsLA(new Date(last)).hhmm >= slot) continue; // already ran today
    out.push({ id: job.id, key });
  }
  return out;
}

if (import.meta.main) {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    process.exit(0); // nothing to catch up if the list can't be read; install-jobs.sh logs the list failure
  }
  for (const j of missedJobs(parsed, Date.now())) process.stdout.write(`${j.id} ${j.key}\n`);
}
