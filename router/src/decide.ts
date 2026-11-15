// Routing decision. A2 one-rule version written by the student (Nov 12); A6 rule table and the
// layered v2 (fixed checks + Gemma label + scoring fallback) written by the assistant at the
// student's request (Nov 13). Pure: same (message, state, config) -> same Decision. No I/O.
// Spec: doc/a3/ROUTER_SPEC.md "Decision procedure" + "Router v2 (layered)".
import { analyze, type WordLists } from "./signals.ts";

export { compileWords } from "./signals.ts";

export type Target = "local" | "cloud" | "held" | "none";
export type Category = "simple" | "reasoning" | "tool" | "private";
export type Via = "fixed" | "gemma" | "heuristic";

export interface Decision {
  target: Target;
  rule: string;
  via: Via; // what decided: a fixed check, Gemma's label, or the scoring fallback
  signals: string[]; // signal names that drove it (never message text)
}

// Facts about the world at this turn, passed in by the plugin (never read here).
export interface RouterState {
  localHealthy: boolean; // health poller's cached value (A7); assumed true until then
  sessionSizeEst: number; // estimated prompt tokens this session will send (0 = unknown/new)
  isCron: boolean; // turn started by cron or heartbeat, not by a person
  simulateRateLimit: boolean; // demo switch: pretend the cloud is rate-limited
  category: Category | null; // Gemma's label for this message; null = not asked / unavailable
  // Follow-up (Nov 14): set only when this message is a follow-up CANDIDATE (see followupCandidate);
  // verdict = Gemma's check (true/false), null = Gemma not asked or no answer.
  followup: { verdict: boolean | null } | null;
}

// What the plugin remembers about the previous routed turn of a chat (metadata only).
export interface PreviousTurn {
  target: Target;
  rule: string;
  repliedAt: number; // ms clock when the model's reply arrived (or the decision, before that)
  askedQuestion: boolean; // the model's reply ended with a question to the user
}

export type PrivatePolicy = "cloud" | "held";

export interface RouterConfig extends WordLists {
  // Private message while local Gemma is down (course: "your policy choice", both acceptable).
  // "cloud": answer with ChatGPT (student decision Nov 13, default). "held": answer with no model.
  privateWhenLocalDown: PrivatePolicy;
  simpleMaxChars: number;
  reasoningMinChars: number;
  reasoningScoreMin: number; // scoring fallback: points needed for "reasoning"
  longContextTokens: number;
  followupWindowMs: number; // a reply to a cloud question within this time can stay on the cloud; 0 = off
}

export const DEFAULT_STATE: RouterState = Object.freeze({
  localHealthy: true,
  sessionSizeEst: 0,
  isCron: false,
  simulateRateLimit: false,
  category: null,
  followup: null,
});

// longContextTokens is compared with the WHOLE prompt estimate (system prompt ~11-14k + history),
// against OpenClaw's 24,576-token budget for a 32K model.
export const DEFAULT_CONFIG: RouterConfig = Object.freeze({
  privateWhenLocalDown: "cloud" as PrivatePolicy,
  simpleMaxChars: 200,
  reasoningMinChars: 400,
  reasoningScoreMin: 2,
  longContextTokens: 20000,
  followupWindowMs: 5 * 60 * 1000,
  privacyWords: Object.freeze([
    "confidential", "private", "personal", "sensitive", "secret", "password", "passcode",
    "bank", "account number", "credit card", "salary", "income", "tax return", "debt", "loan",
    "ssn", "social security", "medical", "diagnosis", "doctor", "therapist", "therapy",
    "prescription", "blood test", "health", "anxiety", "depression",
  ]),
  reasoningWords: Object.freeze([
    "step by step", "explain why", "analyze", "analyse", "compare", "plan",
    "pros and cons", "trade-off", "trade-offs", "think it through",
  ]),
  toolWords: Object.freeze([
    "email", "emails", "inbox", "mail", "unread", "draft", "reply to", "calendar", "meeting",
    "meetings", "schedule", "event", "events", "agenda", "free slot", "free hour", "search",
    "look up", "latest", "news", "weather", "forecast", "rain", "briefing", "recap", "[a3-cron]",
  ]),
});

