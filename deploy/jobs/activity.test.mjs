// Tests for a3-activity (assistant-written). Run: node --test deploy/jobs/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayLA, format, summarize } from "./activity.mjs";

const res = (ts, target, ok = true) => ({ component: "a3-router", kind: "route_result", ts, target, ok });

test("dayLA uses Pacific time (00:30 UTC Nov 17 is still Nov 16 in LA)", () => {
  assert.equal(dayLA(new Date("2026-11-17T00:30:00Z")), "2026-11-16");
});

test("counts one Pacific day: targets, failures, cron turns, alerts, hourly", () => {
  const recs = [
    res("2026-11-16T15:00:00Z", "local"),
    res("2026-11-16T16:00:00Z", "cloud"),
    res("2026-11-16T17:00:00Z", "cloud", false),
    res("2026-11-16T18:00:00Z", "held", false), // held is ok:false by design, not a failure
    res("2026-11-15T18:00:00Z", "local"), // other day
    { component: "a3-router", kind: "route_decision", ts: "2026-11-16T15:30:00Z", signals: ["trigger:cron"] },
    { component: "a3-router", kind: "route_decision", ts: "2026-11-16T15:31:00Z", signals: ["tool:calendar"] },
    { component: "a3-ops", event: "alert-sent", ts: "2026-11-16T19:00:00Z", count: 2 },
    { component: "a3-ops", event: "hourly", ts: "2026-11-16T19:07:00Z", local: "up" },
    { component: "a3-ops", event: "hourly", ts: "2026-11-16T20:07:00Z", local: "down" },
    { ts: "junk" },
    null,
  ];
  const s = summarize(recs, "2026-11-16");
  assert.deepEqual(s.byTarget, { local: 1, cloud: 2, held: 1, none: 0 });
  assert.equal(s.results, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.scheduled, 1);
  assert.equal(s.alertsSent, 2);
  assert.deepEqual(s.hourly, { up: 1, down: 1 });
});

test("format: notes when logs start today (container restarted), or are missing", () => {
  const today = format(summarize([res("2026-11-16T20:00:00Z", "local")], "2026-11-16"));
  assert.match(today, /local Gemma 1, cloud ChatGPT 0/);
  assert.match(today, /logs start at 12:00 PM/);
  const older = format(summarize([res("2026-11-15T20:00:00Z", "local"), res("2026-11-16T20:00:00Z", "local")], "2026-11-16"));
  assert.doesNotMatch(older, /logs start/);
  assert.match(format(summarize([], "2026-11-16")), /no activity logs found/);
});
