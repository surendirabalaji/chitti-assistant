// Decision logging (Lesson A5). Written by the assistant at the student's request (Nov 12).
// One JSON line per routing decision. Metadata only: never message text (AGENTS.md hard rule 6).
import type { Target } from "./decide.ts";

export interface DecisionRecord {
  requestId: string;
  rule: string;
  target: Target;
  model: string; // "provider/model", e.g. "ollama/gemma4-a3:e2b"; "none" when no model may run
  // A6 (ROUTER_SPEC.md "Logging"): the state the decision was made with.
  localHealthy: boolean;
  sessionSizeEst: number;
  rateLimitSimulated: boolean;
  // Router v2: why. Signal names come from router code only (never message text).
  via?: string; // "fixed" | "gemma" | "heuristic"
  signals?: readonly string[];
  category?: string | null; // Gemma's label, null when not asked or unavailable
  classifierMs?: number | null;
  classifierError?: string | null;
  // Follow-up rule (Nov 14): candidate = previous cloud tool/reasoning reply asked a question recently.
  followupCandidate?: boolean;
  followupVerdict?: boolean | null; // Gemma's check; null = not asked / no answer
  followupMs?: number | null;
  followupError?: string | null;
}

export type LineWriter = (line: string) => void;

// Write straight to stdout so nothing (e.g. a console wrapper) can prefix the line;
// Cloud Logging only parses a line as jsonPayload when the whole line is JSON.
export const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line + "\n");
};

export function formatDecision(rec: DecisionRecord, now: Date): string {
  // Allowlist: name every field. Never spread `rec`, so extra fields (like a prompt) can't leak.
  return JSON.stringify({
    component: "a3-router",
    kind: "route_decision",
    ts: now.toISOString(),
    requestId: rec.requestId,
    rule: rec.rule,
    target: rec.target,
    model: rec.model,
    localHealthy: rec.localHealthy,
    sessionSizeEst: rec.sessionSizeEst,
    rateLimitSimulated: rec.rateLimitSimulated,
    via: rec.via ?? null,
    signals: rec.signals ? rec.signals.filter((x) => /^[a-z0-9:-]{1,40}$/.test(x)).slice(0, 12) : [],
    category: rec.category ?? null,
    classifierMs: rec.classifierMs ?? null,
    classifierError: rec.classifierError ?? null,
    followupCandidate: rec.followupCandidate ?? false,
    followupVerdict: rec.followupVerdict ?? null,
    followupMs: rec.followupMs ?? null,
    followupError: rec.followupError ?? null,
  });
}

export function logDecision(
  rec: DecisionRecord,
  writeLine: LineWriter = stdoutWriter,
  now: Date = new Date(),
): void {
  writeLine(formatDecision(rec, now));
}

// --- A7: health changes; A9: results. Assistant-written at the student's request (Nov 13). ---

export interface HealthRecord {
  from: string;
  to: string;
  failures: number;
  error?: string;
}

export function formatHealth(rec: HealthRecord, now: Date): string {
  return JSON.stringify({
    component: "a3-router",
    kind: "health",
    ts: now.toISOString(),
    target: "local",
    from: rec.from,
    to: rec.to,
    failures: rec.failures,
    error: rec.error ?? null,
  });
}

export interface ResultRecord {
  requestId: string;
  rule: string;
  target: string; // what the router chose: local | cloud | held | none
  servedModel: string; // "provider/model" that actually answered, or "none"
  ok: boolean;
  latencyMs: number | null;
  error?: string | null; // short code only
}

export function formatResult(rec: ResultRecord, now: Date): string {
  return JSON.stringify({
    component: "a3-router",
    kind: "route_result",
    ts: now.toISOString(),
    requestId: rec.requestId,
    rule: rec.rule,
    target: rec.target,
    servedModel: rec.servedModel,
    model: rec.servedModel, // same value under the column name the video log command uses
    ok: rec.ok,
    latencyMs: rec.latencyMs,
    error: rec.error ?? null,
  });
}

// Optional copy of every router line to a local file, for laptop testing (the gateway's stdout is
// in the student's terminal). Metadata only, same lines as stdout. Only paths under /tmp/a3-router.
export function mirrorWriter(base: LineWriter, file: string | undefined, append: (f: string, s: string) => void): LineWriter {
  if (!file || !/^\/tmp\/a3-router[\w.-]*\.log$/.test(file)) return base;
  return (line) => {
    base(line);
    try {
      append(file, line + "\n");
    } catch {
      // the mirror is best effort
    }
  };
}
