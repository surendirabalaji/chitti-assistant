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
1. `privacy-sensitive`: any privacy word (case-insensitive, word boundary) → local if healthy, else **held** (`privacy-local-unavailable`).
2. `long-context`: session estimate > `longContextTokens` → cloud.
3. `tool-task`: any tool word or cron/heartbeat trigger → cloud.
4. `reasoning-heavy`: reasoning word or length > `reasoningMinChars` → cloud.
5. `simple-task`: length ≤ `simpleMaxChars` → local if healthy, else cloud (`local-unavailable`).
6. `default-cloud` → cloud.
If `simulateRateLimit` is true, any cloud outcome from rules 2–6 becomes local if healthy (`cloud-rate-limited`), else a synthetic reply "The cloud model is unavailable right now" (logged target `none`, ok false).

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
