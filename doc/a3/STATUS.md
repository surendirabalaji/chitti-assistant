# Status

Last updated: **Fri Nov 13, 2026, ~12:45 AM PST** (M2 step 6 in progress).

This file wins over every other doc when they conflict. Update it at the end of every work session.

## Where we are

Milestone **M0 (feasibility)** is nearly done. F1–F4 pass. F3 passed with manual `/model` switching; automatic switching and F5 need the router plugin.

**Lesson A1 done Nov 12** (Vitest 5.1.0 pinned, `npm test` passes; see PROCESS_LOG). **Lesson A2 done Nov 12** (`decide()` one rule; 39 tests pass, 6 todo). **Lesson A3 done Nov 12** (by the assistant at the student's request; findings under Verified facts → Plugin API). **Lesson A4 done Nov 12, F3 automatic switching passes** (see evidence). **A5 code done (assistant-written at the student's request), F5 passes, exec policy recorded.** Open: student confirms the route_decision lines in the gateway terminal. Telegram bot created and verified on the laptop. **Wednesday work done except the Gmail test account (student).** **M1 cloud foundation done Nov 12** (see "Cloud foundation" below). **M2 steps 1–2 done Nov 13** (lockfile + container config template, see "Container build (M2)"). **M2 step 3 done Nov 13** (Dockerfile, startup.sh, .dockerignore written; static checks only). **M2 step 4 done Nov 13** (image `chitti-a3-agent:dev` built and smoke-tested locally, `evidence/2026-11-13-m2-step4-image-build.txt`). **M2 step 5 done Nov 13** (Artifact Registry `us-west1-docker.pkg.dev/chitti-assistant-a3/a3/agent:2026-11-13a`, digest `sha256:b0a16fdf285d83c6065d89feaf9067983a856a04f51614e534c4559710e45d0e`). **M2 step 6 in progress Nov 13:** instance `a3-agent` created (us-west1, 1 vCPU/4 GiB, no URL, no port); Tailscale joins as `a3-cloud-agent` 100.71.136.89 with state on the bucket; gateway bootstrap failed (reason not captured) and the device-code login needs a TTY, so image `2026-11-13b` fixes both (see `evidence/2026-11-13-m2-step6-first-deploy.txt`). **Next task:** redeploy with `2026-11-13b` (ask first), device-code ChatGPT login, then the forwarder (student writes, guided). Then Lesson A6 (the student writes the router hands-on: A1–A5 produce the minimal plugin), then finish F3 (automatic switching) and F5 (cron turns).

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
| F3 Automatic switching (plugin) | ✅ Nov 12 4:21 PM: fresh chat, no `/model`: "what is 12 times 9?" → `[hooks] provider overridden to ollama` / `gemma4-a3:e2b`; "explain step by step…" → `openai` / `gpt-6-astra`. Gemma loaded in `ollama ps` at that time; turn-2 prompt-cache line shows `model(ollama/gemma4-a3:e2b -> openai/gpt-6-astra)` | `evidence/2026-11-12-a4-auto-switch.txt` + screenshot 4.22.51 PM |
| F5 Cron turns route through the plugin | ✅ Nov 12 16:50: test job `a3-f5-test` (disabled, isolated, no-deliver) run with `openclaw cron run <id>` → `[hooks] provider overridden to openai`; run ok on openai/gpt-6-astra. The heartbeat (16:43:50) also passes through the hook. **Unexplained:** the short cron message routed to cloud, so the cron `event.prompt` is probably wrapped/longer than the message (not verified) | `evidence/2026-11-12-a5-f5-cli-turns.txt` |
| A5 decision log line | ✅ Nov 12 17:13–17:14: lines on gateway stdout start with `{` (no prefix); `requestId` = OpenClaw `runId` (so `ctx.runId` is populated in `before_model_resolve`); no message text. Heartbeat → `default-cloud`; Telegram "hi" → `simple-task` local | `evidence/2026-11-12-a5-telegram-route-log.txt` |
| Telegram (laptop) | ✅ `@chitti_assistant_bot`, tokenFile `~/.config/chitti/telegram-bot-token` (chmod 600, outside repo), `dmPolicy allowlist` + owner's numeric ID, groups blocked, BotFather joingroups disabled (student). DM → Gemma → reply delivered (~22 s). **Disable on the laptop before the cloud deploy** (one poller per token) | same file |

