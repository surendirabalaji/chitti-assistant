// Decision logging (Lesson A5). Written by the assistant at the student's request (Nov 12).
// One JSON line per routing decision. Metadata only: never message text (AGENTS.md hard rule 6).
import type { Target } from "./decide.ts";

export interface DecisionRecord {
  requestId: string;
  rule: string;
  target: Target;
  model: string; // "provider/model", e.g. "ollama/gemma4-a3:e2b"
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
  });
}

export function logDecision(
  rec: DecisionRecord,
  writeLine: LineWriter = stdoutWriter,
  now: Date = new Date(),
): void {
  writeLine(formatDecision(rec, now));
}
