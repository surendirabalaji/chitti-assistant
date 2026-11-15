// Unit tests for router/src/decide.ts (router v2: fixed checks + Gemma label + scoring fallback).
// Written by the assistant (student decision Nov 12: the assistant writes unit tests).
// Spec: doc/a3/ROUTER_SPEC.md "Router v2 (layered)"; video prompts from REQUIREMENTS.md.
import { describe, it, expect } from "vitest";
import {
  decide, needsClassifier, DEFAULT_CONFIG, DEFAULT_STATE,
  type RouterState, type Category,
} from "../src/decide.ts";

const UP: RouterState = { localHealthy: true, sessionSizeEst: 0, isCron: false, simulateRateLimit: false, category: null, followup: null };
const DOWN: RouterState = { ...UP, localHealthy: false };
const st = (over: Partial<RouterState>): RouterState => ({ ...UP, ...over });
const g = (category: Category): RouterState => st({ category });
const route = (m: string, s: RouterState = UP) => {
  const d = decide(m, s);
  return { target: d.target, rule: d.rule, via: d.via };
};

describe("video prompts: same route with Gemma's label and without it (heuristic)", () => {
  it.each([
    ["4: simple", "What is 12 times 9?", "simple", { target: "local", rule: "simple-task" }],
    ["5: reasoning", "Explain step by step why the sky is blue.", "reasoning", { target: "cloud", rule: "reasoning-heavy" }],
    ["12: Telegram hello", "Hi, what can you do?", "simple", { target: "local", rule: "simple-task" }],
  ] as const)("%s", (_l, msg, label, expected) => {
    expect(route(msg)).toMatchObject(expected);
    expect(route(msg, g(label))).toMatchObject(expected);
  });

  it("7: private + Ollama down -> cloud fallback by default (student policy Nov 13)", () => {
    const d = decide("This is confidential: remind me my locker code is on a sticky note.", DOWN);
    expect(d).toMatchObject({ target: "cloud", rule: "privacy-local-unavailable", via: "fixed" });
    expect(d.signals).toContain("policy:cloud-fallback");
  });
  it("7 with privateWhenLocalDown='held' -> held (no model involved)", () => {
    expect(decide("This is confidential: remind me my locker code is on a sticky note.", DOWN, { ...DEFAULT_CONFIG, privateWhenLocalDown: "held" }))
      .toMatchObject({ target: "held", rule: "privacy-local-unavailable", via: "fixed" });
  });
  it("9: private + Ollama back -> local (fixed)", () => {
    expect(route('This is confidential: say "back online" in three words.'))
      .toEqual({ target: "local", rule: "privacy-sensitive", via: "fixed" });
  });
});

describe("rule 1: privacy is fixed; Gemma can only ADD it", () => {
  it.each([
    ["keyword", "my doctor called about my results", "privacy:word"],
    ["SSN pattern", "file this: 123-45-6789", "privacy:ssn"],
    ["card number (Luhn-valid)", "card 4111 1111 1111 1111 please", "privacy:card"],
    ["secret value", "the door code is 4711", "privacy:secret-value"],
  ])("%s", (_l, msg, signal) => {
    const d = decide(msg, UP);
    expect(d).toMatchObject({ target: "local", rule: "privacy-sensitive", via: "fixed" });
    expect(d.signals).toContain(signal);
  });

  it("a Gemma label of simple/tool/reasoning can NOT remove fixed privacy", () => {
    for (const c of ["simple", "tool", "reasoning"] as const) {
      expect(route("my salary is 85k, is that low?", g(c)).rule).toBe("privacy-sensitive");
    }
  });

  it("Gemma 'private' adds privacy to a message the patterns missed", () => {
    const d = decide("I keep worrying about the lump I found", g("private"));
    expect(d).toMatchObject({ target: "local", rule: "privacy-sensitive", via: "gemma", signals: ["gemma:private"] });
  });

  it("held policy: local down + private -> held, even with the rate-limit switch on", () => {
    expect(decide("my bank details", { ...DOWN, simulateRateLimit: true }, { ...DEFAULT_CONFIG, privateWhenLocalDown: "held" }).target).toBe("held");
  });
  it("cloud policy: local down + private + rate-limit switch -> none (no model left)", () => {
    expect(decide("my bank details", { ...DOWN, simulateRateLimit: true })).toMatchObject({ target: "none", rule: "cloud-rate-limited" });
  });
  it("local UP: private stays local under both policies (privacy still drives routing)", () => {
    for (const p of ["cloud", "held"] as const) {
      expect(decide("my bank details", UP, { ...DEFAULT_CONFIG, privateWhenLocalDown: p })).toMatchObject({ target: "local", rule: "privacy-sensitive" });
    }
  });

  it.each([
    ["Luhn-invalid 16 digits", "order 1234 5678 9012 3456 arrived"],
    ["phone-like number", "call 213-555-0147"],
    ["code without a value", "write some code for me"],
  ])("no false private: %s", (_l, msg) => {
    expect(decide(msg, UP).rule).not.toBe("privacy-sensitive");
  });
});

