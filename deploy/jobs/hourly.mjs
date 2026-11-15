// Hourly evidence (M6): one health line per hour for the 48-hour run, independent of chat traffic.
// Command job (no model call), delivery "none": checks that the laptop's Ollama answers through the
// forwarder (same path the router uses) and writes one a3-ops line, which startup.sh tails to stdout
// -> Cloud Logging. The cloud half of the evidence is a separate hourly agent-turn job (install-jobs.sh)
// whose route_decision/route_result lines come from the router.
// Assistant-written at the student's request (Nov 14).
import { logOps } from "./lib.mjs";

const FORWARDER = process.env.A3_FORWARDER_URL ?? "http://127.0.0.1:11435";

/**
 * GET <base>/api/tags with a timeout. Never throws.
 * @returns {Promise<{ local: "up" | "down", status?: number, latencyMs: number, models?: number, error?: string }>}
 */
export async function checkLocal(base = FORWARDER, { timeoutMs = 5000, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const t0 = now();
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = now() - t0;
    if (!res.ok) return { local: "down", status: res.status, latencyMs, error: `http-${res.status}` };
    let models;
    try {
      const body = await res.json();
      if (Array.isArray(body?.models)) models = body.models.length;
    } catch {
      // a 200 with a non-JSON body still means something answered
    }
    return { local: "up", status: res.status, latencyMs, ...(models === undefined ? {} : { models }) };
  } catch (err) {
    const name = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "unreachable";
    return { local: "down", latencyMs: now() - t0, error: name };
  }
}

// Seconds since startup.sh began (A3_BOOT_TS = epoch seconds, exported by startup.sh); null if unknown.
export function uptimeSec(bootTs = process.env.A3_BOOT_TS, nowMs = Date.now()) {
  const boot = Number(bootTs);
  if (!Number.isFinite(boot) || boot <= 0) return null;
  return Math.max(0, Math.round(nowMs / 1000 - boot));
}

export function summary(r, up) {
  const h = up === null ? "?" : (up / 3600).toFixed(1);
  return r.local === "up"
    ? `hourly: local up (${r.latencyMs} ms), uptime ${h} h`
    : `hourly: local down (${r.error}), uptime ${h} h`;
}

if (import.meta.main) {
  const r = await checkLocal();
  const up = uptimeSec();
  logOps("hourly", { ...r, uptimeSec: up });
  // Kept in the job's run history (delivery none); a down laptop is a fact to record, not a job failure.
  process.stdout.write(summary(r, up) + "\n");
}
