// Deterministic message signals for routing (router v2, "layered"). Written by the assistant at the
// student's request (Nov 13). Pure: no I/O. Returns signal NAMES only (safe to log), never text.
//
// Privacy is decided here, never by a model: the Nov 13 benchmark showed Gemma missing 4/16 private
// messages (evidence/2026-11-13-classifier-bench.json), so a model may only ADD privacy, never remove it.

export interface WordLists {
  privacyWords: readonly string[];
  toolWords: readonly string[];
  reasoningWords: readonly string[];
}

export interface Analysis {
  privacy: string[]; // e.g. ["privacy:word", "privacy:ssn"]; non-empty => private
  tool: string[]; // e.g. ["tool:word", "tool:time"]
  reasoning: string[]; // e.g. ["reasoning:word", "reasoning:why"]
  reasoningScore: number;
  explicitReasoning: boolean; // a configured reasoning word/phrase is present
  arithmetic: boolean; // the whole message is a small calculation
}

// --- whole-word matching (from A6) ---------------------------------------------------------
const WORD_CHAR = "[\\p{L}\\p{N}_]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileWords(words: readonly string[]): RegExp | null {
  const alternatives = words
    .map((w) => w.trim().split(/[\s-]+/).filter(Boolean).map(escapeRegExp).join("[\\s-]+"))
    .filter((w) => w.length > 0);
  if (alternatives.length === 0) return null;
  return new RegExp(`(?<!${WORD_CHAR})(?:${alternatives.join("|")})(?!${WORD_CHAR})`, "iu");
}

const compiled = new WeakMap<WordLists, { privacy: RegExp | null; tool: RegExp | null; reasoning: RegExp | null }>();
function lists(w: WordLists) {
  let c = compiled.get(w);
  if (!c) {
    c = { privacy: compileWords(w.privacyWords), tool: compileWords(w.toolWords), reasoning: compileWords(w.reasoningWords) };
    compiled.set(w, c);
  }
  return c;
}

// --- personal-data patterns (privacy) -------------------------------------------------------
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
// "my password is X", "my pin: 1234", "the door code is 4711"
const SECRET_VALUE = /\b(?:password|passcode|passphrase|pin|code|combination)\s*(?:is|=|:)\s*\S+/iu;

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    if (luhnValid(m[0].replace(/[ -]/g, ""))) return true;
  }
  return false;
}

// --- tool and reasoning cues ----------------------------------------------------------------
// Time references usually mean "look at my calendar/email/weather now".
const TIME_REF =
  /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|weekend)|next (?:week|month)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/iu;
const WHY = /\bwhy\b/iu;
const HOW = /\bhow (?:do|does|did|can|could|should|would|to)\b/iu;
const SHOULD_I = /\b(?:should i|what if|would it be better)\b/iu;
const CODE = /```|=>|;\s*$|\{[^}]*\}|\bfunction\b|\bconsole\.log\b/mu;
const NUMBERED = /(?:^|\n)\s*\d+[.)]\s+\S/u;
// "What is 12 times 9?", "calculate 3*(4+5)", "7 plus 5"
const ARITHMETIC =
  /^(?:what(?:'s| is)|calculate|compute|how much is)?\s*[-+]?\d[\d\s.,]*(?:\s*(?:[-+*/x×^%]|times|plus|minus|divided by|multiplied by)\s*[-+]?\(?\d[\d\s.,()]*)+\s*\??$/iu;

// "3pm", "10:30 am", "at 9": a clock time usually refers to the user's schedule.
const CLOCK = /\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|at \d{1,2}(?::\d{2})?)\b/iu;

export function analyze(text: string, words: WordLists, simpleMaxChars: number): Analysis {
  const p = lists(words);
  const privacy: string[] = [];
  if (p.privacy?.test(text)) privacy.push("privacy:word");
  if (SSN.test(text)) privacy.push("privacy:ssn");
  if (hasCardNumber(text)) privacy.push("privacy:card");
  if (SECRET_VALUE.test(text)) privacy.push("privacy:secret-value");

  const tool: string[] = [];
  if (p.tool?.test(text)) tool.push("tool:word");
  if (TIME_REF.test(text) || CLOCK.test(text)) tool.push("tool:time");

  const reasoning: string[] = [];
  let score = 0;
  const add = (name: string, points: number) => {
    reasoning.push(name);
    score += points;
  };
  const explicitReasoning = p.reasoning?.test(text) ?? false;
  if (explicitReasoning) add("reasoning:word", 2);
  if (SHOULD_I.test(text)) add("reasoning:advice", 2);
  if (WHY.test(text)) add("reasoning:why", 1);
  if (HOW.test(text)) add("reasoning:how", 1);
  if ((text.match(/\?/g) ?? []).length >= 2) add("reasoning:multi-question", 1);
  if (CODE.test(text)) add("reasoning:code", 1);
  if (NUMBERED.test(text)) add("reasoning:list", 1);
  if (text.length > simpleMaxChars) add("reasoning:long", 1);

  return { privacy, tool, reasoning, reasoningScore: score, explicitReasoning, arithmetic: ARITHMETIC.test(text) };
}