describe("fixed rules beat Gemma's label", () => {
  it("long context -> cloud even if Gemma says simple", () => {
    expect(route("hi", st({ sessionSizeEst: 20001, category: "simple" }))).toEqual({ target: "cloud", rule: "long-context", via: "fixed" });
  });
  it("cron/heartbeat -> cloud tool-task", () => {
    expect(route("hi", st({ isCron: true, category: "simple" }))).toEqual({ target: "cloud", rule: "tool-task", via: "fixed" });
  });
  it("> 400 chars -> cloud reasoning-heavy even if Gemma says simple", () => {
    expect(route("a".repeat(401), g("simple"))).toEqual({ target: "cloud", rule: "reasoning-heavy", via: "fixed" });
  });
});

describe("Gemma's label (when available)", () => {
  it.each([
    ["tool", "cloud", "tool-task"],
    ["reasoning", "cloud", "reasoning-heavy"],
    ["simple", "local", "simple-task"],
  ] as const)("%s -> %s %s", (label, target, rule) => {
    expect(route("Should I go now?", g(label))).toEqual({ target, rule, via: "gemma" });
  });

  it("the messages that broke keyword routing", () => {
    expect(route("Should I take the job offer or stay? Think it through.", g("reasoning")).target).toBe("cloud");
    expect(route("What's on tomorrow?", g("tool")).rule).toBe("tool-task");
  });

  it("escalation: an explicit tool/reasoning word still sends a 'simple' label to cloud", () => {
    expect(route("check my inbox", g("simple"))).toEqual({ target: "cloud", rule: "tool-task", via: "heuristic" });
    expect(route("compare these", g("simple"))).toEqual({ target: "cloud", rule: "reasoning-heavy", via: "heuristic" });
  });

  it("regression (laptop Nov 13): a clock time escalates a 'simple' label to tool", () => {
    expect(route("Anything I need to prepare for before my 3pm?", g("simple"))).toMatchObject({ target: "cloud", rule: "tool-task" });
    expect(route("Anything I need to prepare for before my 3pm?")).toMatchObject({ target: "cloud", rule: "tool-task" });
    expect(route("Lunch at 12:30 pm?", g("simple")).rule).toBe("tool-task");
  });

  it("simple label + local down -> cloud local-unavailable", () => {
    expect(route("Name a planet.", { ...DOWN, category: "simple" })).toEqual({ target: "cloud", rule: "local-unavailable", via: "gemma" });
  });
});

describe("scoring fallback (no label: Gemma down, slow, or not asked)", () => {
  it.each([
    ["arithmetic", "What is 12 times 9?", "local", "simple-task"],
    ["arithmetic symbols", "calculate 3*(4+5)", "local", "simple-task"],
    ["short fact", "Name a planet.", "local", "simple-task"],
    ["single why (1 point) stays local", "Why is grass green?", "local", "simple-task"],
    ["advice (2 points)", "Should I take the job offer or stay?", "cloud", "reasoning-heavy"],
    ["why + how (2 points)", "Why do bridges sway and how do engineers stop it?", "cloud", "reasoning-heavy"],
    ["reasoning word", "Explain step by step why the sky is blue.", "cloud", "reasoning-heavy"],
    ["time reference -> tool", "What's on tomorrow?", "cloud", "tool-task"],
    ["weekday -> tool", "Am I free on Thursday?", "cloud", "tool-task"],
    ["tool word", "Do I have unread emails?", "cloud", "tool-task"],
    ["medium length, nothing specific", "x".repeat(300), "cloud", "default-cloud"],
  ] as const)("%s", (_l, msg, target, rule) => {
    expect(route(msg)).toMatchObject({ target, rule, via: "heuristic" });
  });

  it("simple + local down -> cloud local-unavailable", () => {
    expect(route("What is 12 times 9?", DOWN)).toMatchObject({ target: "cloud", rule: "local-unavailable" });
  });

  it("whole words only (A6 behaviour kept)", () => {
    expect(route("name a planet").rule).toBe("simple-task");
    expect(route("the shop went bankrupt").rule).not.toBe("privacy-sensitive");
  });
});

