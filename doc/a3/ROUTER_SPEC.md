# Router plugin specification

Location: `router/`. Language: TypeScript, as an OpenClaw plugin for **OpenClaw 2026.10.9**.

## Verify first (do this before writing code)

These come from docs.openclaw.ai (Nov 2026) and must be checked against the **installed** package (`$(npm root -g)/openclaw`):
- Plugin entry: `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`; hooks registered with `api.on(name, handler, { timeoutMs? })`; handler receives `event.context.pluginConfig`.
- `before_model_resolve` (modify): receives the current prompt and attachment metadata only; returns `providerOverride` / `modelOverride`. Find the exact field names and how model refs are expressed (`ollama/gemma4-a3:e2b`, `openai/gpt-6-astra`).
- `before_agent_reply` (claim): short-circuit a turn with a synthetic reply → used for **held**.
- Observation hooks for results (`llm_output`, `agent_end`): which fields give provider, model, outcome, duration, token usage, `contextTokenBudget`.
- Whether hook context exposes the turn trigger (chat vs cron vs heartbeat) and session key.
- How to install a local plugin (`openclaw plugins --help`), the manifest format (`openclaw.compat.pluginApi`, `openclaw.build.openclawVersion` for code plugins), and how plugin config is set (`plugins.entries.<id>.config`).
- Known limitation from the docs: the Codex app-server harness rejects restrictive per-turn tool policy values; do not try to narrow tools per turn on ChatGPT turns.
Record findings (and any doc vs installed differences) in STATUS.md.

> **Verified Nov 12 against 2026.10.9. See STATUS.md "Plugin API". Corrections to the list above:** config comes from `api.pluginConfig` (not `event.context.pluginConfig`); overrides are `providerOverride: "ollama"` + `modelOverride: "gemma4-a3:e2b"` (two fields); the plugin needs `plugins.entries.<id>.hooks.allowConversationAccess: true`; a throw in the hook is logged and the turn falls back to the default model.

## Config (plugin config, editable live)
```json
{
  "localModel": "ollama/gemma4-a3:e2b",
  "cloudModel": "openai/gpt-6-astra",
  "ollamaHealthUrl": "http://127.0.0.1:11434/api/tags",
  "simpleMaxChars": 200,
  "reasoningMinChars": 400,
  "longContextTokens": 20000,
  "privacyWords": ["confidential","private","personal","sensitive","password","bank","medical","salary","ssn","diagnosis"],
  "reasoningWords": ["step by step","explain why","analyze","analyse","compare","plan","pros and cons","trade-off"],
  "toolWords": ["email","inbox","mail","calendar","meeting","schedule","event","search","look up","weather","briefing","recap","[a3-cron]"],
  "simulateRateLimit": false,
  "heldReply": "The local model is off and can't be reached right now, so this private request was held and not sent to any model. Please try again when it's back."
}
```
On the laptop `ollamaHealthUrl` hits Ollama directly; in the container it goes through the forwarder. `longContextTokens` is provisional: measure the base prompt size on a real turn and set threshold = 32768 − base prompt − 4096 reply budget.

## Decision procedure (first match wins)
1. `privacy-sensitive`: any privacy word (case-insensitive, word boundary) → local if healthy, else `privacy-local-unavailable` → **cloud** (default since Nov 13, student decision) or **held** (plugin config `privateWhenLocalDown: "held"`).
2. `long-context`: session estimate > `longContextTokens` → cloud.
3. `tool-task`: any tool word or cron/heartbeat trigger → cloud.
4. `reasoning-heavy`: reasoning word or length > `reasoningMinChars` → cloud.
5. `simple-task`: length ≤ `simpleMaxChars` → local if healthy, else cloud (`local-unavailable`).
6. `default-cloud` → cloud.
If `simulateRateLimit` is true, any cloud outcome from rules 2–6 becomes local if healthy (`cloud-rate-limited`), else a synthetic reply "The cloud model is unavailable right now" (logged target `none`, ok false).

