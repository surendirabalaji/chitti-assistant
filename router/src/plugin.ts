// Router plugin wiring. A4 skeleton written by the student (Nov 12); A5, A6, router v2, A7 (health),
// A8 (held reply) and A9 (route_result, rate-limit config) written by the assistant at the student's
// request (Nov 12-13). Hook shapes: STATUS.md "Plugin API" (read from the installed 2026.10.9).
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  decide, needsClassifier, followupCandidate, endsWithQuestion, QUESTION_TAIL_CHARS, DEFAULT_CONFIG,
  type Decision, type PreviousTurn, type PrivatePolicy, type RouterConfig, type RouterState,
} from "./decide.ts";
import { classify, checkFollowup, type ClassifierResult, type FollowupResult } from "./classifier.ts";
import { startHealthPoller, type HealthPoller } from "./health.ts";
import {
  formatHealth, formatResult, logDecision, mirrorWriter, stdoutWriter, type LineWriter,
} from "./log.ts";

export interface ModelOverride {
  readonly providerOverride: string;
  readonly modelOverride: string;
}

// The only parts of OpenClaw's api this file uses (structural type, see concept d). Handlers read
// every event field defensively, so the event type is left open here.
export type HookName =
  | "before_model_resolve" | "before_agent_reply" | "model_call_ended" | "llm_output" | "agent_end"
  | "before_reset" | "session_end" | "gateway_stop";

export interface HookApi {
  readonly pluginConfig?: unknown; // plugins.entries.a3-router.config
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(hookName: HookName, handler: (event: any, ctx: unknown) => unknown, opts?: { timeoutMs?: number }): void;
}

// Inputs that can be injected (tests) instead of the defaults built from plugin config.
export interface RouterOptions {
  isLocalHealthy?: () => boolean; // default: the A7 health poller (or "always up" if healthCheck is off)
  simulateRateLimit?: () => boolean; // default: plugin config simulateRateLimit (A9)
  classify?: (message: string) => Promise<ClassifierResult>; // default: Gemma via pluginConfig
  checkFollowup?: (question: string, message: string) => Promise<FollowupResult>; // default: Gemma via pluginConfig
  now?: () => number; // ms clock, for latency
  failureQuietMs?: number; // how long without a new attempt before a failed turn is final (default 45000)
}

// ---- plugin config (openclaw.plugin.json configSchema); invalid values fall back to defaults ----
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export const DEFAULT_HELD_REPLY =
  "The local model is off and can't be reached right now, so this private request was held and not sent to any model. Please try again when it's back.";
export const DEFAULT_LONG_CONTEXT_HELD_REPLY =
  "This chat is too long for the private local model, so this private message was held and not sent to any model. Send /new to start a fresh chat, then send it again.";
export const DEFAULT_UNAVAILABLE_REPLY =
  "The cloud model is unavailable right now (simulated rate limit) and the local model is off, so this request was not sent to any model. Please try again later.";

export interface ClassifierConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
}

export interface RouterConfigFromPlugin {
  classifier: ClassifierConfig;
  ollamaUrl: string; // loopback base URL for health checks and the classifier
  healthCheck: boolean;
  simulateRateLimit: boolean;
  heldReply: string;
  longContextHeldReply: string;
  unavailableReply: string;
  logMirrorFile: string | undefined;
  traceHooks: boolean; // laptop debugging: hook arrival metadata to the mirror file only
  privateWhenLocalDown: PrivatePolicy;
  followupWindowMs: number; // 0 = follow-up rule off
}

function obj(raw: unknown): Record<string, unknown> {
  return (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
}

function ollamaUrlFrom(c: Record<string, unknown>): string {
  for (const v of [c.ollamaUrl, c.classifierUrl]) {
    if (typeof v === "string" && LOOPBACK_URL.test(v)) return v;
  }
  return "http://127.0.0.1:11434"; // loopback only: the laptop's Ollama, or the container's forwarder
}

export function readClassifierConfig(raw: unknown): ClassifierConfig {
  const c = obj(raw);
  const t = c.classifierTimeoutMs;
  return {
    enabled: c.classifier !== false,
    url: ollamaUrlFrom(c),
    timeoutMs: typeof t === "number" && t >= 200 && t <= 10000 ? t : 2000,
  };
}

function textOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 500 ? v : fallback;
}

