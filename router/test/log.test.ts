// Unit tests for router/src/log.ts (Lesson A5: decision logging).
// Written by the assistant (student decision Nov 12: the assistant writes unit tests).
// Requirement: one JSON line per routing decision with route, reason, model, and NO message text
// (REQUIREMENTS.md; AGENTS.md hard rule 6; ROUTER_SPEC.md "Logging").
import { describe, it, expect } from "vitest";
import { formatDecision, logDecision, type DecisionRecord } from "../src/log.ts";

const REC: DecisionRecord = {
  requestId: "run-123",
  rule: "simple-task",
  target: "local",
  model: "ollama/gemma4-a3:e2b",
};
const NOW = new Date("2026-11-12T16:30:00.000Z");

describe("formatDecision: the JSON line", () => {
  it("contains exactly the agreed fields and values", () => {
    expect(JSON.parse(formatDecision(REC, NOW))).toStrictEqual({
      component: "a3-router",
      kind: "route_decision",
      ts: "2026-11-12T16:30:00.000Z",
      requestId: "run-123",
      rule: "simple-task",
      target: "local",
      model: "ollama/gemma4-a3:e2b",
    });
  });

  it("is a single line (log collectors split on newlines)", () => {
    expect(formatDecision(REC, NOW)).not.toContain("\n");
  });

  it("is valid JSON even when values contain quotes or backslashes", () => {
    const tricky = { ...REC, requestId: 'a"b\\c' };
    expect(JSON.parse(formatDecision(tricky, NOW)).requestId).toBe('a"b\\c');
  });

  it("starts with { so Cloud Logging can parse it as jsonPayload", () => {
    expect(formatDecision(REC, NOW).startsWith("{")).toBe(true);
  });

  it("never copies extra input fields (message text can't leak by spreading)", () => {
    const withText = { ...REC, prompt: "my locker code is 4711", message: "Bluebird" } as DecisionRecord;
    const line = formatDecision(withText, NOW);
    expect(line).not.toContain("4711");
    expect(line).not.toContain("Bluebird");
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(
      ["component", "kind", "model", "requestId", "rule", "target", "ts"],
    );
  });

  it("is pure: same input and time give the same line", () => {
    expect(formatDecision(REC, NOW)).toBe(formatDecision(REC, NOW));
  });
});

describe("logDecision: writing the line", () => {
  it("writes exactly one line through the given writer", () => {
    const lines: string[] = [];
    logDecision(REC, (l) => lines.push(l), NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(formatDecision(REC, NOW));
  });

  it("uses the current time when no time is given", () => {
    const lines: string[] = [];
    const before = Date.now();
    logDecision(REC, (l) => lines.push(l));
    const ts = Date.parse(JSON.parse(lines[0]!).ts);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
