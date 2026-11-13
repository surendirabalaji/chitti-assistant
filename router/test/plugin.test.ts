// Unit tests for router/src/plugin.ts (Lesson A4).
// Written by the assistant (student decision Nov 12: the assistant writes unit tests).
// plugin.ts must NOT import "openclaw": these tests run without OpenClaw installed here.
// index.ts (the thin definePluginEntry wrapper) is verified by installing the plugin, not here.
//
// Facts these tests rely on (STATUS.md "Plugin API", read from OpenClaw 2026.10.9):
//   - before_model_resolve event: { prompt: string; attachments?: [...] }
//   - result: { providerOverride?: string; modelOverride?: string }  (two separate fields)
//   - a throwing handler is logged and the turn falls back to the default model
import { describe, it, expect } from "vitest";
import { toOverride, registerRouter } from "../src/plugin.ts";

const GEMMA = { providerOverride: "ollama", modelOverride: "gemma4-a3:e2b" };
const CHATGPT = { providerOverride: "openai", modelOverride: "gpt-6-astra" };

type Handler = (event: unknown, ctx: unknown) => unknown;

// A fake of the one piece of OpenClaw's api that registerRouter uses.
function fakeApi() {
  const calls: { name: string; handler: Handler; opts?: unknown }[] = [];
  return {
    calls,
    api: {
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

  it.todo("A8: held -> what override? (decide: no override vs. force local so it can never reach cloud)");
});

describe("registerRouter: hook registration", () => {
  it("registers exactly one before_model_resolve handler", () => {
    const { api, calls } = fakeApi();
    registerRouter(api as never);
    expect(calls.filter((c) => c.name === "before_model_resolve")).toHaveLength(1);
  });

  it("registers no other hooks yet (A4 scope)", () => {
    const { api, calls } = fakeApi();
    registerRouter(api as never);
    expect(calls.map((c) => c.name)).toEqual(["before_model_resolve"]);
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
