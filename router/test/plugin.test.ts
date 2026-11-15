// Unit tests for router/src/plugin.ts (Lesson A4).
// Written by the assistant (student decision Nov 12: the assistant writes unit tests).
// plugin.ts must NOT import "openclaw": these tests run without OpenClaw installed here.
// index.ts (the thin definePluginEntry wrapper) is verified by installing the plugin, not here.
//
// Facts these tests rely on (STATUS.md "Plugin API", read from OpenClaw 2026.10.9):
//   - before_model_resolve event: { prompt: string; attachments?: [...] }
//   - result: { providerOverride?: string; modelOverride?: string }  (two separate fields)
//   - a throwing handler is logged and the turn falls back to the default model
import { describe, it, expect, vi } from "vitest";
import { toOverride, registerRouter, readClassifierConfig, readRouterConfig } from "../src/plugin.ts";

const GEMMA = { providerOverride: "ollama", modelOverride: "gemma4-a3:e2b" };
const CHATGPT = { providerOverride: "openai", modelOverride: "gpt-6-astra" };

type Handler = (event: unknown, ctx: unknown) => unknown;

// A fake of the one piece of OpenClaw's api that registerRouter uses.
// pluginConfig defaults to classifier and health checks OFF so no test ever calls a real Ollama.
function fakeApi(pluginConfig: unknown = { classifier: false, healthCheck: false }) {
  const calls: { name: string; handler: Handler; opts?: unknown }[] = [];
  return {
    calls,
    api: {
      pluginConfig,
      on(name: string, handler: Handler, opts?: unknown) {
        calls.push({ name, handler, opts });
      },
    },
  };
}

function registeredHandler(): Handler {
  const { api, calls } = fakeApi();
  registerRouter(api as never);
  const found = calls.find((c) => c.name === "before_model_resolve");
  if (!found) throw new Error("before_model_resolve was not registered");
  return found.handler;
}

describe("toOverride: Decision -> OpenClaw override", () => {
  it("local -> Gemma via the ollama provider", () => {
    expect(toOverride({ target: "local", rule: "simple-task" })).toEqual(GEMMA);
  });

  it("cloud -> ChatGPT via the openai provider", () => {
    expect(toOverride({ target: "cloud", rule: "reasoning-heavy" })).toEqual(CHATGPT);
  });

  it("does not depend on the rule name, only the target", () => {
    expect(toOverride({ target: "cloud", rule: "default-cloud" })).toEqual(CHATGPT);
  });

  it("uses two separate fields, never one 'provider/model' string", () => {
    const o = toOverride({ target: "local", rule: "simple-task" }) as unknown as Record<string, string>;
    expect(o.modelOverride).not.toContain("/");
    expect(o.providerOverride).not.toContain("/");
  });

  // Either design is fine: return a fresh copy, or return a frozen shared object
  // (student chose readonly + Object.freeze). What matters: tampering can't change later results.
  it("callers can't corrupt shared state (fresh copy or frozen object)", () => {
    const a = toOverride({ target: "local", rule: "simple-task" }) as unknown as Record<string, string>;
    try {
      a.modelOverride = "tampered"; // throws in strict mode if frozen; harmless if a copy
    } catch {
      // frozen: assignment rejected, which is also fine
    }
    expect(toOverride({ target: "local", rule: "simple-task" })).toEqual(GEMMA);
    expect(toOverride({ target: "cloud", rule: "default-cloud" })).toEqual(CHATGPT);
  });

  it("A6 fail-closed: held and none never map to the cloud model (A8 adds the synthetic reply)", () => {
    expect(toOverride({ target: "held", rule: "privacy-local-unavailable" })).toEqual(GEMMA);
    expect(toOverride({ target: "none", rule: "cloud-rate-limited" })).toEqual(GEMMA);
  });
});

describe("registerRouter: hook registration", () => {
  it("registers exactly one before_model_resolve handler", () => {
    const { api, calls } = fakeApi();
    registerRouter(api as never);
    expect(calls.filter((c) => c.name === "before_model_resolve")).toHaveLength(1);
  });

  it("registers exactly the hooks it needs (A5-A9)", () => {
    const { api, calls } = fakeApi();
    registerRouter(api as never);
    expect(calls.map((c) => c.name)).toEqual([
      "before_model_resolve", "before_agent_reply", "model_call_ended", "llm_output", "agent_end", "gateway_stop",
    ]);
  });

  it("the handler is a function", () => {
    expect(typeof registeredHandler()).toBe("function");
  });
});

