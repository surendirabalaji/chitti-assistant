// Ollama health poller (Lesson A7). Written by the assistant at the student's request (Nov 13).
// Every 10 s: GET <ollama>/api/tags with a 3 s timeout. Two failures in a row -> down, one success -> up.
// The router reads the cached value only (isHealthy() never touches the network).

export type HealthState = "unknown" | "up" | "down";

export interface HealthTransition {
  from: HealthState;
  to: HealthState;
  failures: number; // consecutive failures at the moment of the change
  error?: string; // short code of the last failure
}

// Pure state machine, so the debounce rule can be tested without timers or network.
export interface HealthTracker {
  state: HealthState;
  failures: number;
}

export function nextHealth(
  t: HealthTracker,
  ok: boolean,
  failuresToDown = 2,
): { tracker: HealthTracker; changed: boolean } {
  if (ok) {
    return { tracker: { state: "up", failures: 0 }, changed: t.state !== "up" };
  }
  const failures = t.failures + 1;
  // From "unknown" one failure is enough: we never saw it up, so there is nothing to debounce.
  const down = t.state === "unknown" || failures >= failuresToDown;
  const state: HealthState = down ? "down" : t.state;
  return { tracker: { state, failures }, changed: state !== t.state };
}

export interface PollerOptions {
  intervalMs?: number; // default 10000
  timeoutMs?: number; // default 3000
  failuresToDown?: number; // default 2
  fetchImpl?: typeof fetch;
}

export interface HealthPoller {
  isHealthy(): boolean; // false while "unknown" or "down"
  state(): HealthState;
  checkNow(): Promise<void>; // one probe now (also used by tests)
  stop(): void;
}

function errorCode(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

export function startHealthPoller(
  baseUrl: string,
  onChange: (t: HealthTransition) => void,
  opts: PollerOptions = {},
): HealthPoller {
  const intervalMs = opts.intervalMs ?? 10000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const failuresToDown = opts.failuresToDown ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;
  let tracker: HealthTracker = { state: "unknown", failures: 0 };
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const probe = async (): Promise<void> => {
    let ok = false;
    let error: string | undefined;
    try {
      const res = await doFetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      ok = res.ok;
      if (!ok) error = `http_${res.status}`;
      await res.body?.cancel().catch(() => {}); // we only need the status
    } catch (err) {
      error = errorCode(err);
    }
    if (stopped) return;
    const from = tracker.state;
    const next = nextHealth(tracker, ok, failuresToDown);
    tracker = next.tracker;
    if (next.changed) {
      try {
        onChange({ from, to: tracker.state, failures: tracker.failures, ...(ok ? {} : { error }) });
      } catch {
        // a broken logger must not stop the poller
      }
    }
  };

  const checkNow = (): Promise<void> => {
    // Never overlap probes: a slow probe (up to timeoutMs) can't pile up behind the interval.
    if (!inFlight) inFlight = probe().finally(() => (inFlight = null));
    return inFlight;
  };

  const timer = setInterval(() => void checkNow(), intervalMs);
  timer.unref?.(); // never keep the process alive just for health checks
  void checkNow(); // first answer right away, not after 10 s

  return {
    isHealthy: () => tracker.state === "up",
    state: () => tracker.state,
    checkNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