> **As built (A6, Nov 13):** words match whole words, case-insensitive; inside a phrase any run of spaces/hyphens matches ("step-by-step", "explain\nwhy"); the message is trimmed before length checks. Cron = `ctx.trigger` `cron`/`heartbeat` or a `ctx.jobId`. Session estimate = `llm_output` `usage.total` ÷ model calls in that run (counted with `model_call_ended`), per `sessionId`; it covers the whole prompt (system prompt ~11–14k tokens + history), compared with `longContextTokens` 20000 (OpenClaw's budget for a 32K model is 24,576). Until A8, `held` and `none` are pinned to local (fail closed: only target `cloud` may reach ChatGPT). Known limits: no stemming ("planning" ≠ "plan"), no negation ("not confidential" is private).

## Router v2 (layered), Nov 13 (assistant-written at the student's request)
Why: keyword-only routing was brittle ("Should I take the offer?" → local; "What's on tomorrow?" → local).
Measured first (`local/classifier-bench.mjs`): Gemma labels 89% of 27 synthetic messages correctly, ~150 ms warm, deterministic, no prompt-cache impact, but **missed 4/16 private** messages.
1. **Fixed checks (never a model):** privacy = word list + SSN pattern + Luhn-valid card number + "password/pin/code is X"; long context; cron/heartbeat; > `reasoningMinChars`. Privacy decides held vs local, so it must be repeatable.
2. **Gemma label** (`simple|reasoning|tool|private`, `src/classifier.ts`), asked only when it can change the outcome (`needsClassifier`): local healthy, not fixed-private, not cron/long. Loopback URL only (laptop 11434, container forwarder 11435), timeout 2000 ms, then fallback. Gemma may **add** privacy, never remove it. Either side may escalate to cloud: any tool signal or explicit reasoning word overrides a `simple` label.
3. **Scoring fallback** (`src/signals.ts`) when there's no label: arithmetic → simple; tool words/time references/clock times → tool; reasoning points (word 2, advice 2, why 1, how 1, multi-question 1, code 1, list 1, long 1) ≥ 2 → reasoning; else simple if ≤ 200 chars, else default-cloud.
Log adds `via` (fixed|gemma|heuristic), `signals` (names only, filtered to `[a-z0-9:-]`), `category`, `classifierMs`, `classifierError`. The forwarder logs classifier calls with `purpose: "route-classify"`.
Graders mostly test with the laptop off → they see the fixed checks + scoring fallback. Plugin config: `classifier`, `classifierUrl`, `classifierTimeoutMs`.

## Follow-up rule (Nov 14, assistant-written at the student's request)
Why: routing is per message and `before_model_resolve` sees no history. On the cloud agent (Telegram, 22:51 UTC) ChatGPT asked "which time zone / names?" about a calendar request; the answer "Pacific Time and Name it to Test 1 and Test 2" had no tool signal, Gemma labelled it `simple`, and Gemma could not finish the task. Student: follow-ups must stay with the model doing the task, but only when the message really is a follow-up.
1. **Candidate (fixed, no model, `followupCandidate`)**: same session (`/new` resets it); the previous routed turn was `cloud` with rule `tool-task|reasoning-heavy|follow-up|default-cloud`; that reply had a `?` in its last 300 characters, ignoring generic sign-offs like "Anything else I can help with?" (`endsWithQuestion`); at most `followupWindowMs` (default 300000, 0 = off) since the reply. Cron/heartbeat never.
2. **Verification (Gemma, `checkFollowup`)**: local Gemma gets the reply's last ≤ 400 characters and the new message, schema `{followup: boolean}`, purpose header `route-followup`, same loopback URL and 2000 ms timeout, run in parallel with the label call, only when `needsClassifier` is true (local up, not fixed-private, not long/cron).
3. **Rule 4a'** (after privacy, long-context, cron and very long messages; before Gemma's label): verdict `true` → `cloud`/`follow-up`/via gemma; verdict `null` (timeout, error, classifier off) → `follow-up`/via heuristic unless the message is a bare greeting/thanks; verdict `false` → normal rules. A pure calculation is never a follow-up. Privacy (fixed or Gemma) always wins first; the rate-limit switch still applies.
- The reply tail is kept in process memory only (per session, LRU 200), never logged, shown only to local Gemma. Log adds `followupCandidate`, `followupVerdict`, `followupMs`, `followupError`.
- Measured (laptop, `local/followup-bench.mjs`, 20 synthetic pairs × 3): Gemma 51–54/60 warm, ~95 ms; every miss was "new question judged a follow-up" (one extra cloud call, no privacy effect). With the calculation and sign-off fixes: 57/60. End to end on the laptop gateway: candidate + verdict true → ChatGPT continued the task; a new question in the same session → verdict false → Gemma (`evidence/2026-11-14-router-followup-laptop.txt`).

## Memory label (Nov 14 night, student's design; assistant-written)
Why: cloud test on image 2026-11-14d. "Remember that I like coffee." happened to reach ChatGPT (long session) and was saved to USER.md; "My favourite movie is enthiran da." was short, went to Gemma (`simple-task`), was never saved, and a fresh chat could not recall it. Gemma does not call file or `memory_search` tools; OpenClaw's session-memory notes are not loaded on a bare `/new` (docs `gateway/config-agents/workspace-and-bootstrap.md`: bare chat `/new` does not invoke the model). Student: no memory phrase list; use the existing Gemma call, like privacy.
- Gemma's label set gains `memory`: "the user shares a lasting fact or preference about themselves for you to remember (…), or asks what you remember about them. Confidential details are private, not memory." Same single `route-classify` call, no extra latency.
- Rule 4b': label `memory` -> `cloud`, rule **`memory-task`**, via gemma, signal `gemma:memory`. After privacy (fixed or Gemma), long-context, cron, very long messages and the follow-up check. Rate-limit switch applies (-> local). `memory-task` joins the follow-up rules.
- No label (Gemma down, cold-start timeout, not asked): unchanged scoring fallback, so a short memory statement then goes to Gemma (laptop up) or ChatGPT (laptop down). Known limit.
- Measured (laptop, `local/classifier-bench.mjs`, 42 synthetic cases x 3): memory 33/33, deterministic, ~150 ms warm; the 27 old cases kept exactly the same labels as on Nov 13. "Remind me to email Priya tomorrow at 9" -> memory (cloud either way); "Remember my bank PIN is 4471" -> private. Evidence `evidence/2026-11-15-classifier-bench-memory.json`.