describe("rate-limit switch (cloud outcomes only)", () => {
  it.each([
    ["reasoning label", "Should I?", g("reasoning")],
    ["tool heuristic", "check my email", UP],
    ["long context", "hi", st({ sessionSizeEst: 30000 })],
  ])("%s -> local when Ollama is up", (_l, msg, s) => {
    const d = decide(msg, { ...s, simulateRateLimit: true });
    expect(d).toMatchObject({ target: "local", rule: "cloud-rate-limited" });
    expect(d.signals).toContain("rate-limit:simulated");
  });
  it("cloud outcome + Ollama down -> none", () => {
    expect(decide("Explain step by step why.", { ...DOWN, simulateRateLimit: true }).target).toBe("none");
  });
  it("local outcome unchanged", () => {
    expect(route("Name a planet.", st({ simulateRateLimit: true, category: "simple" })).rule).toBe("simple-task");
  });
});

describe("needsClassifier: only ask Gemma when it can change the outcome", () => {
  it.each([
    ["normal message", "What's on tomorrow?", UP, true],
    ["fixed private", "this is confidential", UP, false],
    ["local down", "What's on tomorrow?", DOWN, false],
    ["cron", "hi", st({ isCron: true }), false],
    ["long context", "hi", st({ sessionSizeEst: 30000 }), false],
    ["very long message", "a".repeat(401), UP, false],
    ["empty", "   ", UP, false],
  ] as const)("%s -> %s", (_l, msg, s, expected) => {
    expect(needsClassifier(msg, s)).toBe(expected);
  });
});

describe("contract", () => {
  it("decide(message) without state = DEFAULT_STATE, no label", () => {
    expect(DEFAULT_STATE).toEqual(UP);
    expect(decide("Name a planet.")).toEqual(decide("Name a planet.", UP));
  });
  it("returns target, rule, via, signals; deterministic; fresh object", () => {
    const a = decide("hi", UP);
    expect(Object.keys(a).sort()).toEqual(["rule", "signals", "target", "via"]);
    a.signals.push("tampered");
    expect(decide("hi", UP).signals).not.toContain("tampered");
  });
  it("signals are names, never message text", () => {
    const d = decide("Bluebird says my locker code is 4711, confidential", UP);
    expect(d.signals.join(" ")).not.toMatch(/bluebird|locker|4711/i);
  });
  it("custom config is respected", () => {
    const cfg = { ...DEFAULT_CONFIG, privacyWords: ["zebra"] };
    expect(decide("a zebra", UP, cfg).rule).toBe("privacy-sensitive");
  });
});

// ---- Follow-up rule (Nov 14, Telegram finding: "Pacific Time and Name it to Test 1 and Test 2" went to Gemma) ----
import { followupCandidate, endsWithQuestion, type PreviousTurn } from "../src/decide.ts";

describe("follow-up: decide()", () => {
  const FU = (verdict: boolean | null, over: Partial<RouterState> = {}) => st({ followup: { verdict }, ...over });
  const answer = "Pacific Time and Name it to Test 1 and Test 2";

  it("Gemma says follow-up -> cloud, rule follow-up, via gemma", () => {
    expect(decide(answer, FU(true, { category: "simple" }))).toEqual({ target: "cloud", rule: "follow-up", via: "gemma", signals: ["followup:gemma"] });
  });
  it("Gemma unavailable -> heuristic follow-up", () => {
    expect(decide("yes", FU(null))).toEqual({ target: "cloud", rule: "follow-up", via: "heuristic", signals: ["followup:recent-question"] });
    expect(decide("the first one", FU(null))).toMatchObject({ rule: "follow-up" });
  });
  it("Gemma says NOT a follow-up -> normal rules (simple stays local)", () => {
    expect(decide("What is the capital of France?", FU(false, { category: "simple" }))).toMatchObject({ target: "local", rule: "simple-task" });
  });
  it("without Gemma, a calculation or a bare greeting/thanks is a new request", () => {
    expect(decide("What is 12 times 9?", FU(null))).toMatchObject({ target: "local", rule: "simple-task" });
    for (const m of ["thanks!", "Thank you so much", "hi", "good morning", "cool"]) {
      expect(decide(m, FU(null)).rule).not.toBe("follow-up");
    }
  });
  it("privacy still wins over a follow-up (local up -> local)", () => {
    expect(decide("my password is hunter2", FU(true))).toMatchObject({ target: "local", rule: "privacy-sensitive" });
    expect(decide("use the doctor appointment slot", FU(true, { category: "private" }))).toMatchObject({ target: "local", rule: "privacy-sensitive" });
  });
  it("not a candidate (followup null) -> unchanged behaviour", () => {
    expect(decide(answer, g("simple"))).toMatchObject({ target: "local", rule: "simple-task" });
  });
  it("rate-limit demo still applies to a follow-up", () => {
    expect(decide("yes", FU(true, { simulateRateLimit: true }))).toMatchObject({ target: "local", rule: "cloud-rate-limited" });
  });
});

