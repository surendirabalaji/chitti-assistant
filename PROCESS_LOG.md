# Process log

## Narrative (student writes, 200–300 words)

_To be written by the student._

## Learning reflection (student writes)

_To be written by the student._

## Development notes

### 2026-11-12: Lesson A1 (router project skeleton)
- Tools: OpenCode with Claude Opus 5.5 (openrouter/anthropic/claude-opus-5.5) in teaching mode. The assistant explained concepts and reviewed; it did not write `router/` files.
- Decision (student): Vitest instead of `node:test` for router unit tests. Recorded in STATUS.md and LEARNING_PATH.md.
- Student-written: `router/package.json` (name `chitti-assistant-router`, private, ESM, `"test": "vitest run"`), `router/test/sanity.test.ts` (2 trivial tests).
- Vitest 5.1.0 installed as a devDependency. The first install wrote `^5.1.0`; the student pinned it to exactly `5.1.0` after review, and the lockfile root entry now matches (checked by the assistant with grep).
- Verified (output pasted by student): `which node` → nvm v24.22.1; `npm test` → 1 file, 2 tests passed, exited normally.
- Not verified: whether `--before=2026-10-30` was used for the install; the deliberate failing-test run was not shown.

### 2026-11-12: Lesson A2 (decide(), one rule), in progress
- Assistant-generated at the student's explicit request ("write test cases"): `router/test/decide.test.ts`, a table of 11 `it.each` rows (video prompts 1–2, case-insensitivity, each reasoning word, the 200/201 character boundary, long messages, rule order). A TODO row is left for the student's own edge case.
- Student-written: `router/src/decide.ts`. Got level-1 hint on matching; student then used `Array.prototype.some` + `includes` on a lowercased message.
- First run (observed by assistant): 12 passed, 1 failed (`boundary: exactly 200 chars`).
- Student decision: the assistant writes all unit tests from now on. Recorded in STATUS.md and LEARNING_PATH.md.
- Assistant rewrote `router/test/decide.test.ts`: 39 tests + 6 `it.todo` (video prompts, each reasoning word, case variants, position/punctuation/newline, length boundaries 0/1/199/200/201/300/5000, whitespace, rule order, UTF-16 emoji length, return-shape/purity/no shared object, no `held` in A2). The todos list open questions: word boundaries for A6, hyphenated "step-by-step", extra spaces, "analyse", trimming.
- Student fixed `decide.ts` after review questions: `<=` boundary, uses `SIMPLE_MAX_CHARS`, `rule: string`.
- Assistant ran `npx vitest run`: 2 files passed, 39 passed, 6 todo. Not yet confirmed by student run.
- Verified (student pasted output, 01:04 Nov 12): `npm test` gives 2 files passed, 39 passed, 6 todo. A2 closed.
- Not verified: the mutation check (removing `.toLowerCase()`) was not run.

### 2026-11-12: Lesson A3 (plugin API research), done by the assistant
- At the student's request ("you do this part"), the assistant read the installed OpenClaw 2026.10.9 package: type definitions (`dist/config-contracts-DzLaG7FV.d.ts`), the runtime function `resolveHookModelSelection` in `dist/embedded-agent-DoEPu8ye.mjs`, the bundled docs under `openclaw/docs/plugins/`, and `openclaw plugins install --help`.
- Findings are recorded in STATUS.md ("Plugin API"). Four corrections to ROUTER_SPEC.md: `api.pluginConfig`; separate `providerOverride`/`modelOverride`; the required `hooks.allowConversationAccess`; local TS goes through OpenClaw's transformer, not Node type stripping.
- Not verified at runtime yet: whether `ctx.trigger` is populated in `before_model_resolve`; whether `/model` sets `modelSelectionLocked` on the session.