export function decide(
  message: string,
  state: RouterState = DEFAULT_STATE,
  config: RouterConfig = DEFAULT_CONFIG,
): Decision {
  const text = message.trim();
  const a = analyze(text, config, config.simpleMaxChars);

  // 1. Privacy: fixed patterns, or Gemma ADDS it (a model can never remove privacy).
  //    Local up -> local. Local down -> the configured policy: "held" (no model) or "cloud" (ChatGPT).
  const gemmaPrivate = state.category === "private";
  let choice: Decision;
  if (a.privacy.length > 0 || gemmaPrivate) {
    const via: Via = a.privacy.length > 0 ? "fixed" : "gemma";
    const signals = a.privacy.length > 0 ? a.privacy : ["gemma:private"];
    if (state.localHealthy) return { target: "local", rule: "privacy-sensitive", via, signals };
    if (config.privateWhenLocalDown === "held") return { target: "held", rule: "privacy-local-unavailable", via, signals };
    choice = { target: "cloud", rule: "privacy-local-unavailable", via, signals: [...signals, "policy:cloud-fallback"] };
  } else {
    choice = taskRoute(text, state, config, a);
  }
  if (choice.target === "local") return choice;

  // Rate-limit demo: any cloud outcome (incl. the private cloud fallback) falls back to local, or to
  // "none" when local is down too.
  if (state.simulateRateLimit) {
    return {
      target: state.localHealthy ? "local" : "none",
      rule: "cloud-rate-limited",
      via: choice.via,
      signals: [...choice.signals, "rate-limit:simulated"],
    };
  }
  return choice;
}

// Rules 2-6: fixed checks first, then Gemma's label, then the scoring fallback.
function taskRoute(text: string, state: RouterState, config: RouterConfig, a: ReturnType<typeof analyze>): Decision {
  // 2. Too much history for Gemma's 32K window.
  if (state.sessionSizeEst > config.longContextTokens) {
    return { target: "cloud", rule: "long-context", via: "fixed", signals: ["session:large"] };
  }
  // 3. Unattended (cron/heartbeat): always the stronger, tool-capable model.
  if (state.isCron) return { target: "cloud", rule: "tool-task", via: "fixed", signals: ["trigger:cron"] };
  // 4a. Very long messages are never "simple", whatever the label says.
  if (text.length > config.reasoningMinChars) {
    return { target: "cloud", rule: "reasoning-heavy", via: "fixed", signals: ["length:long"] };
  }

  // 4a'. Follow-up (Nov 14): the cloud model just asked a question in a tool/reasoning task and this
  //      message answers it ("Pacific time, call them Test 1 and Test 2"). Per-message signals can't see
  //      that, so a short answer would go to Gemma, which can't finish the task. Verified by Gemma when
  //      possible; without Gemma, a calculation or a bare greeting/thanks is treated as a new request.
  if (state.followup && !a.arithmetic) { // a pure calculation is a new request, whatever Gemma says
    const v = state.followup.verdict;
    if (v === true) return { target: "cloud", rule: "follow-up", via: "gemma", signals: ["followup:gemma"] };
    if (v === null && !GREETING_ONLY.test(text)) {
      return { target: "cloud", rule: "follow-up", via: "heuristic", signals: ["followup:recent-question"] };
    }
    // v === false: Gemma says it's a new request -> the normal rules below.
  }

  // 4b. Gemma's label, when we have one. Either side may escalate to the cloud:
  //     any tool signal (word, date, clock time) or an explicit reasoning word wins over "simple".
  if (state.category === "tool" || state.category === "reasoning") {
    const rule = state.category === "tool" ? "tool-task" : "reasoning-heavy";
    return { target: "cloud", rule, via: "gemma", signals: [`gemma:${state.category}`] };
  }
  if (state.category === "simple") {
    if (a.tool.length > 0) return { target: "cloud", rule: "tool-task", via: "heuristic", signals: ["gemma:simple", ...a.tool] };
    if (a.explicitReasoning) return { target: "cloud", rule: "reasoning-heavy", via: "heuristic", signals: ["gemma:simple", ...a.reasoning] };
    return simpleOrUnavailable(state, "gemma", ["gemma:simple"]);
  }

  // 4c. Scoring fallback (Gemma down, slow, or not asked).
  if (a.arithmetic) return simpleOrUnavailable(state, "heuristic", ["simple:arithmetic"]);
  if (a.tool.length > 0) return { target: "cloud", rule: "tool-task", via: "heuristic", signals: a.tool };
  if (a.reasoningScore >= config.reasoningScoreMin) {
    return { target: "cloud", rule: "reasoning-heavy", via: "heuristic", signals: a.reasoning };
  }
  // 5. Short and simple.
  if (text.length <= config.simpleMaxChars) return simpleOrUnavailable(state, "heuristic", a.reasoning.length ? a.reasoning : ["simple:short"]);
  // 6. Medium length, nothing specific.
  return { target: "cloud", rule: "default-cloud", via: "heuristic", signals: a.reasoning.length ? a.reasoning : ["length:medium"] };
}

