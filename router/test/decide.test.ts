// Unit tests for router/src/decide.ts (Lesson A2 scope: one rule).
// Written by the assistant at the student's request (Nov 12 2026: "from now you are going to write
// unit test cases"). The student writes src/decide.ts; these tests pin the behaviour in
// doc/a3/ROUTER_SPEC.md "Minimal first version" and LEARNING_PATH.md Lesson A2.
//
// Rule under test:
//   message contains a reasoning word (case-insensitive) -> { cloud, "reasoning-heavy" }
//   else message.length <= 200                            -> { local, "simple-task" }
//   else                                                  -> { cloud, "default-cloud" }
//
// it.todo rows are open design questions or A6 behaviour; they show as "todo", not failures.
import { describe, it, expect } from "vitest";
import { decide } from "../src/decide.ts";

const LOCAL = { target: "local", rule: "simple-task" };
const REASONING = { target: "cloud", rule: "reasoning-heavy" };
const DEFAULT_CLOUD = { target: "cloud", rule: "default-cloud" };

describe("video prompts (must match the demo)", () => {
  it.each([
    ["What is 12 times 9?", LOCAL],
    ["Explain step by step why the sky is blue.", REASONING],
  ])("%s", (message, expected) => {
    expect(decide(message)).toEqual(expected);
  });
});

describe("each reasoning word routes to cloud", () => {
  it.each([
    "step by step",
    "explain why",
    "analyze",
    "compare",
    "plan",
  ])("%s", (word) => {
    expect(decide(`please ${word} this`)).toEqual(REASONING);
  });
});

describe("reasoning words are case-insensitive", () => {
  it.each([
    ["all caps", "STEP BY STEP: list three colors"],
    ["title case", "Compare tea and coffee"],
    ["mixed case", "Can you AnAlYzE this?"],
    ["caps phrase", "EXPLAIN WHY the moon glows"],
  ])("%s", (_label, message) => {
    expect(decide(message)).toEqual(REASONING);
  });
});

describe("reasoning word position and punctuation", () => {
  it.each([
    ["at the start", "plan a picnic"],
    ["in the middle", "could you compare these two"],
    ["at the end", "this is what I want you to analyze"],
    ["followed by punctuation", "analyze, then summarise."],
    ["inside quotes", 'say "step by step" twice'],
    ["on a second line", "hello\nexplain why water is wet"],
  ])("%s", (_label, message) => {
    expect(decide(message)).toEqual(REASONING);
  });
});

describe("length boundary (no reasoning word)", () => {
  it.each([
    ["empty string (0)", "", LOCAL],
    ["1 char", "x", LOCAL],
    ["199 chars", "x".repeat(199), LOCAL],
    ["exactly 200 chars", "x".repeat(200), LOCAL],
    ["201 chars", "x".repeat(201), DEFAULT_CLOUD],
    ["300 chars", "a".repeat(300), DEFAULT_CLOUD],
    ["5000 chars", "a".repeat(5000), DEFAULT_CLOUD],
    ["whitespace only", "   ", LOCAL],
    ["200 chars made of spaces and words", "hi ".repeat(66) + "ok", LOCAL],
  ])("%s", (_label, message, expected) => {
    expect(decide(message)).toEqual(expected);
  });
});

describe("rule order: reasoning beats length", () => {
  it.each([
    ["short + reasoning word", "plan it", REASONING],
    ["exactly 200 chars + reasoning word", "analyze " + "x".repeat(192), REASONING],
    ["long + reasoning word at start", "analyze " + "a".repeat(300), REASONING],
    ["long + reasoning word at end", "a".repeat(300) + " compare", REASONING],
  ])("%s", (_label, message, expected) => {
    expect(decide(message)).toEqual(expected);
  });
});

describe("JavaScript length counts UTF-16 code units", () => {
  // Documents current behaviour: one emoji like 😀 has .length 2.
  // So 100 emoji = length 200 (local), 101 emoji = length 202 (cloud).
  // If you decide "characters" should mean visible characters, change these rows on purpose.
  it("100 emoji (length 200) -> local", () => {
    expect(decide("😀".repeat(100))).toEqual(LOCAL);
  });
  it("101 emoji (length 202) -> cloud", () => {
    expect(decide("😀".repeat(101))).toEqual(DEFAULT_CLOUD);
  });
});

describe("contract and purity", () => {
  it("returns exactly { target, rule } and nothing else", () => {
    expect(decide("hi")).toStrictEqual(LOCAL);
    expect(Object.keys(decide("hi")).sort()).toEqual(["rule", "target"]);
  });

  it("target is always one of the allowed values", () => {
    for (const m of ["", "hi", "plan", "x".repeat(500)]) {
      expect(["local", "cloud", "held"]).toContain(decide(m).target);
    }
  });

  it("is deterministic: same input, same output", () => {
    const m = "Explain step by step why the sky is blue.";
    expect(decide(m)).toEqual(decide(m));
  });

  it("does not return a shared object that callers could mutate", () => {
    const a = decide("hi");
    (a as { rule: string }).rule = "tampered";
    expect(decide("hi")).toEqual(LOCAL);
  });

  it("never returns held in A2 (no privacy rule yet)", () => {
    expect(decide("this is confidential").target).not.toBe("held");
  });
});

describe("open questions and A6 behaviour (todo)", () => {
  it.todo("A6 word boundary: 'plan' inside 'airplane' or 'planet' should NOT count as reasoning");
  it.todo("A6 word boundary: 'compare' inside 'comparesque'-style words should NOT count");
  it.todo("decide: should 'step-by-step' (hyphenated) count as reasoning?");
  it.todo("decide: should 'explain   why' (extra spaces) or 'explain\\nwhy' count as reasoning?");
  it.todo("decide: should 'analyse' (British spelling) count? ROUTER_SPEC config lists it");
  it.todo("decide: should leading/trailing whitespace count toward the 200-char limit?");
});
