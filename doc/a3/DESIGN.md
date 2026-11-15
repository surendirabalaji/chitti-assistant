# System design (summary)

Full visual version: `doc/a3/design-and-plan.html` (where it says E4B, read E2B — see STATUS.md).

## Architecture

- **Laptop (MacBook M4, 16 GB):** Ollama app on `127.0.0.1:11434` serving `gemma4-a3:e2b`; Tailscale Serve exposes it on the tailnet as `tcp:11434`. The laptop runs **no OpenClaw in production**; laptop OpenClaw is a test bench only.
- **Cloud Run Instance (one container, non-root):**
  - `tailscaled` in userspace mode with SOCKS5 on `127.0.0.1:1055`, state stored on the bucket (stable machine name `a3-cloud-agent`).
  - Tailscale Serve `:443 → 127.0.0.1:18789` (OpenClaw gateway) for you and graders.
  - OpenClaw gateway: dashboard, Telegram channel, agent `main`, skills, cron, exec approvals, **router plugin**.
  - **Ollama forwarder** on `127.0.0.1` → laptop via `socks5h://127.0.0.1:1055`; logs every completed call. OpenClaw's ollama provider `baseUrl` points at the forwarder. Cloud traffic never uses it.
  - `send-email` wrapper: the only send path.
  - Snapshot agent and health poller; structured JSON logs to stdout → Cloud Logging.
- **External:** ChatGPT (Codex runtime inside OpenClaw), Telegram, Gmail + Google Calendar (throwaway), weather + web search, Cloud Storage bucket, Secret Manager, Cloud Logging.

## Routing (first match wins)

> **Router v2 (Nov 13):** privacy and the other fixed checks below stay rule-based; the task category (simple/reasoning/tool) comes from a local Gemma label when available, else a scoring fallback. Details and measurements: ROUTER_SPEC.md "Router v2 (layered)".


| # | Rule | Condition | Local up | Local down |
|---|---|---|---|---|
| 1 | `privacy-sensitive` | privacy keyword in the user's message | local | **cloud fallback** (`privacy-local-unavailable`, ChatGPT); `held` if plugin config `privateWhenLocalDown: "held"` |
| 2 | `long-context` | session size estimate > threshold (set after measuring the base prompt) | cloud | cloud |
| 3 | `tool-task` | email/inbox/calendar/meeting/schedule/search/weather words, or a cron turn | cloud | cloud |
| 4 | `reasoning-heavy` | step by step, explain why, analyze, compare, plan, or > 400 chars | cloud | cloud |
| 5 | `simple-task` | ≤ 200 chars and none of the above | local | cloud (`local-unavailable`) |
| 6 | `default-cloud` | anything else | cloud | cloud |

- Simulated rate limit flag: rules 3–6 go local if healthy (`cloud-rate-limited`), else reply "cloud unavailable".
- **Policy change (Nov 13, student decision):** private task while local is down → **cloud fallback** (course Local Gemma guide Part 0 req. 3: held or cloud, both acceptable; README must state it and logs must match). Switchable back to held with `privateWhenLocalDown: "held"`. The held path below remains for that setting and for rate-limit + local down (`target none`).
- Held reply (held setting only): "The local model is off and can't be reached right now, so this private request was held and not sent to any model. Please try again when it's back." Nothing is queued.
- **Stated assumption (held semantics, applies only with the held setting):** "held" means the private request is not sent to any model, the user gets the held reply right away, and a `route_decision` log line records `target: "held"`, `model: "none"`, `ok: false`. The request is not queued or replayed when the local model comes back; the user resends it. The README states this assumption explicitly.
- Timeouts: Gemma 120 s (cold load 24–49 s); one retry only if health is still up. No silent cross-route fallback; OpenClaw model failover disabled.
- **Utility model (Nov 13):** OpenClaw's title/narration/recap calls bypass the router and carry message text; `agents.defaults.utilityModel = ollama/gemma4-a3:e2b` keeps them on the laptop (they fail while it's off). Verified: a held turn makes no model call.
- README privacy statement (cloud-fallback policy): private requests are processed by local Gemma when it is reachable; when it is not, they are answered by ChatGPT (logged as `privacy-local-unavailable`, target cloud). Do **not** claim private requests never reach the cloud. Also: the cloud container still orchestrates the turn, stores the conversation in snapshots, and logs metadata without message text.

## Video prompt check
"What is 12 times 9?" → rule 5 local. "Explain step by step why the sky is blue." → rule 4 cloud. "This is confidential: remind me my locker code is on a sticky note." (Ollama off) → rule 1 cloud fallback (held with the held setting). "This is confidential: say "back online" in three words." → rule 1 local.

## State and concurrency
- Live state on container disk (`~/.openclaw`: config, SQLite stores, sessions, cron, workspace files).
- Snapshot every 5 min to the bucket (newest + previous), SQLite via backup API, temp object then replace, single writer. Final snapshot on SIGTERM.
- ChatGPT auth store copied to the bucket **immediately on change** (single-use refresh tokens).
- Restore before the gateway starts; log `state-restored` with snapshot time. Loss window ≤ 5 min of chat.
- Alert/job delivery records keyed by event id / job+date, written temp-then-rename.
- Disable memory-core "dreaming" (second memory writer) in the container.

## Schedules (America/Los_Angeles)
Briefing 7:30 AM · alerts every 5 min (events 15–30 min ahead, once per event) · recap 6:00 PM · hourly evidence. Cron prompts start with the marker `[a3-cron]` so the router can classify them even if hook context lacks a trigger field. Missed-job check on boot: briefing not delivered and before noon → run once.

## Security
| Measure | Implementation |
|---|---|
| Container isolation | Non-root, no added capabilities, only gateway behind Tailscale Serve; startup isolation report (user, capabilities, listening ports) |
| Permission scoping | send-email allowlist + human approval (exec approvals); tool allowlist; Tailscale grants (graders → 443; agent → laptop 11434); focus-finder read-only |
| Credential management | Secret Manager; `.env.example` placeholders; no tokens or message text in logs |

Threat model: unapproved email send; credential leak; reaching the laptop; private request reaching cloud; restart losing memory/login; prompt injection (**remaining risk**, not claimed); graders have full operator access (accepted; throwaway data).

## Observability
JSON on stdout, `component: "a3-router"` or `"a3-ops"`. Kinds: `route_decision`, `route_result`, `ollama_call`, `health`, `ops` (boot, state-restored, snapshot, job-delivered, job-missed, isolation-report, hourly). No message text.