// Ask Gemma only when its label can change the outcome: not for fixed-private, cron, long-context or
// very long messages, and never when local is down (it would only add a timeout).
export function needsClassifier(message: string, state: RouterState, config: RouterConfig = DEFAULT_CONFIG): boolean {
  const text = message.trim();
  if (text.length === 0 || !state.localHealthy || state.isCron) return false;
  if (state.sessionSizeEst > config.longContextTokens || text.length > config.reasoningMinChars) return false;
  return analyze(text, config, config.simpleMaxChars).privacy.length === 0;
}

// Rules whose cloud turns can be continued by a follow-up. Not the privacy/local-down fallbacks or
// long-context: those reach the cloud for reasons unrelated to the task.
const FOLLOWUP_RULES: ReadonlySet<string> = new Set(["tool-task", "reasoning-heavy", "follow-up", "default-cloud"]);

const GREETING_ONLY =
  /^(?:hi|hey|hello|thanks|thank you|thx|ty|cool|great|nice|good (?:morning|afternoon|evening|night))(?:[\s,!.]+(?:there|so much|a lot|chitti))*[\s!.]*$/iu;

// Pure: is this message a follow-up CANDIDATE? (Gemma then verifies it.) Cron turns never are.
export function followupCandidate(
  prev: PreviousTurn | undefined,
  nowMs: number,
  isCron: boolean,
  config: RouterConfig = DEFAULT_CONFIG,
): boolean {
  if (!prev || isCron || config.followupWindowMs <= 0) return false;
  if (prev.target !== "cloud" || !FOLLOWUP_RULES.has(prev.rule) || !prev.askedQuestion) return false;
  const age = nowMs - prev.repliedAt;
  return age >= 0 && age <= config.followupWindowMs;
}

// Did the model's reply end by asking the user something? Any "?" in the last 300 characters counts
// (e.g. "Which time zone? I'll create them once you confirm."); Gemma's check filters false positives.
// Generic sign-offs ("Anything else I can help with?") are not questions about the task: the laptop
// benchmark (Nov 14) showed Gemma calling unrelated messages follow-ups after them.
export const QUESTION_TAIL_CHARS = 300;
const GENERIC_CLOSER =
  /(?:is there )?anything else(?: (?:i can|i could|you'd like me to|you want me to) [^?]{0,40})?\?|(?:can|may) i help (?:you )?with anything else\?|how (?:else )?can i help(?: you)?(?: today)?\?|need anything else\?/giu;
export function endsWithQuestion(reply: string): boolean {
  return reply.trim().slice(-QUESTION_TAIL_CHARS).replace(GENERIC_CLOSER, "").includes("?");
}

function simpleOrUnavailable(state: RouterState, via: Via, signals: string[]): Decision {
  return state.localHealthy
    ? { target: "local", rule: "simple-task", via, signals }
    : { target: "cloud", rule: "local-unavailable", via, signals };
}