### 2026-11-12: Lesson A4 (first plugin), started
- Assistant wrote `router/test/plugin.test.ts` before the code exists (test-first): `toOverride` mapping, registration via a fake `api.on`, end-to-end handler routing, robustness to malformed events. One `it.todo` for the A8 held override. The run currently fails at import because `src/plugin.ts` doesn't exist yet (expected).
- Design choice explained to the student: only `src/index.ts` imports `openclaw`; the logic lives in `src/plugin.ts` so it can be unit-tested without OpenClaw.
- Student wrote `src/plugin.ts` (frozen readonly LOCAL/CLOUD overrides, safe prompt extraction) and `src/index.ts`. The assistant changed one test, at the student's request, to accept the frozen-object design (tampering throws or has no effect; later results unchanged). Assistant run: 3 files passed, 60 passed, 7 todo.
- At the student's request ("fix the issues"), the assistant fixed three things: `package.json` `openclaw.extensions` changed from the string `"/src/index.ts "` to the array `["./src/index.ts"]`; created `router/openclaw.plugin.json` (id `a3-router`, onStartup, empty strict configSchema); `index.ts` now uses `import { type HookApi, ... }`. Not changed (left for the student): `held` maps to CLOUD in `toOverride`; `toLocaleLowerCase` on the target.
- Assistant ran `npm test`: 60 passed, 7 todo. Also ran `openclaw plugins validate --root ./router --json`: `valid: false`, "plugin entry does not expose tool or feature authoring metadata". Per the bundled docs (`cli/plugins/authoring.md`), `validate` is for tool/feature scaffolds built with `plugins build`, so this doesn't show the hook plugin is broken. The real check is install + inspect, which hasn't been run yet.
- A4 first live test (student, 4:13 PM): the dashboard showed `Auth profile "openai:setup-…" is not configured for ollama`. The assistant traced it in the installed code (`prepareAgentRuntimeAuth` in `dist/prepare-auth-*.mjs`) and config: `agents.defaults.model` = `openai/gpt-6-astra@openai:setup-<id>` pins the OpenAI OAuth profile with source "user", and the pin is enforced against the hook-selected provider. Proposed fix: set the default model to `openai/gpt-6-astra` and start a new chat. Recorded in STATUS.md.
- A4 live test passed (student, 4:21–4:22 PM) after removing the `@profile` pin: "what is 12 times 9?" went to ollama/gemma4-a3:e2b, "explain step by step why sky is blue" went to openai/gpt-6-astra, in one fresh chat without `/model`. Corroborated by the assistant's `ollama ps` (Gemma loaded about 4:21) and the turn-2 prompt-cache line. Evidence saved to `evidence/2026-11-12-a4-auto-switch.txt` (assembled by the assistant from the student's pasted log). Also observed: the utility model `openai/gpt-5.6-luna` (label generation) returns 403 and bypasses the router. One 16:21:54 gpt-6-astra call is unexplained (not verified).
- Editor error TS2307 on `openclaw/plugin-sdk/plugin-entry` (openclaw isn't in router/node_modules; OpenClaw aliases the SDK only at runtime). The student chose option A; the assistant generated `router/tsconfig.json` (editor-only: `paths` to the global 2026.10.9 install, NodeNext, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, strict, noEmit). No `tsc` is installed, so the assistant didn't compile; the student checks the editor. Vitest still passes.
- The student accidentally edited `test/plugin.test.ts`; one wrong assertion expected `local -> ChatGPT`, another required `held -> ChatGPT`. At the student's request the assistant restored the committed version (HEAD 9bfe909), reapplied the frozen-object test fix, and changed the casts to `as unknown as Record<string,string>` (strict editor config). The mistaken version was kept outside the repo in the session temp dir. Assistant run: 60 passed, 7 todo.
- Editor underline in `index.ts` left unresolved at the student's request (tests and runtime work).

### 2026-11-12: Lesson A5 (decision logging), started
- Assistant wrote the tests first: `router/test/log.test.ts` (8 tests: exact field set, single line, JSON escaping, starts with `{`, no extra input fields copied, pure, one write, default clock) and 7 A5 tests appended to `router/test/plugin.test.ts` (one line per turn, runId as requestId, provider/model string, never logs message text, fallback requestId, a throwing logger doesn't change routing). They fail until the student writes `src/log.ts` and adds a writer parameter to `registerRouter`.
- At the student's request ("you complete the Wednesday work"), the assistant wrote `router/src/log.ts` (allowlisted `formatDecision`, `logDecision`, `stdoutWriter` using `process.stdout.write`) and the A5 changes in `src/plugin.ts` (writer parameter, `ctx.runId` or `local-<uuid>` requestId, log write wrapped in try/catch so a logging failure can't change routing). Assistant run: 4 files, 75 passed, 7 todo.
- Live checks by the assistant: `openclaw plugins reload a3-router`; two turns via `openclaw agent --session-key agent:main:a3-a5-test --json` (requested openai, effective ollama/gemma4-a3:e2b for the arithmetic prompt; openai/gpt-6-astra for "explain step by step"). Gemma answered "118" to 12×9 (wrong). The route_decision lines go to gateway stdout, which only the student's terminal shows: not verified by the assistant.

### 2026-11-12: F5 and exec policy (assistant, at the student's request)
- F5: created the disabled test job `a3-f5-test` (`openclaw cron add ... --every 24h --disabled --session isolated --no-deliver --light-context --message "[a3-cron] F5 test. Reply with exactly: ok"`) and ran it with `openclaw cron run <id>`. The file log shows `[hooks] provider overridden to openai` at 16:50:43; `cron runs` shows status ok on openai/gpt-6-astra. The heartbeat (16:43:50) also passed through the hook. Unexplained: the short cron message went to cloud (the cron prompt is probably wrapped; not verified).
- `openclaw exec-policy show`: profile full, no approval prompts. Recorded as a security finding.
- Evidence: `evidence/2026-11-12-a5-f5-cli-turns.txt`.

### 2026-11-12: Telegram bot + A5 live verification
- Student created `@chitti_assistant_bot` in BotFather, stored the token with `read -s` in `~/.config/chitti/telegram-bot-token` (chmod 600, outside the repo; length 46 confirmed, content never shown), and configured `channels.telegram` (tokenFile, pairing → allowlist with the numeric owner ID). A first attempt put the pairing code in `allowFrom`; OpenClaw rejected it (`Invalid allowFrom entry`) and the student replaced it with the numeric ID.
- Verified from the student's pasted gateway output: route_decision JSON lines start with `{`, requestId = OpenClaw runId, no message text; heartbeat → default-cloud; Telegram DM "hi" → Gemma → reply delivered in ~22 s. Evidence: `evidence/2026-11-12-a5-telegram-route-log.txt` (owner ID redacted).
- Observed: Gemma context pressure (28,850-token estimate > 24,576 budget) because Telegram shares session agent:main:main.
- Telegram `/new` test (student, 17:17): `/new` was handled as a command (no model turn, no route_decision); the `session-memory` hook saved the old context to `workspace/memory/2026-11-12-1717.md`. Then "What is 12 times 9?" → simple-task → Gemma, reply in ~7 s (vs ~22 s in the long session) with no context-pressure warning.

### 2026-11-12: M1 cloud foundation (generated and explained; student ran every step)
- Mode: generated and explained (LEARNING_PATH). The assistant (OpenCode, Claude Opus 5.5) explained each step and gave commands/console steps; the student ran them in the terminal or the GCP / Tailscale consoles and pasted results. No cloud command was run by the assistant; it ran only read-only local checks (`gcloud config list`, `gcloud beta run instances --help`, `tailscale serve --help`) and fetched docs (Cloud Run locations, Tailscale grants and targets).
- Student created the separate gcloud configuration `chitti-a3`, project `chitti-assistant-a3`, linked billing and created a $25 budget (console), enabled the six APIs (console), created service account `a3-agent` with only Logs Writer at project level, the bucket `gs://chitti-assistant-a3-state` with Storage Object Admin for the SA on that bucket only. Verification output saved by the student to `evidence/2026-11-12-m1-steps1-3.txt` (the assistant redacted the email).
- A `gcloud billing projects describe` check returned 429 on gcloud's shared quota project (32555940559); the student checked billing in the console instead.
- Tailscale: student installed the standalone app (1.104.7), enabled MagicDNS and HTTPS, saved the deny-by-default policy written by the assistant (the student's first paste was missing a comma between members; the assistant then gave the full file at the student's request), created a reusable, non-ephemeral `tag:a3-agent` auth key and stored it in Secret Manager `tailscale-authkey` with secretAccessor for `a3-agent` only. The key was never shown in chat or the terminal.
- Student ran `tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434`. Curl tests: tailnet name → 403, Host rewritten to 127.0.0.1 → 200, LAN IP → 000. Finding recorded in STATUS.md: the M2 forwarder must rewrite Host. Evidence: `evidence/2026-11-12-m1-tailscale.txt` (assembled by the assistant from the student's pasted output).
- Not verified: the agent → laptop path from a tagged node (needs the M2 container).
- At the student's request ("write it"), the assistant saved a copy of the console policy as `deploy/tailscale-policy.hujson` (no secrets; tailnet IP and tag names only).