### Cloud foundation (M1, Nov 12)
| Item | Value / state | Evidence |
|---|---|---|
| gcloud | separate local configuration `chitti-a3` (the old `default` config points at an unrelated project) | `evidence/2026-11-12-m1-steps1-3.txt` |
| Project | `chitti-assistant-a3`, billing linked, budget **$25** monthly, alerts 50/90/100% (alert only, not a cap) | same + console (student) |
| Region | `us-west1`. Cloud Run Instances are available in every Cloud Run region except europe-west1, us-central1, us-east1 (cloud.google.com/run/docs/locations, read Nov 12). CLI group: `gcloud beta run instances` (SDK 587.0.0) | |
| APIs | run, artifactregistry, secretmanager, storage, logging, billingbudgets (plus Google's default set, unused) | same |
| Service account | `a3-agent@chitti-assistant-a3.iam.gserviceaccount.com`, **no user-managed keys**; project role only `roles/logging.logWriter`; `roles/storage.objectAdmin` on the bucket; `roles/secretmanager.secretAccessor` on `tailscale-authkey` | same |
| Bucket | `gs://chitti-assistant-a3-state`, us-west1, uniform access, public access prevention enforced, default soft delete | same |
| Tailscale | tailnet `tail9bf1e8.ts.net`; laptop `surendiras-macbook-air` = `100.87.223.40` (client 1.104.7); MagicDNS + HTTPS on; deny-by-default policy (3 grants + 1 test, allow-all removed) | `evidence/2026-11-12-m1-tailscale.txt` |
| Auth key | reusable, non-ephemeral, tag `tag:a3-agent`, 90 days, only in Secret Manager `tailscale-authkey` (version 1). **Revoke after grading** | same |
| Laptop serve | `tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434` (tailnet only); undo with `tailscale serve reset` | same |

**M1 finding: Ollama rejects the tailnet Host header.** Through serve, `Host: surendiras-macbook-air.tail9bf1e8.ts.net:11434` → **403**; same path with `Host: 127.0.0.1:11434` → 200; LAN IP → no connection. The M2 forwarder must rewrite `Host` to `127.0.0.1:11434`. Never fix this with `OLLAMA_HOST=0.0.0.0`. Not verified yet: the agent → laptop path from a `tag:a3-agent` node (needs the container). Also: the gcloud Cloud Billing API sometimes returns 429 on gcloud's shared quota project; fix with `gcloud config set billing/quota_project chitti-assistant-a3` (needs `cloudbilling.googleapis.com` enabled) if it recurs.

### Container build (M2, Nov 12–13)
| Item | State | Notes |
|---|---|---|
| `deploy/package.json` | openclaw `2026.10.9` exact; `engines.node 24.22.1`; `allowScripts` pinned: openclaw@2026.10.9, esbuild@0.28.2, koffi@3.3.2, protobufjs@7.6.6, @google/genai@2.27.0 | npm 11.19.1 docs contradict each other on whether unapproved dependency install scripts are blocked or only warned; pinned approvals make it explicit. **Check: `npm ci` in the build prints no `install-scripts` warning** |
| `deploy/package-lock.json` | generated inside `node:24.22.1-bookworm-slim` linux/amd64 (`npm install --package-lock-only --before=2026-10-30`, stdin/stdout pipe because Docker Desktop has no macOS permission for ~/Desktop); 418 packages with integrity; 36 `linux-x64` entries | base image digest `sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c` (pin in Dockerfile). `npm audit`: 29 advisories (25 moderate, 4 high) in transitive deps: remaining risk, do **not** `npm audit fix` |
| `deploy/openclaw.template.json5` | `openclaw config validate` → valid; `doctor --lint` → only info warnings (heartbeat monitor, device-pair, browser import now disabled); `plugins list --enabled` → a3-router, memory-core, ollama, openai | validated in a throwaway state dir with the router path substituted. Lint caught a real bug: `openai/gpt-6-astra` needs `agents.defaults.models["openai/gpt-6-astra"].agentRuntime.id: "openclaw"` (otherwise Codex runtime, plugin absent) |
| Docker Desktop | 29.2.1, Rosetta amd64 emulation, ~4 GB VM (student) | `docker run -v ~/Desktop/...` fails (macOS privacy); `docker build` from the terminal is unaffected |

**Image design (step 3, Nov 13; not run yet):**
- `deploy/Dockerfile`: base pinned by digest; Tailscale 1.104.7 static amd64 via `ADD --checksum=sha256:e56693ff…` (sha from pkgs.tailscale.com); user `agent` uid/gid 10001; OpenClaw installed with `npm ci --omit=dev` as root (code read-only for the agent); router `package.json`, manifest, `src/` copied to `/app/router` (matches `plugins.load.paths`); env: `OPENCLAW_STATE_DIR=/home/agent/.openclaw`, `STATE_MOUNT=/mnt/state`, `FORWARDER_LISTEN=127.0.0.1:11435`, `OLLAMA_UPSTREAM=http://surendiras-macbook-air.tail9bf1e8.ts.net:11434`, `SOCKS_PROXY=socks5h://127.0.0.1:1055`; entrypoint `tini -- /app/startup.sh`.
- `.dockerignore` (repo root) is an **allowlist**: only the 4 deploy files + router package.json/manifest/src enter the build context.
- `deploy/startup.sh`: TS key from env `TS_AUTHKEY` (Cloud Run `--set-secrets`) → 0600 temp file → `tailscale up --auth-key=file:` → file deleted, env var unset before the gateway starts (agent tools can't read it). Per-boot random gateway token. Template copied over the config on every boot, `auth` block preserved via `openclaw config get/set auth`. tailscaled userspace, SOCKS5 127.0.0.1:1055, statedir on the bucket mount `/mnt/state/tailscale`. Forwarder started only if `router/src/forwarder.ts` exists. `openclaw gateway run`; OpenClaw runs `tailscale serve --yes --bg=false <port>` itself (read in `dist/tailscale-BvelItYj.mjs`, default socket path, sudo fallback only on permission errors). Isolation report after 20 s (user, uid, CapEff, listening ports). First boot without an openai profile → `openclaw models auth login --provider openai --method device-code` in the background; code appears in Cloud Logging (not verified that it works without a TTY). Supervises with `wait -n`; a child dying → exit 1 (restart), SIGTERM → exit 0. M7 TODOs: restore before tailscaled, final snapshot in `shutdown`.
- Deploy flags to use in step 6 (from `gcloud beta run instances deploy --help`, SDK 587): `--no-default-url` (default URL is **on** otherwise), `--service-account`, `--set-secrets TS_AUTHKEY=tailscale-authkey:latest`, `--add-volume name=state,type=cloud-storage,bucket=chitti-assistant-a3-state` (+ `mount-options` uid/gid 10001, not verified), `--add-volume-mount volume=state,mount-path=/mnt/state`, `--restart-policy` (default on-failure), `--startup-probe` (nothing listens on $PORT; probably `--startup-probe=""`, not verified), `--cpu`/`--memory`.

**Local build + smoke test (step 4, Nov 13 ~12:40 AM, run by the assistant; evidence `evidence/2026-11-13-m2-step4-image-build.txt`):**
- `docker build --platform linux/amd64` exit 0; image amd64, ~337 MB, user `agent` (uid 10001). Tailscale checksum step passed.
- `npm ci`: 344 packages, **no `install-scripts` warning**; Linux native binaries present (fs-safe, koffi, node-pty); `require("koffi")` and esbuild load. So the pinned `allowScripts` approach works.
- `/app/openclaw` and `/app/router` are not writable by the agent; `/var/run/tailscale` and `/mnt/state` are. No key/token/secret env vars in the image.
- In the container: `config validate` valid; 4 plugins enabled; `openclaw gateway run --tailscale off` reached `ready` in ~7 s with `http server listening (4 plugins: a3-router, memory-core, ollama, openai)`, `[heartbeat] disabled`, listening only on `127.0.0.1:18789` / `[::1]:18789`, clean SIGTERM shutdown in 167 ms. Gateway log file: `/tmp/openclaw/openclaw-<date>.log`.
- Observed: gateway shutdown budget is up to 325 s (drain); Cloud Run's stop grace period may be shorter (check for M7).
- Still not verified (needs the cloud): `startup.sh` end to end, tailscaled/`tailscale up`, managed Serve, bucket mount, device-code login, model calls.

**First cloud boot (step 6, Nov 13 08:50 UTC; evidence `evidence/2026-11-13-m2-step6-first-deploy.txt`):**
- `--ingress` is rejected without a container port (`spec.ingress: Ingress settings require a single container with a port`). Deployed with `--no-default-url`, no port, `--startup-probe=""` (accepted).
- Verified in the cloud: secret injection, `tailscaled` userspace as uid 10001, **bucket mount writable** with `mount-options=uid=10001;gid=10001` (machine key written to `/mnt/state/tailscale`), `tailscale up` with the tagged key → node `a3-cloud-agent.tail9bf1e8.ts.net` / `100.71.136.89`, tags `tag:a3-agent`; isolation report `user=agent uid=10001 capEff=0000000000000000` (no Linux capabilities).
- Tailscale uses the tailnet default auto-update setting (`true`); in a container it can't update the binary. Consider `tailscale set --auto-update=false` (not done).
- Gateway bootstrap on 1 vCPU took ~30 s and **failed** (`gateway-run-bootstrap … failed`, reason only in `/tmp/openclaw/*.log`, not captured). Not reproduced locally.
- **Device-code login requires a TTY** ("models auth login requires an interactive TTY"); `script -qfec "<cmd>" /dev/null` works (prints URL `https://auth.openai.com/codex/device` + code, expires in 15 min). The code appears in Cloud Logging (project-private, short-lived): mention in the audit.

**Config facts verified from the installed 2026.10.9 docs/schema (Nov 12, research subagent):**
- **ChatGPT OAuth credentials are in SQLite**, not a JSON file: `$OPENCLAW_STATE_DIR/agents/main/agent/openclaw-agent.sqlite` (`auth_profile_store`) + `state/openclaw.sqlite`. "Auth file copied to bucket on change" (DESIGN/M7) must become a SQLite-safe backup (`openclaw backup` or the SQLite backup API). Profile metadata goes in `auth.profiles` in openclaw.json.
- Headless login: `openclaw models auth login --provider openai --method device-code` (docs `providers/openai/authentication.md`).
- `gateway.auth.allowTailscale` only works with OpenClaw-managed Serve (`gateway.tailscale.mode: "serve"`); identity headers verified with `tailscale whois`. `gateway.tailscale.resetOnExit` was retired. Whether managed Serve works with userspace `tailscaled`: **not verified**.
- Exec approvals are stored in `state/openclaw.sqlite`; the effective policy is the stricter of `tools.exec.*` and the store. `tools.exec.mode` enum: deny|allowlist|ask|auto|full.
- No switch disables dashboard title generation; `utilityModel: ""` disables the utility route (titles then use the session model).
- `hooks.internal.entries.session-memory.enabled` controls the /new memory writer (left on; README must mention it).
- Default log file `/tmp/openclaw/openclaw-YYYY-MM-DD.log` besides console. `gateway run` may rewrite the config (auto-migration, `.bak`).
- Fallback: with `fallbacks: []` the chain is the primary only, but whether an Ollama failure retries on the configured primary (ChatGPT) is **not verified**: test with Ollama stopped (matters for the held policy).

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

**A4 finding (Nov 12, 4:13 PM): auth-profile pin blocks hook switching.** The first A4 chat test failed with `Auth profile "openai:setup-…" is not configured for ollama`. The hook *did* fire (the provider was switched to ollama). Cause: onboarding set `agents.defaults.model` to `openai/gpt-6-astra@openai:setup-<id>`. The `@profile` suffix is a **user auth pin** (docs `concepts/model-failover.md`), and the dashboard session stored `gpt-6-astra@openai:setup-…`. `prepareAgentRuntimeAuth` (`dist/prepare-auth-*.mjs`) enforces a user-pinned profile against the *hook-selected* provider and throws. The docs say an incompatible pin is cleared "when the selected provider changes", but that doesn't happen on the hook path. **Fix:** default model without `@profile` (`openai/gpt-6-astra`), then a new chat. The container config must also never use an `@profile` model ref.

**A4 finding: background utility model calls bypass the router.** Conversation-label generation uses the runtime default utility model `openai/gpt-5.6-luna` (`agents.defaults.utilityModel` is unset). It fails with 403 `reasoning_effort_not_allowed` on this ChatGPT Edu workspace, and it never passes through `before_model_resolve`. To decide (container config): set `agents.defaults.utilityModel` to an allowed model or turn label generation off; mention it in the README/audit as a non-routed background call.

**Telegram/session finding (Nov 12 17:14):** Telegram DMs go to session `agent:main:main` (shared history). The Gemma turn hit `context-pressure … estimatedPromptTokens=28850 > promptBudgetBeforeReserve=24576 → compact_only`. The long-context rule (A6, rule 2) and session hygiene matter before the 48-hour run; consider a per-channel DM session scope or `/new` before demos.

**Doc vs installed differences (ROUTER_SPEC.md "Verify first" was written from the website):**
1. Plugin config is `api.pluginConfig`, **not** `event.context.pluginConfig` (the bundled docs say this explicitly).
2. Model refs are two fields (`providerOverride` + `modelOverride`), not one `provider/model` string.
3. `hooks.allowConversationAccess: true` is required for this plugin. The spec didn't mention it.
4. Local TS is loaded by OpenClaw's transformer. So A4 does **not** prove Node type stripping works; it proves OpenClaw's loader works.

### Measurements so far (for the performance report)
- Nov 12 17:17 (Telegram, right after `/new`): Gemma "What is 12 times 9?" **~7 s** inbound→reply, no context-pressure line. Same prompt in the long shared session at 17:14: ~22 s with `compact_only`. Answer text: ask the student.
- Nov 12 16:48 (CLI `openclaw agent`): Gemma turn "What is 12 times 9?" 16.5 s, **answered 118 (wrong)**; base prompt 11,007 tokens (estimate 14,188), so long-context threshold ≈ 32768 − ~14k − 4096 ≈ 14k (to confirm). ChatGPT "Explain step by step…" 7.3 s.
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
- **`/new` triggers the `session-memory` hook**, which writes the old session's context to `~/.openclaw/workspace/memory/<date-time>.md` (17:17:37). That's another memory writer besides dreaming. Those files can contain private message text, they end up in bucket snapshots (M7), and the README privacy statement must mention them. `/new` itself made no model call (no route_decision).
- **Exec policy (Nov 12, `openclaw exec-policy show`):** profile `full`, exec and process allowed, command approvals `auto · full · no approval prompts`. This confirms the earlier finding. The container must set an approval gate (security audit item).
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
- Throwaway Gmail account and ClawHub account: not created yet. (Telegram bot done Nov 12.)
- ~~GCP project not created yet.~~ Done Nov 12 (M1).
