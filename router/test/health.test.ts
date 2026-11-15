// Unit tests for router/src/health.ts (Lesson A7). Written by the assistant (student decision Nov 12).
// Spec (ROUTER_SPEC.md "Health poller"): every 10 s, 3 s timeout, 2 failures -> down, 1 success -> up,
// log only on change, cached state, cleanup on stop. fetch is faked; no real Ollama.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nextHealth, startHealthPoller, type HealthTransition } from "../src/health.ts";

describe("nextHealth: the debounce rule (pure)", () => {
  it("unknown + success -> up (change)", () => {
    expect(nextHealth({ state: "unknown", failures: 0 }, true)).toEqual({ tracker: { state: "up", failures: 0 }, changed: true });
  });
  it("unknown + failure -> down at once (never seen up, nothing to debounce)", () => {
    expect(nextHealth({ state: "unknown", failures: 0 }, false)).toEqual({ tracker: { state: "down", failures: 1 }, changed: true });
  });
  it("up + 1 failure -> still up (one blip is not an outage)", () => {
    expect(nextHealth({ state: "up", failures: 0 }, false)).toEqual({ tracker: { state: "up", failures: 1 }, changed: false });
  });
  it("up + 2nd failure in a row -> down", () => {
    expect(nextHealth({ state: "up", failures: 1 }, false)).toEqual({ tracker: { state: "down", failures: 2 }, changed: true });
  });
  it("a success resets the failure count", () => {
    expect(nextHealth({ state: "up", failures: 1 }, true)).toEqual({ tracker: { state: "up", failures: 0 }, changed: false });
  });
  it("down + 1 success -> up", () => {
    expect(nextHealth({ state: "down", failures: 5 }, true).tracker.state).toBe("up");
  });
  it("down + more failures -> no new change", () => {
    expect(nextHealth({ state: "down", failures: 2 }, false).changed).toBe(false);
  });
});

// A fake Ollama whose availability the test switches.
function fakeOllama() {
  const s = { up: true, calls: 0, urls: [] as string[], hang: false, inFlight: 0, maxInFlight: 0 };
  const impl = (async (url: string, init?: RequestInit) => {
    s.calls++;
    s.urls.push(url);
    if (s.hang) {
      s.inFlight++;
      s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      return new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener("abort", () => { s.inFlight--; rej(init.signal!.reason); }));
    }
    if (!s.up) throw new TypeError("fetch failed");
    return new Response('{"models":[]}', { status: 200 });
  }) as unknown as typeof fetch;
  return { s, impl };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("startHealthPoller (fake timers)", () => {
  afterEach(() => vi.useRealTimers());

  it("probes right away and every 10 s; GET <base>/api/tags", async () => {
    vi.useFakeTimers();
    const o = fakeOllama();
    const p = startHealthPoller("http://127.0.0.1:11434", () => {}, { fetchImpl: o.impl });
    await flush();
    expect(o.s.calls).toBe(1);
    expect(o.s.urls[0]).toBe("http://127.0.0.1:11434/api/tags");
    await vi.advanceTimersByTimeAsync(30000);
    expect(o.s.calls).toBe(4);
    p.stop();
  });

  it("Ollama quit: 'down' within 2 probes (~20 s), logged once; back: 'up' on the next probe", async () => {
    vi.useFakeTimers();
    const o = fakeOllama();
    const changes: HealthTransition[] = [];
    const p = startHealthPoller("http://x", (t) => changes.push(t), { fetchImpl: o.impl });
    await flush();
    expect(p.isHealthy()).toBe(true);
    expect(changes).toEqual([{ from: "unknown", to: "up", failures: 0 }]);

    o.s.up = false;
    await vi.advanceTimersByTimeAsync(10000); // 1st failure
    expect(p.isHealthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(10000); // 2nd failure -> down
    expect(p.isHealthy()).toBe(false);
    await vi.advanceTimersByTimeAsync(30000); // still down: no new lines
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({ from: "up", to: "down", failures: 2, error: "network" });

    o.s.up = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(p.isHealthy()).toBe(true);
    expect(changes[2]).toEqual({ from: "down", to: "up", failures: 0 });
    p.stop();
  });

  it("a hanging Ollama counts as a failure after the timeout, and probes never overlap (real time)", async () => {
    // AbortSignal.timeout uses Node's internal timer, which fake timers don't control: real time, short values.
    const o = fakeOllama();
    o.s.hang = true;
    const changes: HealthTransition[] = [];
    const p = startHealthPoller("http://x", (t) => changes.push(t), { fetchImpl: o.impl, intervalMs: 50, timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 400));
    expect(o.s.maxInFlight).toBe(1); // ticks during a hanging probe never start a second one
    expect(o.s.calls).toBeLessThanOrEqual(2); // 0-300 ms probe 1 (times out), then at most one more
    expect(changes[0]).toMatchObject({ to: "down", error: "timeout" });
    p.stop();
  });

  it("HTTP error status is a failure with a short code", async () => {
    vi.useFakeTimers();
    const impl = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    const changes: HealthTransition[] = [];
    const p = startHealthPoller("http://x", (t) => changes.push(t), { fetchImpl: impl });
    await flush();
    expect(changes[0]).toMatchObject({ to: "down", error: "http_502" });
    p.stop();
  });

  it("stop() ends probing; isHealthy is cached (no network call)", async () => {
    vi.useFakeTimers();
    const o = fakeOllama();
    const p = startHealthPoller("http://x", () => {}, { fetchImpl: o.impl });
    await flush();
    p.stop();
    const before = o.s.calls;
    for (let i = 0; i < 100; i++) p.isHealthy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(o.s.calls).toBe(before);
  });

  it("a throwing onChange does not stop the poller", async () => {
    vi.useFakeTimers();
    const o = fakeOllama();
    const p = startHealthPoller("http://x", () => { throw new Error("log broken"); }, { fetchImpl: o.impl });
    await flush();
    o.s.up = false;
    await vi.advanceTimersByTimeAsync(20000);
    expect(p.state()).toBe("down");
    p.stop();
  });
});
