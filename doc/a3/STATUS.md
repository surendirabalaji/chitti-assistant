# Status

Last updated: **Wed Nov 11, 2026, ~1:10 PM PST** (handoff from the planning conversation to OpenCode).

This file wins over every other doc when they conflict. Update it at the end of every work session.

## Where we are

Milestone **M0 (feasibility)** is nearly done. F1–F4 pass. F3 passed with manual `/model` switching; automatic switching and F5 need the router plugin.

**Lesson A1 done Nov 12** (Vitest 5.1.0 pinned, `npm test` passes; see PROCESS_LOG). **Lesson A2 done Nov 12** (`decide()` one rule; 39 tests pass, 6 todo). **Lesson A3 done Nov 12** (by the assistant at the student's request; findings under Verified facts → Plugin API). **Next task:** **Lesson A4** (first plugin) in `doc/a3/LEARNING_PATH.md` (the student writes the router hands-on: A1–A5 produce the minimal plugin), then finish F3 (automatic switching) and F5 (cron turns).

Working style: **teaching mode** (see AGENTS.md). The student writes core code; the assistant explains, hints, and reviews.

## Decisions (current)

| Decision | Status |
|---|---|
| Platform: OpenClaw 2026.10.9 | Chosen, installed |
| Cloud model: ChatGPT Edu via OpenClaw OAuth, model `openai/gpt-6-astra` | Chosen, verified |
| Separate laptop and cloud ChatGPT sign-ins (refresh tokens are single-use); never copy laptop auth to the cloud | Chosen |
| Local model: **Gemma 4 E2B**, custom tag `gemma4-a3:e2b`, 32K context (`local/Modelfile.a3-e2b`) | Chosen, verified (E4B rejected: memory) |
| Router: OpenClaw plugin using `before_model_resolve` (Option A) + Ollama forwarder that logs completed calls | Chosen; manual switching verified |
| Private task while local is down: **held** (sent to no model). Reply says the local model is off and can't be reached | Chosen |
| Privacy = narrow keyword list in the user's message | Chosen |
| Messaging: Telegram | Chosen |
| Router unit tests: **Vitest** (pinned devDependency, lockfile, `--before=2026-10-30`), replacing `node:test` | Chosen Nov 11 (student) |
| Unit tests are written by the assistant from now on (student writes the code under test) | Chosen Nov 12 (student) |
| Skills: gog (email + calendar), web search, weather, focus-finder | Chosen |
| Advanced features: morning briefing, end-of-day recap, proactive alerts, email integration | Chosen |
| Advanced integration: publish original skill **focus-finder** to ClawHub | Chosen |
| Security claims: container isolation, permission scoping, credential management. Prompt-injection defense **not claimed** (optional on Nov 17) | Chosen |
| State: local disk + bucket snapshots every 5 min; ChatGPT auth file copied to bucket on every change | Chosen |
| Schedules (America/Los_Angeles): briefing 7:30 AM, recap 6:00 PM, alerts every 5 min, hourly evidence | Proposed |

## Verified facts

### Laptop software
- OpenClaw **2026.10.9 (8b18b55)** installed globally under nvm Node **24.22.1** with `npm install -g openclaw@2026.10.9 --before=2026-10-30`.
  - A plain install on Nov 11 failed with `ETARGET @babel/types@^8.1.2` because Babel 8.1.2 was mid-publish. **The Docker build must use a lockfile + `npm ci`.**
- Old OpenClaw installs (Homebrew-npm 2026.10.4, Node 26 copy) removed. Old state folders archived in `~/openclaw-archive-2026-11-11/`.
- Fresh state `~/.openclaw`, agent `main`, one OAuth profile for the student's USC account (provider `openai`).
- Ollama **0.40.16** (app, installed via ollama.com script). Server on `127.0.0.1:11434`.

### Feasibility results
| Test | Result | Evidence |
|---|---|---|
| F1 Versions | ✅ OpenClaw 2026.10.9, Node 24.22.1, config valid | terminal output |
| F2 ChatGPT login | ✅ onboarding "Inference verified: openai/gpt-6-astra", replied in 4.9 s; dashboard replies | onboarding output |
| F3 Model switching (manual) | ✅ Same chat: ChatGPT recalled Gemma's turn; Gemma recalled "Bluebird" from ChatGPT's turn; ChatGPT named `gemma4-a3:e2b via Ollama` as previous model | 3 screenshots, Nov 11 1:06–1:07 PM |
| F4 Gemma realism | ✅ E2B, CONTEXT 32768, 100% GPU (MLX), 7.4–7.6 GB; full agent turn with workspace file listing in **21 s**; miscounted files (said 5, listed 6) | `ollama ps`, chat |
| F5 Cron turns route through the plugin | ⏳ needs plugin | — |

### Plugin API (OpenClaw 2026.10.9, read from the installed package, Nov 12)
Sources: `$(npm root -g)/openclaw/dist/config-contracts-DzLaG7FV.d.ts` (types), `dist/embedded-agent-DoEPu8ye.mjs` (`resolveHookModelSelection`, the runtime code), and the bundled docs under `openclaw/docs/plugins/` (`hooks.md`, `hooks/reference.md`, `building-plugins.md`, `manifest.md`, `cli/plugins/install.md`).

| Question | Answer (installed version) |
|---|---|
| Entry helper | `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"`; `definePluginEntry({ id, name, description, configSchema?, register(api) {...} })`; `export default` it |
| Register a hook | `api.on(hookName, handler, opts?)`; `opts = { priority?, registrationId?, timeoutMs? }` (+ `eligibleTriggers` only for `before_agent_reply`). Handler signature `(event, ctx) => Result \| void \| Promise<...>` |
| `before_model_resolve` event | `{ prompt: string; attachments?: {kind,...}[] }`. "User prompt for this run. No session messages are available yet." |
| `before_model_resolve` result | `{ providerOverride?: string; modelOverride?: string }`. **Separate fields**: the runtime assigns `modelOverride` straight to `modelId`. So local = `{ providerOverride: "ollama", modelOverride: "gemma4-a3:e2b" }`, cloud = `{ providerOverride: "openai", modelOverride: "gpt-6-astra" }`. Not one `"ollama/gemma4-a3:e2b"` string |
| Hook context (`ctx`, type `PluginHookAgentContext`) | `runId?` (per-turn UUID; use as requestId), `jobId?` (cron), `trigger?: string`, `sessionKey?`, `sessionId?`, `agentId?`, `channel?`, `modelProviderId?`, `modelId?`, `contextTokenBudget?`, `inputProvenance?`. Known trigger values: `"cron" \| "heartbeat" \| "user"` (`PLUGIN_HOOK_AGENT_TRIGGERS`). Whether `trigger` is populated in `before_model_resolve` is **not verified yet** (check in A4/F5) |
| Errors and timeouts | Runtime wraps the hook in try/catch: a throw logs `before_model_resolve hook failed` and the turn continues on the **default model** (fail-open). No default timeout for this hook; `api.on(..., { timeoutMs })` or `hooks.timeouts.before_model_resolve` sets one. A timeout does not cancel the handler |
| Hook skipped when | Session entry has `modelSelectionLocked: true` ("locks the selected model against hooks and fallbacks"). A session pinned to a native harness with `auth: "host"` overrides the provider after the hook. **Test A4 in a fresh chat** |
| Permission gate | **Non-bundled plugins need `plugins.entries.<id>.hooks.allowConversationAccess: true`** for `before_model_resolve`, `before_agent_reply`, `llm_output`, `agent_end`, etc. Without it the hook is not allowed (bundled docs `plugins/hooks.md` "Permissions and scope") |
| Plugin config | Read `api.pluginConfig` (from `plugins.entries.<id>.config`) inside `register`. Editing that config in hybrid reload mode reruns `register` |
| Manifest | `openclaw.plugin.json` at the plugin root, required for local loads. Required: `id`, `configSchema` (inline JSON Schema); also `name`, `description`, `activation.onStartup`. `package.json` gets `"openclaw": { "extensions": ["./src/index.ts"] }` (+ `compat`/`build` versions for published packages) |
| TypeScript loading | Local `.ts` entries go through **OpenClaw's own runtime transformer**, not Node type stripping (`building-plugins.md`) |
| Install local plugin | `openclaw plugins install -l ./router` (`--link`: adds the path to `plugins.load.paths`, no copy; `--force` for noninteractive). Then `openclaw plugins inspect <id> --runtime --json`; after code edits `openclaw plugins reload <id>` |
| `before_agent_reply` (for A8) | event `{ cleanedBody: string }` (the prepared run prompt, may contain channel context); result `{ handled: boolean; reply?: ReplyPayload; reason?: string }`; option `eligibleTriggers` |
| Result observation (for A9) | `model_call_ended`: `runId, callId, provider, model, durationMs, outcome: "completed"\|"error", errorCategory?, failureKind?`; `llm_output` and `agent_end` are also available |

**Doc vs installed differences (ROUTER_SPEC.md "Verify first" was written from the website):**
1. Plugin config is `api.pluginConfig`, **not** `event.context.pluginConfig` (the bundled docs say this explicitly).
2. Model refs are two fields (`providerOverride` + `modelOverride`), not one `provider/model` string.
3. `hooks.allowConversationAccess: true` is required for this plugin. The spec didn't mention it.
4. Local TS is loaded by OpenClaw's transformer. So A4 does **not** prove Node type stripping works; it proves OpenClaw's loader works.

### Measurements so far (for the performance report)
- E4B: cold `ollama run` 49.0 s; 600-word answer 26.2 s warm; 9.4 GB; memory free 14% (yellow). **Rejected.**
- E2B: 600-word answer 24.0 s including cold load; 7.4 GB; memory free 25%.
- E2B agent turn with tool: 21 s. ChatGPT turns in F3: 17 s and 6 s; Gemma turn: 13 s.
- Swap was ~10 GB before tests (leftover). **Restart the Mac before the video and before the 48-hour run.**

### OpenClaw config applied on the laptop
```
openclaw config set models.providers.ollama '{"baseUrl":"http://127.0.0.1:11434","apiKey":"ollama-local","api":"ollama","timeoutSeconds":300,"models":[{"id":"gemma4-a3:e2b","name":"gemma4-a3:e2b","input":["text"],"contextTokens":32768,"params":{"num_ctx":32768,"think":false}}]}' --strict-json
```
Applied live without a gateway restart. `openclaw infer model run --model ollama/gemma4-a3:e2b --prompt "Reply with exactly: ok"` returned `ok`.

### Observations that affect the design
- **Exec ran without approval** in a ChatGPT turn ("1 command"). Fresh installs do not ask. The approval gate must be configured explicitly (`tools.exec.mode` on 2026.10.9; inspect with `openclaw exec-policy show`). Record as a security-audit finding.
- Default **heartbeat** (model turn ~every 30 min) and memory-core **"dreaming" cron** (rewrites MEMORY.md) are active. They are background model calls and a second memory writer. In the container: disable dreaming, set the heartbeat deliberately, and make sure both are routed and logged.
- Default thinking level for ChatGPT is `medium`; Gemma `think:false` via provider params. Record both in the performance report. Plain `ollama run` shows "Thinking…" because the CLI doesn't use that param.
- 15 plugins load by default (browser, cua-computer, github, xai, anthropic, bonjour, …). The container should enable only what A3 needs.
- Doctor flags: plaintext `gateway.auth.token`, browser system-profile cookie import enabled, legacy browser relay auth. Fix in the container config.
- Ollama unloads Gemma after ~5 min idle; next request is cold (~24–49 s).

## Next task: minimal router plugin (Lessons A1–A5)

Goal: prove **automatic** per-turn switching and logging, then extend.
1. Read the installed SDK types for plugin entries and the `before_model_resolve`, `before_agent_reply`, and after-turn observation hooks (see ROUTER_SPEC.md "Verify first").
2. Implement in `router/`: one rule (message ≤ 200 chars and no reasoning words → `ollama/gemma4-a3:e2b`, else `openai/gpt-6-astra`), and a JSON `route_decision` log line.
3. Install it into the laptop OpenClaw (check `openclaw plugins --help` for installing a local plugin), restart the gateway, send "What is 12 times 9?" and "Explain step by step why the sky is blue." in one chat.
4. Pass: first reply served by Gemma, second by ChatGPT, both without `/model`, each with a log line. Save evidence.
5. Then F5: create a test cron job, run it now, confirm the hook fired (log line present).

## Open items
- ~~Piazza question on held semantics~~ **Closed (Nov 11):** student decided not to ask. Held semantics are a stated assumption in DESIGN.md (reply + log, nothing queued, user resends); README must state it.
- Throwaway Gmail account, Telegram bot, ClawHub account: not created yet.
- GCP project not created yet.
