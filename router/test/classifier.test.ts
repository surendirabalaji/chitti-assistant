// Unit tests for router/src/classifier.ts (router v2). Written by the assistant (student decision Nov 12).
// fetch is faked: these tests never call a real Ollama.
import { describe, it, expect } from "vitest";
import { classify, CLASSIFIER_SYSTEM, type ClassifierOptions } from "../src/classifier.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (content: string) => new Response(JSON.stringify({ message: { content } }), { status: 200 });
const opts = (fetchImpl: typeof fetch, over: Partial<ClassifierOptions> = {}): ClassifierOptions => ({
  baseUrl: "http://127.0.0.1:11434", model: "gemma4-a3:e2b", timeoutMs: 500, numCtx: 32768, fetchImpl, ...over,
});

describe("request shape", () => {
  it("POSTs /api/chat with the measured prompt, same num_ctx, think off, JSON schema, purpose header", async () => {
    const f = fakeFetch(() => ok('{"category":"simple"}'));
    await classify("Name a planet.", opts(f.impl));
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({
      model: "gemma4-a3:e2b", stream: false, think: false,
      options: { num_ctx: 32768, temperature: 0 },
      messages: [{ role: "system", content: CLASSIFIER_SYSTEM }, { role: "user", content: "Name a planet." }],
    });
    expect(body.format.properties.category.enum).toEqual(["simple", "reasoning", "tool", "private"]);
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-a3-purpose"]).toBe("route-classify");
  });

  it("caps very long messages at 2000 chars", async () => {
    const f = fakeFetch(() => ok('{"category":"reasoning"}'));
    await classify("a".repeat(5000), opts(f.impl));
    expect(JSON.parse(String(f.calls[0]!.init.body)).messages[1].content).toHaveLength(2000);
  });
});

describe("results", () => {
  it.each(["simple", "reasoning", "tool", "private"])("valid label %s", async (c) => {
    const r = await classify("x", opts(fakeFetch(() => ok(`{"category":"${c}"}`)).impl));
    expect(r.category).toBe(c);
    expect(r.error).toBeUndefined();
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["unknown label", '{"category":"maybe"}', "invalid"],
    ["not JSON", "simple", "invalid"],
    ["missing field", "{}", "invalid"],
  ])("%s -> null (%s)", async (_l, content, error) => {
    const r = await classify("x", opts(fakeFetch(() => ok(content)).impl));
    expect(r).toMatchObject({ category: null, error });
  });

  it("HTTP error (e.g. forwarder 502 when the laptop is off) -> null http_502", async () => {
    const r = await classify("x", opts(fakeFetch(() => new Response("{}", { status: 502 })).impl));
    expect(r).toMatchObject({ category: null, error: "http_502" });
  });

  it("network failure -> null network", async () => {
    const r = await classify("x", opts(fakeFetch(() => { throw new TypeError("fetch failed"); }).impl));
    expect(r).toMatchObject({ category: null, error: "network" });
  });

  it("slow model -> null timeout, returns near the time limit", async () => {
    const slow = fakeFetch((call) => new Promise<Response>((_res, rej) => {
      call.init.signal?.addEventListener("abort", () => rej(call.init.signal!.reason));
    }));
    const r = await classify("x", opts(slow.impl, { timeoutMs: 100 }));
    expect(r).toMatchObject({ category: null, error: "timeout" });
    expect(r.ms).toBeLessThan(1000);
  });
});

// ---- Follow-up check (Nov 14) ----
import { checkFollowup, FOLLOWUP_SYSTEM } from "../src/classifier.ts";

describe("checkFollowup", () => {
  it("sends the question tail + message to local Gemma with a boolean schema and its own purpose header", async () => {
    const f = fakeFetch(() => ok('{"followup":true}'));
    const r = await checkFollowup("x".repeat(1000) + "Which time zone?", "Pacific time", opts(f.impl));
    expect(r).toMatchObject({ followup: true });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.messages[0]).toEqual({ role: "system", content: FOLLOWUP_SYSTEM });
    expect(body.messages[1].content).toContain("Which time zone?");
    expect(body.messages[1].content).toContain("Pacific time");
    expect(body.messages[1].content.length).toBeLessThan(600); // question capped at 400 chars
    expect(body.format.properties.followup.type).toBe("boolean");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-a3-purpose"]).toBe("route-followup");
  });
  it("false is passed through", async () => {
    const f = fakeFetch(() => ok('{"followup":false}'));
    expect((await checkFollowup("Which one?", "what's 2+2", opts(f.impl))).followup).toBe(false);
  });
  it("invalid / http error / timeout -> null with a code", async () => {
    expect(await checkFollowup("q?", "m", opts(fakeFetch(() => ok('{"followup":"yes"}')).impl))).toMatchObject({ followup: null, error: "invalid" });
    expect(await checkFollowup("q?", "m", opts(fakeFetch(() => ok("not json")).impl))).toMatchObject({ followup: null, error: "invalid" });
    expect(await checkFollowup("q?", "m", opts(fakeFetch(() => new Response("", { status: 500 })).impl))).toMatchObject({ followup: null, error: "http_500" });
    const slow = fakeFetch((c) => new Promise((_, rej) => c.init.signal!.addEventListener("abort", () => rej(c.init.signal!.reason))));
    expect(await checkFollowup("q?", "m", opts(slow.impl, { timeoutMs: 100 }))).toMatchObject({ followup: null, error: "timeout" });
  });
});