## A7-A9 as built (Nov 13, assistant-written at the student's request)
- **Health (A7):** `router/src/health.ts`, `GET <ollamaUrl>/api/tags` every 10 s, 3 s timeout, unknown+1 fail or up+2 fails → down, 1 success → up, `health` line on change only, probes never overlap, poller replaced on every `register` (plugin reload / config edit) and stopped on `gateway_stop`. While down, the classifier is not asked.
- **Held (A8):** `before_agent_reply` claims `held` and `none` turns with `heldReply` / `unavailableReply` (`{ handled: true, reply: { text } }`). **Verified order (laptop): `before_agent_reply` runs BEFORE `before_model_resolve`**, so the claim decides itself (fixed checks) and writes both `route_decision` (model `none`) and `route_result` (ok false, error `held` / `cloud-unavailable`). `toOverride` still pins held/none to local as a second line of defence.
- **Results (A9):** `route_result {requestId, rule, target, servedModel, model, ok, latencyMs, error}`. **`agent_end` fires per attempt with `success: true` even when the model call failed**, and OpenClaw retries the same model then gives up without a final hook. So ok = the attempt's last `model_call_ended` was `completed`; failure = last call failed and no new attempt for 45 s. `latencyMs` = decision → result (agent_end.durationMs is per attempt).
- **Utility model:** OpenClaw's title/narration calls bypass the plugin and carry message text. `agents.defaults.utilityModel = "ollama/gemma4-a3:e2b"` keeps them local (verified: a held turn then makes no model call at all).
- **Rate-limit switch:** on `openclaw config set plugins.entries.a3-router.config.simulateRateLimit true --strict-json`, off `... false`; hot reload re-runs `register`, no restart (verified on the laptop with the whole-object form). In the container run it over instance SSH as user `agent` (see deploy/LOGIN.md for the env); the template resets it to false on every boot.
- **Plugin config keys:** `ollamaUrl`, `classifier`, `classifierTimeoutMs`, `healthCheck`, `simulateRateLimit`, `heldReply`, `unavailableReply`, `logMirrorFile` (`/tmp/a3-router*.log` only), `traceHooks` (mirror only). After changing the manifest schema on a running gateway: set the config to keys the *old* schema knows, `openclaw plugins reload a3-router`, then set the new keys (the gateway validates against the cached manifest).

## Health poller
In-process timer, every 10 s, 3 s timeout. Two consecutive failures → down; one success → up. Router reads the cached value only; it never awaits the network inside a hook. Log `health` only on state change. Clean up the timer on gateway stop.

## Logging (JSON lines on stdout)
Common fields: `component: "a3-router"`, `kind`, `requestId`, `ts`.
- `route_decision`: `rule`, `target` (`local`|`cloud`|`held`), `model`, `localHealthy`, `sessionSizeEst`, `rateLimitSimulated`
- `route_result`: `target`, `servedModel`, `ok`, `latencyMs`, `error` (short code only)
- Never log message text, prompts, tool arguments, email addresses, or tokens.
`requestId` links decision and result (use the run id / session key + turn counter available in hook context).

Video log command (adjust fields to the final implementation):
```
gcloud logging read 'jsonPayload.component="a3-router"' --project=PROJECT --freshness=30m --order=desc \
  --format="table(timestamp.date('%H:%M:%S'),jsonPayload.kind,jsonPayload.rule,jsonPayload.target,jsonPayload.servedModel,jsonPayload.ok)"
```

## Tests
- Unit: pure `decide(message, state)` function with table tests for every rule, the four video prompts, rate-limit mode, and local-down mode.
- Integration (laptop): the four video prompts through the dashboard in one chat; quit Ollama between 2 and 3, restart before 4. Expected local → cloud → held → local, each with decision + result lines.
- Cron: a job whose prompt starts with `[a3-cron]`, run now → cloud, logged.

## Minimal first version (current next task)
Only: rule "≤ 200 chars and no reasoning word → local, else cloud", a `route_decision` log line, no poller. Goal is to prove the hook switches models automatically. Then grow to the full procedure.
