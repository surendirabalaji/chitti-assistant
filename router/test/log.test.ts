// Unit tests for router/src/log.ts (Lesson A5: decision logging).
// Written by the assistant (student decision Nov 12: the assistant writes unit tests).
// Requirement: one JSON line per routing decision with route, reason, model, and NO message text
// (REQUIREMENTS.md; AGENTS.md hard rule 6; ROUTER_SPEC.md "Logging").
import { describe, it, expect } from "vitest";
import { formatDecision, logDecision, formatHealth, formatResult, mirrorWriter, type DecisionRecord } from "../src/log.ts";

const REC: DecisionRecord = {
  requestId: "run-123",
  rule: "simple-task",
  target: "local",
  model: "ollama/gemma4-a3:e2b",
  localHealthy: true,
  sessionSizeEst: 1234,
  rateLimitSimulated: false,
};
const NOW = new Date("2026-11-12T16:30:00.000Z");

describe("router v2 fields", () => {
  it("includes via, signals, category and classifier timing", () => {
    const line = formatDecision({ ...REC, via: "gemma", signals: ["gemma:tool"], category: "tool", classifierMs: 140, classifierError: null }, NOW);
    expect(JSON.parse(line)).toMatchObject({ via: "gemma", signals: ["gemma:tool"], category: "tool", classifierMs: 140, classifierError: null });
  });
  it("drops anything in signals that is not a short signal name (no text can slip through)", () => {
    const line = formatDecision({ ...REC, signals: ["privacy:word", "my locker code is 4711", "x".repeat(60)] }, NOW);
    expect(JSON.parse(line).signals).toEqual(["privacy:word"]);
    expect(line).not.toContain("4711");
  });
});

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
      localHealthy: true,
      sessionSizeEst: 1234,
      rateLimitSimulated: false,
      via: null,
      signals: [],
      category: null,
      classifierMs: null,
      classifierError: null,
      followupCandidate: false,
      followupVerdict: null,
      followupMs: null,
      followupError: null,
    });
  });

  it("follow-up fields are copied (booleans/numbers/codes only)", () => {
    const line = JSON.parse(formatDecision({ ...REC, followupCandidate: true, followupVerdict: true, followupMs: 160, followupError: null }, NOW));
    expect(line).toMatchObject({ followupCandidate: true, followupVerdict: true, followupMs: 160, followupError: null });
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
      ["category", "classifierError", "classifierMs", "component", "followupCandidate", "followupError", "followupMs", "followupVerdict", "kind", "localHealthy", "model", "rateLimitSimulated", "requestId", "rule", "sessionSizeEst", "signals", "target", "ts", "via"],
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

describe("A7/A9 lines", () => {
  it("health line", () => {
    expect(JSON.parse(formatHealth({ from: "up", to: "down", failures: 2, error: "timeout" }, NOW))).toStrictEqual({
      component: "a3-router", kind: "health", ts: "2026-11-12T16:30:00.000Z", target: "local",
      from: "up", to: "down", failures: 2, error: "timeout",
    });
  });
  it("route_result line has exactly the agreed fields", () => {
    const line = formatResult({ requestId: "r", rule: "simple-task", target: "local", servedModel: "ollama/gemma4-a3:e2b", ok: true, latencyMs: 5, error: null }, NOW);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(
      ["component", "error", "kind", "latencyMs", "model", "ok", "requestId", "rule", "servedModel", "target", "ts"],
    );
  });
  it("mirror: copies to an allowed /tmp/a3-router*.log path only", () => {
    const base: string[] = [];
    const files: string[] = [];
    mirrorWriter((l) => base.push(l), "/tmp/a3-router.log", (f, s) => files.push(f + "|" + s))("x");
    mirrorWriter((l) => base.push(l), "/etc/passwd", (f, s) => files.push(f + "|" + s))("y");
    mirrorWriter((l) => base.push(l), undefined, (f, s) => files.push(f + "|" + s))("z");
    expect(base).toEqual(["x", "y", "z"]);
    expect(files).toEqual(["/tmp/a3-router.log|x\n"]);
  });
  it("mirror failure never breaks stdout logging", () => {
    const base: string[] = [];
    mirrorWriter((l) => base.push(l), "/tmp/a3-router.log", () => { throw new Error("disk full"); })("x");
    expect(base).toEqual(["x"]);
  });
});