describe("before_model_resolve handler: end-to-end routing", () => {
  it.each([
    ["video prompt 1", "What is 12 times 9?", GEMMA],
    ["video prompt 2", "Explain step by step why the sky is blue.", CHATGPT],
    ["long, no reasoning word", "a".repeat(300), CHATGPT],
    ["empty prompt", "", GEMMA],
  ])("%s", async (_label, prompt, expected) => {
    const result = await registeredHandler()({ prompt }, {});
    expect(result).toEqual(expected);
  });

  it("ignores attachments for now (routes on prompt text only)", async () => {
    const result = await registeredHandler()(
      { prompt: "What is 12 times 9?", attachments: [{ kind: "image" }] },
      {},
    );
    expect(result).toEqual(GEMMA);
  });

  it("works when ctx is missing or has unknown fields", async () => {
    const h = registeredHandler();
    expect(await h({ prompt: "hi" }, undefined)).toEqual(GEMMA);
    expect(await h({ prompt: "hi" }, { runId: "r1", trigger: "user", extra: 1 })).toEqual(GEMMA);
  });

  it("each turn is decided independently (no state leaks between calls)", async () => {
    const h = registeredHandler();
    expect(await h({ prompt: "Explain step by step why." }, {})).toEqual(CHATGPT);
    expect(await h({ prompt: "What is 2+2?" }, {})).toEqual(GEMMA);
    expect(await h({ prompt: "Explain step by step why." }, {})).toEqual(CHATGPT);
  });
});

describe("handler robustness (a throw silently falls back to the default model)", () => {
  it.each([
    ["prompt missing", {}],
    ["prompt is null", { prompt: null }],
    ["prompt is a number", { prompt: 42 }],
    ["event is undefined", undefined],
  ])("does not throw: %s", async (_label, event) => {
    const h = registeredHandler();
    await expect(Promise.resolve().then(() => h(event, {}))).resolves.not.toThrow();
  });

  it.each([
    ["prompt missing", {}],
    ["event is undefined", undefined],
  ])("still returns a valid override: %s", async (_label, event) => {
    const result = (await registeredHandler()(event, {})) as Record<string, string>;
    expect(["ollama", "openai"]).toContain(result.providerOverride);
  });
});

