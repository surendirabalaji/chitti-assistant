// Tests for missed-job catch-up (assistant-written). Run: node --test deploy/jobs/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { missedJobs } from "./catchup.mjs";

// Nov 16 2026 is PST (UTC-8).
const la = (hhmm, day = "16") => Date.parse(`2026-11-${day}T${hhmm}:00-08:00`);
const job = (key, lastRunAtMs, extra = {}) => ({ id: `id-${key}`, declarationKey: key, enabled: true, state: lastRunAtMs ? { lastRunAtMs } : {}, ...extra });

test("briefing missed (never ran / ran yesterday) and 09:00 -> run; recap not in its window", () => {
  assert.deepEqual(missedJobs({ jobs: [job("a3-briefing"), job("a3-recap")] }, la("09:00")), [{ id: "id-a3-briefing", key: "a3-briefing" }]);
  assert.equal(missedJobs([job("a3-briefing", la("07:30", "15"))], la("09:00")).length, 1);
});

test("briefing already ran today after 07:30 -> nothing; a run before the slot (06:00 manual) doesn't count", () => {
  assert.equal(missedJobs([job("a3-briefing", la("07:31"))], la("09:00")).length, 0);
  assert.equal(missedJobs([job("a3-briefing", la("06:00"))], la("09:00")).length, 1);
});

test("window edges: 07:29 no, 07:30 yes, 11:59 yes, 12:00 no; recap 18:00-22:00", () => {
  assert.equal(missedJobs([job("a3-briefing")], la("07:29")).length, 0);
  assert.equal(missedJobs([job("a3-briefing")], la("07:30")).length, 1);
  assert.equal(missedJobs([job("a3-briefing")], la("11:59")).length, 1);
  assert.equal(missedJobs([job("a3-briefing")], la("12:00")).length, 0);
  assert.equal(missedJobs([job("a3-recap")], la("21:00")).length, 1);
  assert.equal(missedJobs([job("a3-recap")], la("22:00")).length, 0);
});

test("a job that is running right now is not caught up (cloud finding Nov 14)", () => {
  assert.deepEqual(missedJobs([job("a3-recap", la("18:00", "15"), { state: { lastRunAtMs: la("18:00", "15"), runningAtMs: la("18:01") } })], la("18:03")), []);
});

test("disabled, unknown key, missing id, junk input -> ignored", () => {
  const list = [job("a3-briefing", undefined, { enabled: false }), job("a3-alerts"), { declarationKey: "a3-briefing" }, null];
  assert.deepEqual(missedJobs(list, la("09:00")), []);
  assert.deepEqual(missedJobs("junk", la("09:00")), []);
});