describe("follow-up: followupCandidate()", () => {
  const prev = (over: Partial<PreviousTurn> = {}): PreviousTurn =>
    ({ target: "cloud", rule: "tool-task", repliedAt: 1_000_000, askedQuestion: true, ...over });
  const NOW = 1_000_000 + 60_000;

  it("cloud tool/reasoning/follow-up/default turn that asked a question, within 5 min -> candidate", () => {
    for (const rule of ["tool-task", "reasoning-heavy", "follow-up", "default-cloud"]) {
      expect(followupCandidate(prev({ rule }), NOW, false)).toBe(true);
    }
  });
  it("no previous turn, no question, local/held target, or other cloud rules -> not a candidate", () => {
    expect(followupCandidate(undefined, NOW, false)).toBe(false);
    expect(followupCandidate(prev({ askedQuestion: false }), NOW, false)).toBe(false);
    expect(followupCandidate(prev({ target: "local", rule: "simple-task" }), NOW, false)).toBe(false);
    expect(followupCandidate(prev({ target: "held" }), NOW, false)).toBe(false);
    for (const rule of ["privacy-local-unavailable", "local-unavailable", "long-context", "cloud-rate-limited"]) {
      expect(followupCandidate(prev({ rule }), NOW, false)).toBe(false);
    }
  });
  it("window: exactly 5 min yes, 5 min + 1 ms no; clock going backwards no", () => {
    expect(followupCandidate(prev(), 1_000_000 + 300_000, false)).toBe(true);
    expect(followupCandidate(prev(), 1_000_000 + 300_001, false)).toBe(false);
    expect(followupCandidate(prev(), 999_999, false)).toBe(false);
  });
  it("cron turns never; window 0 turns the rule off", () => {
    expect(followupCandidate(prev(), NOW, true)).toBe(false);
    expect(followupCandidate(prev(), NOW, false, { ...DEFAULT_CONFIG, followupWindowMs: 0 })).toBe(false);
  });
});

describe("follow-up: endsWithQuestion()", () => {
  it("a question near the end counts, even with a closing sentence after it", () => {
    expect(endsWithQuestion("Sure. Which time zone should I use, and what should I call them?")).toBe(true);
    expect(endsWithQuestion("Which time zone? I'll create them once you confirm.")).toBe(true);
    expect(endsWithQuestion("Want me to add them?\n\n**Reply yes to confirm.**")).toBe(true);
  });
  it("no question, or a question only far back, does not", () => {
    expect(endsWithQuestion("Done. Both events are in your calendar.")).toBe(false);
    expect(endsWithQuestion("Is it? " + "x".repeat(400))).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
  });
});

describe("follow-up: benchmark-driven fixes (laptop Gemma, Nov 14)", () => {
  it("a calculation is never a follow-up, even if Gemma says so", () => {
    expect(decide("What is 12 times 9?", st({ followup: { verdict: true } }))).toMatchObject({ target: "local", rule: "simple-task" });
  });
  it("generic sign-offs are not questions; a real question next to one still counts", () => {
    for (const r of ["Done! Anything else I can help with?", "All set. Is there anything else you'd like me to do?",
      "Created both events. How else can I help?", "Saved. Can I help you with anything else?", "Done. Need anything else?"]) {
      expect(endsWithQuestion(r)).toBe(false);
    }
    expect(endsWithQuestion("Want me to add a reminder too? Anything else I can help with?")).toBe(true);
  });
});