// ---- Lesson A5: the hook logs one route_decision line per turn ----
describe("A5: decision logging from the hook", () => {
  function handlerWithSink(sink: (line: string) => void): Handler {
    const { api, calls } = fakeApi();
    registerRouter(api as never, sink);
    return calls.find((c) => c.name === "before_model_resolve")!.handler;
  }

  it("logs exactly one line per turn", async () => {
    const lines: string[] = [];
    const h = handlerWithSink((l) => lines.push(l));
    await h({ prompt: "What is 12 times 9?" }, { runId: "r1" });
    await h({ prompt: "Explain step by step why." }, { runId: "r2" });
    expect(lines).toHaveLength(2);
  });

  it("local turn: rule, target, provider/model, and runId as requestId", async () => {
    const lines: string[] = [];
    await handlerWithSink((l) => lines.push(l))({ prompt: "What is 12 times 9?" }, { runId: "run-abc" });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      component: "a3-router",
      kind: "route_decision",
      requestId: "run-abc",
      rule: "simple-task",
      target: "local",
      model: "ollama/gemma4-a3:e2b",
    });
  });

  it("cloud turn: model is openai/gpt-6-astra", async () => {
    const lines: string[] = [];
    await handlerWithSink((l) => lines.push(l))(
      { prompt: "Explain step by step why the sky is blue." },
      { runId: "run-def" },
    );
    expect(JSON.parse(lines[0]!)).toMatchObject({
      target: "cloud",
      rule: "reasoning-heavy",
      model: "openai/gpt-6-astra",
    });
  });

  it("NEVER logs message text", async () => {
    const lines: string[] = [];
    await handlerWithSink((l) => lines.push(l))(
      { prompt: "Bluebird says my locker code is 4711" },
      { runId: "r" },
    );
    expect(lines[0]).not.toMatch(/bluebird|locker|4711/i);
  });

  it("still logs a non-empty requestId when ctx has no runId", async () => {
    const lines: string[] = [];
    const h = handlerWithSink((l) => lines.push(l));
    await h({ prompt: "hi" }, undefined);
    await h({ prompt: "hi" }, {});
    for (const l of lines) {
      const id = JSON.parse(l).requestId;
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("a broken logger never breaks routing (logging is not allowed to change the model)", async () => {
    const h = handlerWithSink(() => {
      throw new Error("stdout closed");
    });
    expect(await h({ prompt: "What is 12 times 9?" }, { runId: "r" })).toEqual(GEMMA);
    expect(await h({ prompt: "Explain step by step why." }, { runId: "r" })).toEqual(CHATGPT);
  });

  it("logging does not change the returned override", async () => {
    const h = handlerWithSink(() => {});
    expect(await h({ prompt: "What is 12 times 9?" }, {})).toEqual(GEMMA);
  });
});

// ---- Lesson A6: state passed into decide() ----
describe("A6: state from ctx, options and llm_output", () => {
  function setup(options: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const { api, calls } = fakeApi();
    registerRouter(api as never, (l) => lines.push(l), options as never);
    const resolve = calls.find((c) => c.name === "before_model_resolve")!.handler;
    const output = calls.find((c) => c.name === "llm_output")!.handler;
    const callEnded = calls.find((c) => c.name === "model_call_ended")!.handler;
    const last = () => JSON.parse(lines[lines.length - 1]!);
    return { resolve, output, callEnded, lines, last };
  }

  it("log line carries localHealthy, sessionSizeEst, rateLimitSimulated", async () => {
    const { resolve, last } = setup();
    await resolve({ prompt: "hi" }, { runId: "r" });
    expect(last()).toMatchObject({ localHealthy: true, sessionSizeEst: 0, rateLimitSimulated: false });
  });

  it.each([["cron"], ["heartbeat"]])("trigger '%s' -> cloud tool-task", async (trigger) => {
    const { resolve, last } = setup();
    expect(await resolve({ prompt: "hi" }, { trigger })).toEqual(CHATGPT);
    expect(last().rule).toBe("tool-task");
  });

  it("a cron jobId also counts as unattended", async () => {
    const { resolve } = setup();
    expect(await resolve({ prompt: "hi" }, { jobId: "job-1" })).toEqual(CHATGPT);
  });

  it("trigger 'user' stays on the normal rules", async () => {
    const { resolve } = setup();
    expect(await resolve({ prompt: "hi" }, { trigger: "user" })).toEqual(GEMMA);
  });

  it("llm_output usage grows the session estimate; over 20000 -> long-context (per session)", async () => {
    const { resolve, output, last } = setup();
    output({ sessionId: "s1", usage: { input: 15000, output: 500, total: 21000 } }, {});
    expect(await resolve({ prompt: "hi" }, { sessionId: "s1" })).toEqual(CHATGPT);
    expect(last()).toMatchObject({ rule: "long-context", sessionSizeEst: 21000 });
    expect(await resolve({ prompt: "hi" }, { sessionId: "s2" })).toEqual(GEMMA); // other session unaffected
  });

  it("without total, the parts are summed; garbage usage is ignored", async () => {
    const { resolve, output, last } = setup();
    output({ sessionId: "s1", usage: { input: 100, output: 20, cacheRead: 5 } }, {});
    await resolve({ prompt: "hi" }, { sessionId: "s1" });
    expect(last().sessionSizeEst).toBe(125);
    output({ sessionId: "s1", usage: "nope" }, {});
    output({ sessionId: "s1", usage: { input: -5, total: NaN } }, {});
    await resolve({ prompt: "hi" }, { sessionId: "s1" });
    expect(last().sessionSizeEst).toBe(125);
  });

  it("regression (laptop, Nov 13): a 3-call tool turn's summed usage is divided per call", async () => {
    // Real numbers: weather turn usage.total 41430 over ~3 calls; real context ~15k. Next turn "hi" must stay local.
    const { resolve, output, callEnded, last } = setup();
    for (let i = 0; i < 3; i++) callEnded({ runId: "w" }, {});
    output({ runId: "w", sessionId: "s1", usage: { total: 41430 } }, {});
    expect(await resolve({ prompt: "Hi again, what is 2 plus 2?" }, { sessionId: "s1" })).toEqual(GEMMA);
    expect(last()).toMatchObject({ rule: "simple-task", sessionSizeEst: 13810 });
  });

  it("call counts are per run and cleared after llm_output", async () => {
    const { resolve, output, callEnded, last } = setup();
    callEnded({ runId: "a" }, {});
    callEnded({ runId: "a" }, {});
    callEnded({ runId: "b" }, {});
    output({ runId: "b", sessionId: "s1", usage: { total: 900 } }, {});
    await resolve({ prompt: "hi" }, { sessionId: "s1" });
    expect(last().sessionSizeEst).toBe(900);
    output({ runId: "a", sessionId: "s1", usage: { total: 900 } }, {});
    await resolve({ prompt: "hi" }, { sessionId: "s1" });
    expect(last().sessionSizeEst).toBe(450);
    output({ runId: "a", sessionId: "s1", usage: { total: 900 } }, {}); // count already cleared -> 1
    await resolve({ prompt: "hi" }, { sessionId: "s1" });
    expect(last().sessionSizeEst).toBe(900);
  });

  it("llm_output never throws on odd events and never logs anything", () => {
    const { output, lines } = setup();
    expect(() => output(undefined, undefined)).not.toThrow();
    expect(() => output({ usage: { total: 5 } }, null)).not.toThrow(); // no session id
    const { callEnded } = setup();
    expect(() => callEnded(undefined, undefined)).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it("local down (A7 option): private -> cloud fallback by default (student policy Nov 13)", async () => {
    const { resolve, last } = setup({ isLocalHealthy: () => false });
    expect(await resolve({ prompt: "This is confidential: my locker code" }, {})).toEqual(CHATGPT);
    expect(last()).toMatchObject({ target: "cloud", rule: "privacy-local-unavailable", model: "openai/gpt-6-astra", localHealthy: false });
    expect(await resolve({ prompt: "What is 12 times 9?" }, {})).toEqual(CHATGPT);
    expect(last().rule).toBe("local-unavailable");
  });

  it("rate-limit option (A9): reasoning prompt goes local and is logged", async () => {
    const { resolve, last } = setup({ simulateRateLimit: () => true });
    expect(await resolve({ prompt: "Explain step by step why." }, {})).toEqual(GEMMA);
    expect(last()).toMatchObject({ rule: "cloud-rate-limited", target: "local", rateLimitSimulated: true });
  });
});

// ---- Router v2: the Gemma classifier inside the hook ----
describe("v2: classifier in before_model_resolve", () => {
  function setupV2(classifyImpl: (m: string) => Promise<unknown>, extra: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const asked: string[] = [];
    const { api, calls } = fakeApi({ healthCheck: false });
    registerRouter(api as never, (l) => lines.push(l), {
      classify: async (m: string) => { asked.push(m); return classifyImpl(m); },
      ...extra,
    } as never);
    const resolve = calls.find((c) => c.name === "before_model_resolve")!;
    return { resolve: resolve.handler, opts: resolve.opts, lines, asked, last: () => JSON.parse(lines[lines.length - 1]!) };
  }

  it("Gemma 'tool' sends a keyword-free message to cloud; log shows via/category/classifierMs", async () => {
    const { resolve, last } = setupV2(async () => ({ category: "tool", ms: 140 }));
    expect(await resolve({ prompt: "What's up for me later?" }, { runId: "r" })).toEqual(CHATGPT);
    expect(last()).toMatchObject({ rule: "tool-task", via: "gemma", category: "tool", classifierMs: 140, classifierError: null, signals: ["gemma:tool"] });
  });

  it("Gemma 'private' keeps a pattern-free message local", async () => {
    const { resolve, last } = setupV2(async () => ({ category: "private", ms: 150 }));
    expect(await resolve({ prompt: "I keep worrying about the lump I found" }, {})).toEqual(GEMMA);
    expect(last()).toMatchObject({ rule: "privacy-sensitive", via: "gemma" });
  });

  it("classifier failure -> scoring fallback decides, error code logged", async () => {
    const { resolve, last } = setupV2(async () => ({ category: null, ms: 2000, error: "timeout" }));
    expect(await resolve({ prompt: "What is 12 times 9?" }, {})).toEqual(GEMMA);
    expect(last()).toMatchObject({ via: "heuristic", category: null, classifierError: "timeout" });
  });

  it("a throwing classifier never breaks routing", async () => {
    const { resolve, last } = setupV2(async () => { throw new Error("boom"); });
    expect(await resolve({ prompt: "Explain step by step why." }, {})).toEqual(CHATGPT);
    expect(last()).toMatchObject({ classifierError: "network", via: "heuristic" });
  });

  it("not asked for fixed-private, cron, or when local is down", async () => {
    const a = setupV2(async () => ({ category: "simple", ms: 1 }));
    await a.resolve({ prompt: "This is confidential: hi" }, {});
    await a.resolve({ prompt: "hi" }, { trigger: "cron" });
    expect(a.asked).toEqual([]);
    expect(a.last()).toMatchObject({ classifierMs: null, category: null });
    const b = setupV2(async () => ({ category: "simple", ms: 1 }), { isLocalHealthy: () => false });
    await b.resolve({ prompt: "Name a planet." }, {});
    expect(b.asked).toEqual([]);
  });

  it("classifier gets the prompt; the log never contains it", async () => {
    const { resolve, lines, asked } = setupV2(async () => ({ category: "simple", ms: 1 }));
    await resolve({ prompt: "Bluebird is my fictional project" }, {});
    expect(asked).toEqual(["Bluebird is my fictional project"]);
    expect(lines.join("")).not.toMatch(/bluebird/i);
  });

  it("hook timeout given to OpenClaw is longer than the classifier's", () => {
    const { opts } = setupV2(async () => ({ category: "simple", ms: 1 }));
    expect((opts as { timeoutMs: number }).timeoutMs).toBe(5000);
  });
});

describe("v2: readClassifierConfig", () => {
  it("defaults: on, laptop Ollama, 2000 ms", () => {
    expect(readClassifierConfig(undefined)).toEqual({ enabled: true, url: "http://127.0.0.1:11434", timeoutMs: 2000 });
  });
  it("container values", () => {
    expect(readClassifierConfig({ classifier: true, classifierUrl: "http://127.0.0.1:11435", classifierTimeoutMs: 1500 }))
      .toEqual({ enabled: true, url: "http://127.0.0.1:11435", timeoutMs: 1500 });
  });
  it("refuses non-loopback URLs (message text must never leave via this path) and silly timeouts", () => {
    const c = readClassifierConfig({ classifierUrl: "http://evil.example.com:11434", classifierTimeoutMs: 999999 });
    expect(c.url).toBe("http://127.0.0.1:11434");
    expect(c.timeoutMs).toBe(2000);
  });
  it("classifier: false turns it off", () => {
    expect(readClassifierConfig({ classifier: false }).enabled).toBe(false);
  });
});

// ---- A7 / A8 / A9 inside the plugin ----
describe("A7-A9: health, held reply, route_result, rate-limit config", () => {
  function setup(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const { api, calls } = fakeApi({ classifier: false, healthCheck: false, ...config });
    let t = 1000;
    registerRouter(api as never, (l) => lines.push(l), { now: () => t, ...options } as never);
    const h = (name: string) => calls.find((c) => c.name === name)!.handler;
    return {
      lines,
      parsed: () => lines.map((l) => JSON.parse(l)),
      tick: (ms: number) => { t += ms; },
      resolve: h("before_model_resolve"),
      claim: h("before_agent_reply"),
      callEnded: h("model_call_ended"),
      end: h("agent_end"),
      output: h("llm_output"),
    };
  }
  const PRIVATE = "This is confidential: remind me my locker code is on a sticky note.";

  it("A8 (held policy): private + local down -> decision held/model none, claim answers with the held reply, result ok:false", async () => {
    const x = setup({ privateWhenLocalDown: "held" }, { isLocalHealthy: () => false });
    expect(await x.resolve({ prompt: PRIVATE }, { runId: "r7" })).toEqual(GEMMA); // second line of defence
    x.tick(40);
    const claim = (await x.claim({ cleanedBody: PRIVATE }, { runId: "r7" })) as { handled: boolean; reply: { text: string } };
    expect(claim.handled).toBe(true);
    expect(claim.reply.text).toMatch(/held and not sent to any model/);
    const [dec, res] = x.parsed();
    expect(dec).toMatchObject({ kind: "route_decision", requestId: "r7", target: "held", model: "none", rule: "privacy-local-unavailable" });
    expect(res).toMatchObject({ kind: "route_result", requestId: "r7", target: "held", servedModel: "none", model: "none", ok: false, error: "held", latencyMs: 40 });
  });

  it("A8: a later agent_end for a held turn adds no second result", async () => {
    const x = setup({ privateWhenLocalDown: "held" }, { isLocalHealthy: () => false });
    await x.resolve({ prompt: PRIVATE }, { runId: "r" });
    await x.claim({ cleanedBody: PRIVATE }, { runId: "r" });
    await x.end({ runId: "r", success: false }, { runId: "r" });
    expect(x.parsed().filter((l) => l.kind === "route_result")).toHaveLength(1);
  });

  it("cloud policy (default): private + local down -> claim does nothing, ChatGPT answers, result logged", async () => {
    const x = setup({}, { isLocalHealthy: () => false });
    expect(await x.claim({ cleanedBody: PRIVATE }, { runId: "c1" })).toBeUndefined();
    expect(await x.resolve({ prompt: PRIVATE }, { runId: "c1" })).toEqual(CHATGPT);
    await x.callEnded({ runId: "c1", provider: "openai", model: "gpt-6-astra", outcome: "completed" }, {});
    await x.end({ runId: "c1", success: true }, { runId: "c1" });
    const [dec, res] = x.parsed();
    expect(dec).toMatchObject({ kind: "route_decision", rule: "privacy-local-unavailable", target: "cloud", model: "openai/gpt-6-astra" });
    expect(dec.signals).toContain("policy:cloud-fallback");
    expect(res).toMatchObject({ kind: "route_result", target: "cloud", servedModel: "openai/gpt-6-astra", ok: true });
  });

  it("A8: the claim does nothing for normal turns", async () => {
    const x = setup();
    await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "r" });
    expect(await x.claim({ cleanedBody: "What is 12 times 9?" }, { runId: "r" })).toBeUndefined();
  });

  it("A8 regression (laptop Nov 13): claim runs BEFORE before_model_resolve -> it logs decision + result itself", async () => {
    const x = setup({ privateWhenLocalDown: "held" }, { isLocalHealthy: () => false });
    const claim = (await x.claim({ cleanedBody: PRIVATE }, { runId: "r9" })) as { handled: boolean };
    expect(claim.handled).toBe(true);
    const [dec, res] = x.parsed();
    expect(dec).toMatchObject({ kind: "route_decision", requestId: "r9", target: "held", model: "none", via: "fixed", localHealthy: false });
    expect(dec.signals).toContain("privacy:word");
    expect(res).toMatchObject({ kind: "route_result", requestId: "r9", target: "held", ok: false });
  });

  it("A8: claim-first for a normal turn logs nothing (before_model_resolve decides and logs once)", async () => {
    const x = setup();
    expect(await x.claim({ cleanedBody: "What is 12 times 9?" }, { runId: "r" })).toBeUndefined();
    expect(x.lines).toHaveLength(0);
    await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "r" });
    expect(x.parsed().filter((l) => l.kind === "route_decision")).toHaveLength(1);
  });

  it("long chat + private (claim runs first, as in OpenClaw): held, /new reply, decision + result logged, no model", async () => {
    const x = setup();
    x.output({ sessionId: "s1", usage: { input: 25000, output: 500, total: 25500 } }, {});
    const claim = (await x.claim({ cleanedBody: PRIVATE }, { runId: "lh1", sessionId: "s1" })) as { handled: boolean; reply: { text: string } };
    expect(claim.handled).toBe(true);
    expect(claim.reply.text).toMatch(/too long for the private local model/);
    expect(claim.reply.text).toMatch(/\/new/);
    const [dec, res] = x.parsed();
    expect(dec).toMatchObject({ kind: "route_decision", requestId: "lh1", target: "held", model: "none", rule: "privacy-long-context", sessionSizeEst: 25500 });
    expect(res).toMatchObject({ kind: "route_result", requestId: "lh1", target: "held", ok: false, error: "held" });
  });
  it("long chat + private when before_model_resolve runs first: pinned to local (never cloud), then the claim answers", async () => {
    const x = setup();
    x.output({ sessionId: "s2", usage: { input: 25000, output: 500, total: 25500 } }, {});
    expect(await x.resolve({ prompt: PRIVATE }, { runId: "lh2", sessionId: "s2" })).toEqual(GEMMA);
    const claim = (await x.claim({ cleanedBody: PRIVATE }, { runId: "lh2", sessionId: "s2" })) as { reply: { text: string } };
    expect(claim.reply.text).toMatch(/Send \/new/);
  });
  it("long chat + NON-private message: claim does nothing (long-context -> cloud as before)", async () => {
    const x = setup();
    x.output({ sessionId: "s3", usage: { input: 25000, output: 500, total: 25500 } }, {});
    expect(await x.claim({ cleanedBody: "What is 12 times 9?" }, { runId: "lh3", sessionId: "s3" })).toBeUndefined();
    expect(await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "lh3", sessionId: "s3" })).toEqual(CHATGPT);
  });
  it("custom longContextHeldReply from config; the local-down held reply is unchanged", async () => {
    const x = setup({ longContextHeldReply: "Too long: /new please." });
    x.output({ sessionId: "s4", usage: { input: 25000, output: 500, total: 25500 } }, {});
    expect(((await x.claim({ cleanedBody: PRIVATE }, { runId: "lh4", sessionId: "s4" })) as { reply: { text: string } }).reply.text).toBe("Too long: /new please.");
    expect(readRouterConfig({}).longContextHeldReply).toMatch(/too long/);
  });

  it("A8: custom held reply from config", async () => {
    const x = setup({ heldReply: "Held: local model offline.", privateWhenLocalDown: "held" }, { isLocalHealthy: () => false });
    await x.resolve({ prompt: PRIVATE }, { runId: "r" });
    expect(((await x.claim({ cleanedBody: PRIVATE }, { runId: "r" })) as { reply: { text: string } }).reply.text).toBe("Held: local model offline.");
  });

  it("A9: route_result after agent_end: served model from the last model call, same requestId", async () => {
    const x = setup();
    await x.resolve({ prompt: "Explain step by step why the sky is blue." }, { runId: "r2" });
    await x.callEnded({ runId: "r2", provider: "openai", model: "gpt-6-astra", outcome: "completed", durationMs: 900 }, {});
    x.tick(7300); // latency = decision -> end of the successful attempt (agent_end.durationMs is per attempt)
    await x.end({ runId: "r2", success: true, durationMs: 43 }, { runId: "r2" });
    const [dec, res] = x.parsed();
    expect(res.requestId).toBe(dec.requestId);
    expect(res).toMatchObject({ kind: "route_result", rule: "reasoning-heavy", target: "cloud", servedModel: "openai/gpt-6-astra", ok: true, latencyMs: 7300, error: null });
  });

  it("A9 regression (laptop trace Nov 13): agent_end success:true after a FAILED call is not a success", async () => {
    vi.useFakeTimers();
    try {
      const x = setup({}, { failureQuietMs: 45000 });
      await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "r" });
      for (let i = 0; i < 3; i++) { // OpenClaw retries: each attempt = failed call + agent_end success:true
        await x.callEnded({ runId: "r", provider: "ollama", model: "gemma4-a3:e2b", outcome: "error", errorCategory: "Error" }, {});
        await x.end({ runId: "r", success: true, durationMs: 20 }, { runId: "r" });
        x.tick(10000);
        await vi.advanceTimersByTimeAsync(10000); // retry gap < quiet period: still no result
      }
      expect(x.parsed().filter((l) => l.kind === "route_result")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(45000); // no new attempt: final failure
      const res = x.parsed().filter((l) => l.kind === "route_result");
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({ servedModel: "ollama/gemma4-a3:e2b", ok: false, error: "Error" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("A9: a transient failure followed by a successful retry logs ONE ok result", async () => {
    vi.useFakeTimers();
    try {
      const x = setup({}, { failureQuietMs: 45000 });
      await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "r" });
      await x.callEnded({ runId: "r", provider: "ollama", model: "gemma4-a3:e2b", outcome: "error", errorCategory: "timeout" }, {});
      await x.end({ runId: "r", success: true }, { runId: "r" });
      await vi.advanceTimersByTimeAsync(5000);
      await x.callEnded({ runId: "r", provider: "ollama", model: "gemma4-a3:e2b", outcome: "completed" }, {});
      await x.end({ runId: "r", success: true }, { runId: "r" });
      await vi.advanceTimersByTimeAsync(60000);
      const res = x.parsed().filter((l) => l.kind === "route_result");
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({ ok: true, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("A9: failure error is a short code, never error text", async () => {
    vi.useFakeTimers();
    try {
      const x = setup({}, { failureQuietMs: 1000 });
      await x.resolve({ prompt: "What is 12 times 9?" }, { runId: "r" });
      await x.end({ runId: "r", success: false, error: "Ollama said: my locker code is 4711" }, { runId: "r" });
      await vi.advanceTimersByTimeAsync(1500);
      expect(x.parsed()[1]).toMatchObject({ ok: false, error: "agent_error", servedModel: "none" });
      expect(x.lines.join("")).not.toContain("4711");
    } finally {
      vi.useRealTimers();
    }
  });

  it("A9: agent_end for a run the router never saw logs nothing", async () => {
    const x = setup();
    await x.end({ runId: "other", success: true }, { runId: "other" });
    expect(x.lines).toHaveLength(0);
  });

  it("A9: simulateRateLimit from plugin config: reasoning goes local, logged", async () => {
    const x = setup({ simulateRateLimit: true });
    expect(await x.resolve({ prompt: "Explain step by step why the sky is blue." }, { runId: "r" })).toEqual(GEMMA);
    expect(x.parsed()[0]).toMatchObject({ rule: "cloud-rate-limited", target: "local", rateLimitSimulated: true });
  });

  it("A9: rate limit + local down -> target none, claimed with the unavailable reply", async () => {
    const x = setup({ simulateRateLimit: true }, { isLocalHealthy: () => false });
    await x.resolve({ prompt: "Explain step by step why the sky is blue." }, { runId: "r" });
    const claim = (await x.claim({ cleanedBody: "x" }, { runId: "r" })) as { handled: boolean; reply: { text: string } };
    expect(claim.reply.text).toMatch(/cloud model is unavailable/);
    expect(x.parsed()[1]).toMatchObject({ kind: "route_result", target: "none", ok: false, error: "cloud-unavailable" });
  });

  it("A9: a config edit re-runs register; the new registration sees the new value", async () => {
    const off = setup({ simulateRateLimit: false });
    await off.resolve({ prompt: "Explain step by step why." }, { runId: "a" });
    const on = setup({ simulateRateLimit: true });
    await on.resolve({ prompt: "Explain step by step why." }, { runId: "b" });
    expect(off.parsed()[0].rule).toBe("reasoning-heavy");
    expect(on.parsed()[0].rule).toBe("cloud-rate-limited");
  });
});

describe("readRouterConfig", () => {
  it("defaults", () => {
    expect(readRouterConfig(undefined)).toMatchObject({
      ollamaUrl: "http://127.0.0.1:11434", healthCheck: true, simulateRateLimit: false, logMirrorFile: undefined,
    });
  });
  it("ollamaUrl wins over the old classifierUrl; non-loopback refused", () => {
    expect(readRouterConfig({ ollamaUrl: "http://127.0.0.1:11435", classifierUrl: "http://127.0.0.1:1" }).ollamaUrl).toBe("http://127.0.0.1:11435");
    expect(readRouterConfig({ ollamaUrl: "http://10.0.0.5:11434" }).ollamaUrl).toBe("http://127.0.0.1:11434");
  });
  it("privateWhenLocalDown: 'held' only when exactly 'held', else cloud", () => {
    expect(readRouterConfig(undefined).privateWhenLocalDown).toBe("cloud");
    expect(readRouterConfig({ privateWhenLocalDown: "held" }).privateWhenLocalDown).toBe("held");
    expect(readRouterConfig({ privateWhenLocalDown: "HELD" }).privateWhenLocalDown).toBe("cloud");
  });
  it("simulateRateLimit only when exactly true", () => {
    expect(readRouterConfig({ simulateRateLimit: "yes" }).simulateRateLimit).toBe(false);
  });
});

// ---- Follow-up rule inside the plugin (Nov 14) ----
describe("follow-up: plugin flow", () => {
  function setupFU(
    category: string,
    verdict: boolean | null,
    pluginConfig: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ) {
    const lines: string[] = [];
    const asked: { question: string; message: string }[] = [];
    const { api, calls } = fakeApi({ healthCheck: false, ...pluginConfig });
    let t = 1_000_000;
    registerRouter(api as never, (l) => lines.push(l), {
      now: () => t,
      classify: async () => ({ category, ms: 100 }),
      checkFollowup: async (question: string, message: string) => {
        asked.push({ question, message });
        return verdict === null ? { followup: null, ms: 2000, error: "timeout" } : { followup: verdict, ms: 120 };
      },
      ...options,
    } as never);
    const h = (name: string) => calls.find((c) => c.name === name)!.handler;
    const decisions = () => lines.map((l) => JSON.parse(l)).filter((l) => l.kind === "route_decision");
    return {
      resolve: h("before_model_resolve"), output: h("llm_output"), lines, asked, decisions,
      advance: (ms: number) => { t += ms; },
    };
  }

  // Turn 1: a calendar request routed to ChatGPT that ends with a question.
  async function cloudQuestion(s: ReturnType<typeof setupFU>, reply = "Sure. Which time zone, and what should I name them?") {
    await s.resolve({ prompt: "Create two events in my calendar today at 3:30 and 4:30" }, { runId: "r1", sessionId: "s1" });
    s.output({ runId: "r1", sessionId: "s1", assistantTexts: [reply], usage: { total: 14000 } }, {});
  }

  it("Telegram case: the answer goes to the cloud as follow-up (Gemma verified), log has the verdict", async () => {
    const s = setupFU("simple", true);
    await cloudQuestion(s);
    s.advance(30_000);
    expect(await s.resolve({ prompt: "Pacific Time and Name it to Test 1 and Test 2" }, { runId: "r2", sessionId: "s1" })).toEqual(CHATGPT);
    expect(s.decisions()[1]).toMatchObject({
      rule: "follow-up", target: "cloud", via: "gemma", followupCandidate: true, followupVerdict: true, followupMs: 120, followupError: null,
    });
    expect(s.asked).toEqual([{ question: "Sure. Which time zone, and what should I name them?", message: "Pacific Time and Name it to Test 1 and Test 2" }]);
  });

  it("Gemma says it's a new request -> normal routing (local)", async () => {
    const s = setupFU("simple", false);
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "What is the capital of France?" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(s.decisions()[1]).toMatchObject({ rule: "simple-task", followupCandidate: true, followupVerdict: false });
  });

  it("Gemma times out -> heuristic follow-up for an answer, normal routing for a calculation", async () => {
    const s = setupFU("simple", null);
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "yes please" }, { runId: "r2", sessionId: "s1" })).toEqual(CHATGPT);
    expect(s.decisions()[1]).toMatchObject({ rule: "follow-up", via: "heuristic", followupVerdict: null, followupError: "timeout" });
    s.output({ runId: "r2", sessionId: "s1", assistantTexts: ["Done. Anything else?"] }, {});
    expect(await s.resolve({ prompt: "What is 12 times 9?" }, { runId: "r3", sessionId: "s1" })).toEqual(GEMMA);
  });

  it("no question in the cloud reply -> not a candidate, Gemma check never asked", async () => {
    const s = setupFU("simple", true);
    await cloudQuestion(s, "Done. Both events are in your calendar.");
    expect(await s.resolve({ prompt: "great" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(s.decisions()[1]).toMatchObject({ followupCandidate: false, followupVerdict: null });
    expect(s.asked).toEqual([]);
  });

  it("after the 5-minute window, or in another chat (/new), normal routing", async () => {
    const s = setupFU("simple", true);
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "Pacific" }, { runId: "x", sessionId: "s2" })).toEqual(GEMMA);
    s.advance(300_001);
    expect(await s.resolve({ prompt: "Pacific" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(s.asked).toEqual([]);
  });

  it("a local turn that asked a question never makes a candidate", async () => {
    const s = setupFU("simple", true);
    await s.resolve({ prompt: "Hi!" }, { runId: "r1", sessionId: "s1" }); // local
    s.output({ runId: "r1", sessionId: "s1", assistantTexts: ["Hello! How can I help?"] }, {});
    expect(await s.resolve({ prompt: "tell me a joke" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(s.asked).toEqual([]);
  });

  it("privacy wins: a private answer stays local and Gemma's follow-up check is not even asked", async () => {
    const s = setupFU("simple", true);
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "my password is hunter2" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(s.decisions()[1]).toMatchObject({ rule: "privacy-sensitive", followupCandidate: true });
    expect(s.asked).toEqual([]);
  });

  it("classifier off -> no Gemma check, heuristic follow-up", async () => {
    const s = setupFU("simple", true, { classifier: false });
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "Pacific Time" }, { runId: "r2", sessionId: "s1" })).toEqual(CHATGPT);
    expect(s.decisions()[1]).toMatchObject({ rule: "follow-up", via: "heuristic" });
    expect(s.asked).toEqual([]);
  });

  it("followupWindowMs 0 turns the rule off; invalid values fall back to 5 min", async () => {
    const s = setupFU("simple", true, { followupWindowMs: 0 });
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "Pacific Time" }, { runId: "r2", sessionId: "s1" })).toEqual(GEMMA);
    expect(readRouterConfig({ followupWindowMs: -1 }).followupWindowMs).toBe(300000);
    expect(readRouterConfig({ followupWindowMs: "x" }).followupWindowMs).toBe(300000);
    expect(readRouterConfig({}).followupWindowMs).toBe(300000);
  });

  it("a throwing follow-up check never breaks routing", async () => {
    const s = setupFU("simple", true, {}, { checkFollowup: () => { throw new Error("boom"); } });
    await cloudQuestion(s);
    expect(await s.resolve({ prompt: "Pacific Time" }, { runId: "r2", sessionId: "s1" })).toEqual(CHATGPT);
    expect(s.decisions()[1]).toMatchObject({ rule: "follow-up", via: "heuristic", followupError: "network" });
  });

  it("logs never contain the question or the message", async () => {
    const s = setupFU("simple", true);
    await cloudQuestion(s, "Should I call it Bluebird?");
    await s.resolve({ prompt: "yes, Bluebird" }, { runId: "r2", sessionId: "s1" });
    expect(s.lines.join("")).not.toMatch(/bluebird/i);
  });
});
