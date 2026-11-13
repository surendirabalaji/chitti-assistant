import { randomUUID } from "node:crypto";
import { decide, type Decision } from "./decide.ts";
import { logDecision, stdoutWriter, type LineWriter } from "./log.ts";

export interface ModelOverride {
  readonly providerOverride: string;
  readonly modelOverride: string;
}

// The only part of OpenClaw's api this file uses (structural type, see concept d).
export interface HookApi {
  on(
    hookName: "before_model_resolve",
    handler: (event: { prompt?: unknown }, ctx: unknown) => ModelOverride | void,
    opts?: { timeoutMs?: number },
  ): void;
}

// Hard-coded for now; becomes api.pluginConfig in a later lesson.
const LOCAL: ModelOverride = Object.freeze({
  providerOverride: "ollama",
  modelOverride: "gemma4-a3:e2b",
});

const CLOUD: ModelOverride = Object.freeze({
  providerOverride: "openai",
  modelOverride: "gpt-6-astra",
});
export function toOverride(decision: Decision): ModelOverride {
    return decision.target.toLocaleLowerCase()==="local"?  LOCAL : CLOUD;
}

export function registerRouter(api: HookApi, writeLine: LineWriter = stdoutWriter): void {
  api.on("before_model_resolve", (event, ctx) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const decision = decide(prompt);
    const override = toOverride(decision);

    // A5 (assistant-written at the student's request): one metadata-only log line per turn.
    // runId is OpenClaw's per-turn UUID; fall back to a fresh UUID if this hook doesn't get it.
    const runId = (ctx as { runId?: unknown } | undefined)?.runId;
    const requestId = typeof runId === "string" && runId.length > 0 ? runId : `local-${randomUUID()}`;
    try {
      logDecision(
        {
          requestId,
          rule: decision.rule,
          target: decision.target,
          model: `${override.providerOverride}/${override.modelOverride}`,
        },
        writeLine,
      );
    } catch {
      // Logging must never change routing: a throw here would make OpenClaw fall back to the default model.
    }
    return override;
  });
}
