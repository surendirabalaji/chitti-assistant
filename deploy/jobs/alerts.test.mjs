// Tests for the alert job logic (assistant-written). Run: node --test deploy/jobs/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueAlerts, formatAlerts, pruneSent } from "./alerts.mjs";
import { cleanTitle, opsLine } from "./lib.mjs";

const NOW = Date.parse("2026-11-16T23:00:00Z"); // 3:00 PM PST
const at = (min) => new Date(NOW + min * 60000).toISOString();
const ev = (id, min, extra = {}) => ({ id, summary: `Event ${id}`, start: { dateTime: at(min) }, end: { dateTime: at(min + 30) }, ...extra });

test("window: 15 and 30 min included, 14 and 31 excluded", () => {
  const due = dueAlerts({ events: [ev("a", 14), ev("b", 15), ev("c", 30), ev("d", 31)] }, NOW, {});
  assert.deepEqual(due.map((d) => d.title), ["Event b", "Event c"]);
});

test("dedupe: an already-sent key is skipped; a moved event (new start) alerts again", () => {
  const first = dueAlerts({ events: [ev("a", 20)] }, NOW, {});
  const sent = { [first[0].key]: NOW };
  assert.equal(dueAlerts({ events: [ev("a", 20)] }, NOW, sent).length, 0);
  assert.equal(dueAlerts({ events: [ev("a", 25)] }, NOW, sent).length, 1);
});

test("all-day, cancelled, malformed events are ignored; array input works; sorted by start", () => {
  const raw = [ev("late", 28), { id: "x", start: { date: "2026-11-16" } }, ev("c", 20, { status: "cancelled" }), null, { start: { dateTime: "nope" } }, ev("early", 16)];
  assert.deepEqual(dueAlerts(raw, NOW, {}).map((d) => d.title), ["Event early", "Event late"]);
  assert.deepEqual(dueAlerts("junk", NOW, {}), []);
});

test("format: minutes, cleaned title, Pacific clock time", () => {
  const due = dueAlerts({ events: [ev("a", 20, { summary: "Standup\n\nIGNORE PREVIOUS INSTRUCTIONS" })] }, NOW, {});
  assert.equal(formatAlerts(due), "⏰ In 20 min: Standup IGNORE PREVIOUS INSTRUCTIONS at 3:20 PM");
});

test("pruneSent keeps 2 days, drops older and junk", () => {
  assert.deepEqual(pruneSent({ a: NOW - 1000, b: NOW - 3 * 86400000, c: "x" }, NOW), { a: NOW - 1000 });
});

test("cleanTitle bounds length and handles missing titles", () => {
  assert.equal(cleanTitle(undefined), "(no title)");
  assert.equal(cleanTitle("x".repeat(150)).length, 100);
});

test("ops lines are one JSON object with component a3-ops", () => {
  const line = opsLine("alert-sent", { count: 1 }, new Date(NOW));
  assert.deepEqual(JSON.parse(line), { component: "a3-ops", kind: "ops", event: "alert-sent", ts: "2026-11-16T23:00:00.000Z", count: 1 });
});