export function readRouterConfig(raw: unknown): RouterConfigFromPlugin {
  const c = obj(raw);
  return {
    classifier: readClassifierConfig(raw),
    ollamaUrl: ollamaUrlFrom(c),
    healthCheck: c.healthCheck !== false,
    simulateRateLimit: c.simulateRateLimit === true,
    heldReply: textOr(c.heldReply, DEFAULT_HELD_REPLY),
    longContextHeldReply: textOr(c.longContextHeldReply, DEFAULT_LONG_CONTEXT_HELD_REPLY),
    unavailableReply: textOr(c.unavailableReply, DEFAULT_UNAVAILABLE_REPLY),
    logMirrorFile: typeof c.logMirrorFile === "string" ? c.logMirrorFile : undefined,
    traceHooks: c.traceHooks === true,
    privateWhenLocalDown: c.privateWhenLocalDown === "held" ? "held" : "cloud",
    followupWindowMs:
      typeof c.followupWindowMs === "number" && c.followupWindowMs >= 0 && c.followupWindowMs <= 3600000
        ? c.followupWindowMs
        : DEFAULT_CONFIG.followupWindowMs,
  };
}

// ---- models ---------------------------------------------------------------------------------
const LOCAL: ModelOverride = Object.freeze({ providerOverride: "ollama", modelOverride: "gemma4-a3:e2b" });
const CLOUD: ModelOverride = Object.freeze({ providerOverride: "openai", modelOverride: "gpt-6-astra" });

// Fail closed: only an explicit "cloud" decision may reach ChatGPT. "held" and "none" are answered by
// before_agent_reply (A8) without any model; as a second line of defence they are pinned to local
// (Ollama is down in those cases, so if the claim ever failed the turn errors instead of leaking).
export function toOverride(decision: Decision): ModelOverride {
  return decision.target === "cloud" ? CLOUD : LOCAL;
}

// ---- session size estimate (rule 2, long-context) -------------------------------------------
// before_model_resolve gets no session history, so we remember, per session, how many tokens the
// previous model call used (prompt + reply, from llm_output usage). llm_output fires once per ATTEMPT
// with usage summed over every model call in it (dist/agentsapi-attempt-hooks-*.mjs, Nov 13), so we
// count model_call_ended per runId and divide: the average call size (slightly below the last call).
const MAX_SESSIONS = 200;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key); // re-insert so the Map's order is "least recently used first"
  map.set(key, value);
  if (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class SessionSizes {
  readonly #sizes = new Map<string, number>();

  get(sessionId: string | undefined): number {
    return sessionId === undefined ? 0 : (this.#sizes.get(sessionId) ?? 0);
  }

  record(sessionId: string | undefined, usage: unknown, calls = 1): void {
    if (sessionId === undefined) return;
    const tokens = usageTokens(usage, calls);
    if (tokens === null) return;
    remember(this.#sizes, sessionId, tokens);
  }

  forget(key: string | undefined): boolean {
    return key === undefined ? false : this.#sizes.delete(key);
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// usage = { input, output, cacheRead, cacheWrite, total } (PluginHookUsage). Prefer total.
// `calls` = model calls the usage was summed over; the result is tokens per call.
export function usageTokens(usage: unknown, calls = 1): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const total = num(u.total);
  const sum = num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
  const tokens = (total > 0 ? total : sum) / (Number.isInteger(calls) && calls > 1 ? calls : 1);
  return tokens > 0 ? Math.round(tokens) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function shortCode(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(v) ? v : undefined;
}

// ctx fields we read: runId, sessionId, sessionKey, trigger ("cron" | "heartbeat" | "user"), jobId.
function readCtx(ctx: unknown) {
  const c = obj(ctx);
  const trigger = str(c.trigger);
  return {
    runId: str(c.runId),
    sessionId: str(c.sessionId) ?? str(c.sessionKey),
    isCron: trigger === "cron" || trigger === "heartbeat" || str(c.jobId) !== undefined,
  };
}

// ---- registration -----------------------------------------------------------------------------
// One poller per process. Re-registering (plugin reload, config edit) replaces it.
let activePoller: HealthPoller | null = null;

interface PendingDecision {
  rule: string;
  target: Decision["target"];
  startedAt: number;
}

// Previous routed turn per chat, for the follow-up rule. `question` = the last ~300 characters of the
// cloud reply when it asked something: kept in memory only (never logged) and shown only to local Gemma.
interface LastTurn extends PreviousTurn {
  runId: string | undefined;
  question: string | null;
}

interface CallInfo {
  served: string; // "provider/model"
  ok: boolean;
  error?: string;
}

export function registerRouter(
  api: HookApi,
  baseWriteLine: LineWriter = stdoutWriter,
  options: RouterOptions = {},
): void {
  const cfg = readRouterConfig(api.pluginConfig);
  const writeLine = mirrorWriter(baseWriteLine, cfg.logMirrorFile, (f, l) => appendFileSync(f, l));
  const write = (line: string): void => {
    try {
      writeLine(line);
    } catch {
      // logging never changes routing
    }
  };
  const now = options.now ?? (() => Date.now());
  // Debug trace (metadata only, mirror file only, never stdout/Cloud Logging).
  const trace = (hook: string, fields: Record<string, unknown>): void => {
    if (!cfg.traceHooks || !cfg.logMirrorFile || !/^\/tmp\/a3-router[\w.-]*\.log$/.test(cfg.logMirrorFile)) return;
    try {
      appendFileSync(cfg.logMirrorFile, JSON.stringify({ component: "a3-router", kind: "hook_trace", ts: new Date().toISOString(), hook, ...fields }) + "\n");
    } catch {
      // best effort
    }
  };

  // A7: health poller. Hooks read the cached value only; they never wait for the network.
  activePoller?.stop();
  activePoller = null;
  let healthy = options.isLocalHealthy;
  if (!healthy) {
    if (cfg.healthCheck) {
      const poller = startHealthPoller(cfg.ollamaUrl, (t) => write(formatHealth(t, new Date())));
      activePoller = poller;
      healthy = () => poller.isHealthy();
    } else {
      healthy = () => true;
    }
  }
  const localHealthy = healthy;
  const simulateRateLimit = options.simulateRateLimit ?? (() => cfg.simulateRateLimit);
  const runClassifier =
    options.classify ??
    ((message: string) =>
      classify(message, { baseUrl: cfg.classifier.url, model: LOCAL.modelOverride, timeoutMs: cfg.classifier.timeoutMs, numCtx: 32768 }));
  const runFollowupCheck =
    options.checkFollowup ??
    ((question: string, message: string) =>
      checkFollowup(question, message, { baseUrl: cfg.classifier.url, model: LOCAL.modelOverride, timeoutMs: cfg.classifier.timeoutMs, numCtx: 32768 }));

  const routing: RouterConfig = { ...DEFAULT_CONFIG, privateWhenLocalDown: cfg.privateWhenLocalDown, followupWindowMs: cfg.followupWindowMs };
  const sessions = new SessionSizes();
  const lastTurns = new Map<string, LastTurn>(); // sessionId -> previous routed turn (follow-up rule)
  const callsPerRun = new Map<string, number>(); // runId -> model calls so far (cleared by llm_output)
  const decisions = new Map<string, PendingDecision>(); // runId -> decision, until its result is logged
  const lastCall = new Map<string, CallInfo>(); // runId -> last model call of the run (A9 servedModel)
  // A9 failure detection. Laptop trace (Nov 13): agent_end fires once per ATTEMPT with success:true even
  // when the model call failed, OpenClaw retries the same model (gaps up to 30 s) and gives up with no
  // final hook. So: success = an attempt whose last model call completed; failure = the last call failed
  // and no new attempt came for failureQuietMs.
  const failureQuietMs = options.failureQuietMs ?? 45000;
  const failTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearFail = (runId: string): void => {
    const t = failTimers.get(runId);
    if (t) clearTimeout(t);
    failTimers.delete(runId);
  };

  const logResult = (runId: string, d: PendingDecision, served: string, ok: boolean, error: string | null, latencyMs: number | null): void => {
    write(formatResult({ requestId: runId, rule: d.rule, target: d.target, servedModel: served, ok, latencyMs, error }, new Date()));
  };

  api.on("before_model_resolve", async (event, ctx) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const c = readCtx(ctx);
    const state: RouterState = {
      localHealthy: localHealthy(),
      sessionSizeEst: sessions.get(c.sessionId),
      isCron: c.isCron,
      simulateRateLimit: simulateRateLimit(),
      category: null,
      followup: null,
    };
    const prev = c.sessionId !== undefined ? lastTurns.get(c.sessionId) : undefined;
    const isCandidate = followupCandidate(prev, now(), c.isCron, routing);
    // Router v2: ask local Gemma for a label (and, for a follow-up candidate, whether the message answers
    // the cloud's last question) only when it can change the outcome. Both calls run in parallel.
    let classifier: ClassifierResult | null = null;
    let followup: FollowupResult | null = null;
    const askGemma = cfg.classifier.enabled && needsClassifier(prompt, state, routing);
    if (askGemma) {
      const question = isCandidate ? prev?.question ?? null : null;
      [classifier, followup] = await Promise.all([
        Promise.resolve()
          .then(() => runClassifier(prompt))
          .catch((): ClassifierResult => ({ category: null, ms: 0, error: "network" })),
        question === null
          ? Promise.resolve(null)
          : Promise.resolve()
              .then(() => runFollowupCheck(question, prompt))
              .catch((): FollowupResult => ({ followup: null, ms: 0, error: "network" })),
      ]);
      state.category = classifier.category;
    }
    if (isCandidate) state.followup = { verdict: followup?.followup ?? null };
    const decision = decide(prompt, state, routing);
    const override = toOverride(decision);

    // runId is OpenClaw's per-turn UUID; it links route_decision, the held claim and route_result.
    const requestId = c.runId ?? `local-${randomUUID()}`;
    if (c.runId) remember(decisions, c.runId, { rule: decision.rule, target: decision.target, startedAt: now() });
    if (c.sessionId !== undefined) {
      remember(lastTurns, c.sessionId, {
        runId: c.runId, target: decision.target, rule: decision.rule, repliedAt: now(), askedQuestion: false, question: null,
      });
    }
    const noModel = decision.target === "held" || decision.target === "none";
    try {
      logDecision(
        {
          requestId,
          rule: decision.rule,
          target: decision.target,
          model: noModel ? "none" : `${override.providerOverride}/${override.modelOverride}`,
          localHealthy: state.localHealthy,
          sessionSizeEst: state.sessionSizeEst,
          rateLimitSimulated: state.simulateRateLimit,
          via: decision.via,
          signals: decision.signals,
          category: state.category,
          classifierMs: classifier?.ms ?? null,
          classifierError: classifier?.error ?? null,
          followupCandidate: isCandidate,
          followupVerdict: followup?.followup ?? null,
          followupMs: followup?.ms ?? null,
          followupError: followup?.error ?? null,
        },
        writeLine,
      );
    } catch {
      // Logging must never change routing: a throw here would make OpenClaw fall back to the default model.
    }
    return override;
  }, { timeoutMs: cfg.classifier.timeoutMs + 3000 }); // OpenClaw's own limit; the classifier's is shorter

  // A8: held / none -> answer without any model, with the same runId as the other hooks.
  // Laptop test (Nov 13): OpenClaw ran this BEFORE before_model_resolve, so usually no decision is
  // stored yet. Then we decide here (fixed checks; no classifier, which only runs when local is up and
  // so can't produce held/none) and, if we claim the turn, write the route_decision line ourselves.
  api.on("before_agent_reply", (event, ctx) => {
    try {
      const c = readCtx(ctx);
      const runId = c.runId ?? `local-${randomUUID()}`;
      let d = c.runId ? decisions.get(c.runId) : undefined;
      if (!d) {
        const body = typeof event?.cleanedBody === "string" ? event.cleanedBody : "";
        const state: RouterState = {
          localHealthy: localHealthy(),
          sessionSizeEst: sessions.get(c.sessionId),
          isCron: c.isCron,
          simulateRateLimit: simulateRateLimit(),
          category: null,
          followup: null, // follow-ups only ever route to the cloud, never to held/none
        };
        const again = decide(body, state, routing);
        if (again.target !== "held" && again.target !== "none") return undefined; // before_model_resolve decides and logs
        d = { rule: again.rule, target: again.target, startedAt: now() };
        try {
          logDecision(
            {
              requestId: runId, rule: again.rule, target: again.target, model: "none",
              localHealthy: state.localHealthy, sessionSizeEst: state.sessionSizeEst, rateLimitSimulated: state.simulateRateLimit,
              via: again.via, signals: again.signals, category: null, classifierMs: null, classifierError: null,
            },
            writeLine,
          );
        } catch {
          // logging never changes routing
        }
      }
      if (d.target !== "held" && d.target !== "none") return undefined;
      decisions.delete(runId);
      logResult(runId, d, "none", false, d.target === "held" ? "held" : "cloud-unavailable", now() - d.startedAt);
      const text = d.target !== "held" ? cfg.unavailableReply : d.rule === "privacy-long-context" ? cfg.longContextHeldReply : cfg.heldReply;
      return { handled: true, reply: { text } };
    } catch {
      return undefined; // the local pin in toOverride still keeps it off the cloud
    }
  });

  // Count model calls per run and remember the last one (metadata only).
  api.on("model_call_ended", (event) => {
    trace("model_call_ended", { runId: str(event?.runId), provider: str(event?.provider), model: str(event?.model), outcome: str(event?.outcome), failureKind: shortCode(event?.failureKind), errorCategory: shortCode(event?.errorCategory), durationMs: event?.durationMs });
    try {
      const runId = str(event?.runId);
      if (runId === undefined) return;
      remember(callsPerRun, runId, (callsPerRun.get(runId) ?? 0) + 1);
      const ok = event?.outcome === "completed";
      remember(lastCall, runId, {
        served: `${str(event?.provider) ?? "unknown"}/${str(event?.model) ?? "unknown"}`,
        ok,
        ...(ok ? {} : { error: shortCode(event?.errorCategory) ?? shortCode(event?.failureKind) ?? "model_error" }),
      });
    } catch {
      // An observer must never break a turn.
    }
  });

  // Observe only: read token usage, never the prompt or reply text the event also carries.
  api.on("llm_output", (event, ctx) => {
    trace("llm_output", { runId: str(event?.runId) ?? readCtx(ctx).runId, provider: str(event?.provider), model: str(event?.model), texts: Array.isArray(event?.assistantTexts) ? event.assistantTexts.length : null });
    try {
      const runId = str(event?.runId) ?? readCtx(ctx).runId;
      const calls = runId === undefined ? 1 : (callsPerRun.get(runId) ?? 1);
      if (runId !== undefined) callsPerRun.delete(runId);
      const sessionId = str(event?.sessionId) ?? readCtx(ctx).sessionId;
      sessions.record(sessionId, event?.usage, calls);
      // Follow-up rule: did this run's (cloud) reply end with a question? Only the tail is kept, in memory.
      const turn = sessionId !== undefined ? lastTurns.get(sessionId) : undefined;
      if (turn && runId !== undefined && turn.runId === runId) {
        const texts = Array.isArray(event?.assistantTexts) ? event.assistantTexts.filter((t: unknown) => typeof t === "string") : [];
        const reply = texts.length > 0 ? String(texts[texts.length - 1]) : "";
        const asked = turn.target === "cloud" && endsWithQuestion(reply);
        turn.askedQuestion = asked;
        turn.question = asked ? reply.trim().slice(-QUESTION_TAIL_CHARS) : null;
        turn.repliedAt = now();
      }
    } catch {
      // An observer must never break a turn.
    }
  });

  // A9: one route_result per routed turn, linked to route_decision by requestId (= runId).
  api.on("agent_end", (event, ctx) => {
    trace("agent_end", { runId: str(event?.runId) ?? readCtx(ctx).runId, success: event?.success, durationMs: event?.durationMs, hasError: typeof event?.error === "string" });
    try {
      const runId = str(event?.runId) ?? readCtx(ctx).runId;
      if (runId === undefined) return;
      const d = decisions.get(runId);
      if (!d) return; // not a turn this router decided (or already logged)
      const call = lastCall.get(runId);
      clearFail(runId);
      if (event?.success === true && call?.ok) {
        decisions.delete(runId);
        lastCall.delete(runId);
        logResult(runId, d, call.served, true, null, now() - d.startedAt);
        return;
      }
      // Failed attempt (or no model call): OpenClaw may retry. Final only after a quiet period.
      const failedAt = now();
      const timer = setTimeout(() => {
        failTimers.delete(runId);
        if (!decisions.has(runId)) return;
        decisions.delete(runId);
        lastCall.delete(runId);
        const error = call?.error ?? (event?.success === true ? "no_model_call" : (shortCode(event?.error) ?? "agent_error"));
        logResult(runId, d, call?.served ?? "none", false, error, failedAt - d.startedAt);
      }, failureQuietMs);
      timer.unref?.();
      failTimers.set(runId, timer);
    } catch {
      // An observer must never break a turn.
    }
  });

  // /new and /reset: forget the chat's size estimate and follow-up state. Cloud finding (Nov 15): Telegram
  // /new keeps the same sessionId (it only marks a reset boundary), so the old size stayed and every private
  // message after /new was held as "privacy-long-context" until a non-private turn re-measured the chat.
  // Installed 2026.10.9: the /new command fires before_reset with ctx { sessionKey, sessionId (the reset
  // session) } (dist/commands-reset-hooks-*.mjs); session_end (event sessionId/sessionKey) is a backup.
  // We store under ctx.sessionId ?? ctx.sessionKey, so both are cleared. Never reads event.messages.
  const forgetSession = (source: string, reason: unknown, keys: (string | undefined)[]): void => {
    try {
      let cleared = false;
      for (const k of new Set(keys)) {
        if (k === undefined) continue;
        if (sessions.forget(k)) cleared = true;
        if (lastTurns.delete(k)) cleared = true;
      }
      write(JSON.stringify({ component: "a3-router", kind: "session_reset", ts: new Date().toISOString(), source, reason: shortCode(reason) ?? null, cleared }));
    } catch {
      // An observer must never break a turn.
    }
  };
  api.on("before_reset", (event, ctx) => {
    const c = obj(ctx);
    forgetSession("before_reset", event?.reason, [str(c.sessionId), str(c.sessionKey)]);
  });
  api.on("session_end", (event, ctx) => {
    const reason = event?.reason;
    if (reason !== "new" && reason !== "reset") return; // idle/shutdown/compaction etc. keep the estimate
    const c = obj(ctx);
    forgetSession("session_end", reason, [str(event?.sessionId), str(event?.sessionKey), str(c.sessionId), str(c.sessionKey)]);
  });

  api.on("gateway_stop", () => {
    activePoller?.stop();
    activePoller = null;
    for (const t of failTimers.values()) clearTimeout(t);
    failTimers.clear();
  });
}
