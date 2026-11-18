# Chitti: a proactive personal assistant on OpenClaw (CSCI 599, Assignment 3)

Chitti is a personal assistant that runs 24/7 in a container on **Google Cloud Run Instances**, talks to its owner over **Telegram**, and routes every model turn between a **cloud model (ChatGPT via OpenClaw OAuth)** and a **local model (Gemma 4 E2B on the owner's MacBook via Ollama, reached over Tailscale)**. It reads a class-only Gmail/Calendar test account, sends a morning briefing, an evening recap and meeting alerts on its own, remembers things across sessions and restarts, and can send email only through a code-enforced approval gate.

Other submission documents:
- [SECURITY_AUDIT.md](SECURITY_AUDIT.md): risks, mitigations, remaining risks, approval gate, isolation report
- [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md): latency, quality and cost per task type, routing evidence
- [PROCESS_LOG.md](PROCESS_LOG.md): tools/models used, narrative, AI-generated code attribution, verification
- `evidence/`: dated command outputs and log exports (secrets redacted, owner chat id never copied)

## Deployment

| Item | Value |
|---|---|
| Platform | OpenClaw **2026.10.9 (8b18b55)**, Node **v24.22.1** (from the Cloud Run boot log, 2026-11-15T11:05:55Z) |
| Runtime | Cloud Run **Instance** `a3-agent`, project `chitti-assistant-a3`, region `us-west1`, 1 vCPU / 4 GiB |
| Image | `us-west1-docker.pkg.dev/chitti-assistant-a3/a3/agent:2026-11-15b` (`sha256:8a4311f4221065ddeb17df3441bc90c4c687a318c2f45ae661e0c144cb1baa68`) |
| URL | `https://a3-cloud-agent.tail9bf1e8.ts.net/` (tailnet only; no public URL, `--no-default-url`, no container port). Grader access details are in the Brightspace comment. |
| Cloud model | `openai/gpt-6-astra` (ChatGPT Edu, OpenClaw OAuth; separate sign-in from the laptop's) |
| Local model | `gemma4-a3:e2b` = Gemma 4 E2B, 32K context ([local/Modelfile.a3-e2b](local/Modelfile.a3-e2b)), Ollama 0.40.16 on a MacBook Air M4 16 GB |
| Messaging | Telegram bot `@chitti_assistant_bot`, owner-only allowlist, groups disabled |
| State | Cloud Storage bucket `chitti-assistant-a3-state` mounted at `/mnt/state` |

### Architecture

```
Telegram / dashboard (tailnet)
        │
        ▼
Cloud Run Instance a3-agent (container, user agent uid 10001, no Linux capabilities)
  ├─ OpenClaw gateway 127.0.0.1:18789  ── Tailscale Serve :443 (OpenClaw-managed, Tailscale identity login)
  │    ├─ a3-router plugin (before_model_resolve) ── decides local / cloud / held per turn, logs metadata
  │    ├─ ChatGPT (openai/gpt-6-astra) ◄── cloud turns
  │    └─ ollama provider → 127.0.0.1:11435
  ├─ Ollama forwarder (router/src/forwarder.ts) ── rewrites Host, logs each call
  │    └─ SOCKS5h 127.0.0.1:1055 → userspace tailscaled ──► tailnet
  ├─ scheduled jobs (OpenClaw cron): alerts, briefing, recap, hourly evidence, snapshots, a3-watch
  └─ /mnt/state (bucket): snapshots, Tailscale state, encrypted gog keyring, alert dedupe
                                   │ tailnet (grant: tag:a3-agent → laptop tcp:11434 only)
                                   ▼
MacBook: tailscale serve --tcp 11434 → 127.0.0.1:11434 Ollama (never 0.0.0.0) → Gemma 4 E2B
```

Ollama rejects requests whose Host header is the tailnet name (403), so the forwarder rewrites it to `127.0.0.1:11434` ([evidence/2026-11-12-m1-tailscale.txt](evidence/2026-11-12-m1-tailscale.txt)).

## Routing

The router is an OpenClaw plugin ([router/](router/), spec [doc/a3/ROUTER_SPEC.md](doc/a3/ROUTER_SPEC.md)). For every model turn (chat, Telegram, cron), the `before_model_resolve` hook picks the provider and model. The decision function is pure and unit-tested (253 Vitest tests).

Order of checks:
1. **Privacy** (fixed patterns, e.g. "confidential", "password", secret-looking values; Gemma may add privacy but never remove it). Local up → **local** (`privacy-sensitive`). Local up but the chat is over 20k tokens → **held** (`privacy-long-context`, Gemma's window can't fit it). Local down → **cloud** (`privacy-local-unavailable`, see policy below).
2. **Long chat** over 20k estimated tokens → cloud (`long-context`).
3. **Scheduled jobs** (cron/heartbeat) → cloud (`tool-task`).
4. **Long messages** (> 400 chars) → cloud (`reasoning-heavy`).
5. **Follow-up**: a short answer to a question ChatGPT just asked (≤ 5 min, verified by Gemma) → cloud (`follow-up`).
6. **Gemma label** (2 s timeout): tool / reasoning / memory → cloud (`tool-task`, `reasoning-heavy`, `memory-task`); simple → local (`simple-task`).
7. **Scoring fallback** when Gemma is slow or down: arithmetic and short messages → local, tool words/dates/times and reasoning words → cloud, anything else → `default-cloud`.

If a turn would go local but the laptop is down, it goes to the cloud (`local-unavailable`). A health poller checks the laptop every 10 s through the forwarder.

**Simulated rate limit (reversible):** `openclaw config set plugins.entries.a3-router.config.simulateRateLimit true --strict-json` (run as user `agent` over instance SSH, env from [deploy/LOGIN.md](deploy/LOGIN.md)); hot reload, no restart. Every cloud outcome then goes local (`cloud-rate-limited`), or gets a "cloud unavailable" reply with target `none` when local is down too. Set it back with `false`; the config template also resets it to `false` on every boot. No real quota is exhausted.

### Private-task policy

- Private message, laptop reachable → answered by **local Gemma** only.
- Private message, laptop **off** → answered by **ChatGPT** (`privacy-local-unavailable`, target `cloud`). This was a deliberate choice (Nov 13) so the assistant stays useful when the laptop sleeps. The policy is one config switch: `privateWhenLocalDown: "held"` makes those messages **held** instead (a reply says it was held; nothing is queued; the user resends later).
- Private message in a chat over 20k tokens → **held** (asks the user to start a new chat with `/new`).
- So this assistant does **not** promise that private data never leaves the laptop. Also, OpenClaw sends the whole chat history with every turn: a later cloud turn in the same chat carries earlier private messages. Keep private topics in their own chat (`/new`).

Verified on the deployed agent on Nov 17 (7:27 PM PST): with Ollama quit, a confidential message → `privacy-local-unavailable`, cloud, ok (9.5 s); after Ollama was back → `privacy-sensitive`, local, ok (23.3 s) ([evidence/2026-11-17-evening-overload.txt](evidence/2026-11-17-evening-overload.txt)).

### Routing log

One JSON line per event in Cloud Logging, **metadata only, never message text**: `route_decision` (rule, target, model, via, localHealthy, sessionSizeEst, rateLimitSimulated, signal names), `route_result` (servedModel, ok, latencyMs, short error code), with the same `requestId`; plus `health` (up/down), `ollama_call` (path, status, latency) and `session_reset`.

```sh
gcloud logging read 'jsonPayload.component="a3-router" AND jsonPayload.kind=("route_decision" OR "route_result" OR "health")' \
  --project=chitti-assistant-a3 --freshness=30m --order=desc \
  --format="table(timestamp.date('%H:%M:%S'),jsonPayload.kind,jsonPayload.rule,jsonPayload.target,jsonPayload.model,jsonPayload.servedModel,jsonPayload.ok,jsonPayload.latencyMs,jsonPayload.to)"
```

## Skills

| Skill | What it does | Notes |
|---|---|---|
| Calendar + email (`gog` v0.47.1) | Read calendar, search/read Gmail, create drafts | Agent-facing wrapper [deploy/gog-agent.sh](deploy/gog-agent.sh) forces `--gmail-no-send` and `--wrap-untrusted`; tokens in an encrypted keyring on the bucket |
| Web search | Parallel Search (Free), `@openclaw/parallel-plugin@2026.10.9` | key-free; the ChatGPT OAuth connection has no built-in search |
| Weather | Bundled `weather` skill via `web_fetch` to wttr.in | key-free |
| **focus-finder** (original) | Free focus blocks from today's calendar | [skills/focus-finder/](skills/focus-finder/), published on ClawHub (below) |
| send-email | The **only** way to send mail: recipient allowlist + human approval | [skills/send-email/](skills/send-email/), see SECURITY_AUDIT.md |

## Proactive features and scheduling

All jobs are OpenClaw cron jobs (no sleep loops), installed idempotently at boot by [deploy/jobs/install-jobs.sh](deploy/jobs/install-jobs.sh), time zone America/Los_Angeles:

| Job | Schedule | What |
|---|---|---|
| `a3-briefing` | 7:30 AM daily | Today's events, focus time (focus-finder), LA weather, up to 5 unread mails → Telegram ([deploy/jobs/briefing.md](deploy/jobs/briefing.md)) |
| `a3-recap` | 6:00 PM daily | Activity counts (requests local/cloud/held, alerts, laptop checks), today's meetings, drafts waiting for approval, tomorrow → Telegram ([deploy/jobs/recap.md](deploy/jobs/recap.md)) |
| `a3-alerts` | every 5 min | Telegram alert for each primary-calendar event starting in 15–30 min, once per event (dedupe file on the bucket) |
| `a3-hourly-health` | :00 hourly | Laptop reachability + uptime line (48-hour evidence) |
| `a3-hourly-cloud` | :05 hourly | Tiny cloud turn ("Reply with exactly: OK") as uptime evidence |
| `a3-state-snapshot` | every minute (snapshots when due) | State backup to the bucket (see Memory) |
| `a3-watch` | every 5 min | Telegram diff when USER.md / MEMORY.md change; reports scheduled jobs not created by the installer |

Scheduled jobs only read and draft: their prompts forbid sending, and the exec policy denies any unapproved command when no human is there to approve it.

Advanced features: **morning briefing, evening recap, proactive meeting alerts, email integration** (read/search/summarize, drafts, approved sends).

## Advanced integration: focus-finder on ClawHub

- Public page: https://clawhub.ai/surendirabalaji/focus-finder, version **1.0.0** (pinned), license MIT-0, ClawHub scan "clean" / "Security audit: Pass" ([evidence/2026-11-14-m5-clawhub-publish.txt](evidence/2026-11-14-m5-clawhub-publish.txt)).
- Usage: `gog calendar events --today --json | focus-finder` (reads JSON on stdin, prints free blocks of 45+ min; no network, no credentials).
- Fresh install from ClawHub on the cloud agent + real run: free blocks 09:00–15:30 and 17:15–18:00, a 30-min gap correctly left out ([evidence/2026-11-14-m5-cloud-install.txt](evidence/2026-11-14-m5-cloud-install.txt)).
- The container also has a root-owned copy of the same v1.0.0 file (same sha256) at `/usr/local/bin/focus-finder`, which is what the allowlist permits (the workspace copy is agent-writable, so it is not allowlisted).

## Memory and persistence

- Persona files (synthetic): [workspace/SOUL.md](workspace/SOUL.md), [workspace/USER.md](workspace/USER.md) (fictional owner "Kavin"), [workspace/IDENTITY.md](workspace/IDENTITY.md), [workspace/AGENTS.md](workspace/AGENTS.md).
- OpenClaw memory: `/new` saves the previous session to `memory/<date>.md` (session-memory hook); the agent can also write to USER.md / MEMORY.md and search them with `memory_search`.
- **Durability across restarts:** the whole OpenClaw state (chats, memory, ChatGPT login) is backed up with OpenClaw's own `backup create --verify` to `gs://chitti-assistant-a3-state/a3/snapshots/` every 5 min and within a minute of a login change (6 kept). At boot, [deploy/jobs/restore.mjs](deploy/jobs/restore.mjs) restores the newest good snapshot before anything else writes the state. Tailscale state and the gog keyring live directly on the bucket.
- Evidence: recall across sessions ("What car do I have?" in a fresh chat → correct, [evidence/2026-11-15-14e-cloud-memory-tests.txt](evidence/2026-11-15-14e-cloud-memory-tests.txt)); restart test (login and a USER.md line kept through 2 restarts, [evidence/2026-11-15-m6-m7-cloud-deploy.txt](evidence/2026-11-15-m6-m7-cloud-deploy.txt)).

## 48-hour run

Sun Nov 15, 8:45 AM PST → Tue Nov 17, 8:45 AM PST on image `2026-11-15b` ([evidence/2026-11-17-48h-run-complete.txt](evidence/2026-11-17-48h-run-complete.txt), start [evidence/2026-11-15-48h-run-start.txt](evidence/2026-11-15-48h-run-start.txt), checkpoint [evidence/2026-11-15-48h-run-checkpoint-14h.txt](evidence/2026-11-15-48h-run-checkpoint-14h.txt)):
- No restart: one container id throughout; uptime 194,046 s (53.9 h) at 17:00 UTC Nov 17.
- Hourly laptop checks: 49/49 up. Hourly cloud turns and scheduled jobs: 53/53 ok (48 hourly, 2 briefings, 2 recaps, 1 warm-up).
- 582 alert checks, 581 watch checks, 476 snapshots; 2 snapshot timeouts, each fixed by the next run.
- **No local Gemma turns inside the window**: nobody chatted, and scheduled jobs always route to the cloud. Local routing is shown by the warm-up turn just before the window and by the tests and video.

## Repository layout

```
deploy/      Dockerfile, startup.sh, openclaw.template.json5, exec-approvals.json5, gog-agent.sh,
             package.json + lockfile (pinned OpenClaw), jobs/ (cron scripts + prompts), LOGIN.md,
             tailscale-policy.hujson
router/      a3-router OpenClaw plugin (TypeScript): decide.ts, signals.ts, classifier.ts, health.ts,
             plugin.ts, log.ts, forwarder.ts, socks5.ts + Vitest tests
skills/      focus-finder (ClawHub), send-email (allowlist + approval)
workspace/   SOUL.md, USER.md, IDENTITY.md, AGENTS.md (synthetic persona)
local/       Modelfile.a3-e2b, classifier/follow-up benchmarks
doc/         course PDFs, design, plan, status, router spec
evidence/    dated evidence files
.env.example placeholders for every secret/variable (no real values)
```

## How to build, deploy and test

Tests (laptop, Node 24.22.1):
```sh
cd router && npm ci && npm test                       # 253 tests
node --test deploy/jobs/*.test.mjs skills/send-email/*.test.mjs skills/focus-finder/*.test.mjs   # 80 tests
```

Laptop side:
```sh
ollama create gemma4-a3:e2b -f local/Modelfile.a3-e2b
tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434      # tailnet only; Ollama stays on 127.0.0.1
caffeinate -dims                                           # keep the Mac awake while the agent needs it
```

Cloud side (one-time setup: project, bucket, service account without keys, secrets in Secret Manager, Tailscale policy from [deploy/tailscale-policy.hujson](deploy/tailscale-policy.hujson); names in [.env.example](.env.example)):
```sh
docker build --platform linux/amd64 -f deploy/Dockerfile -t us-west1-docker.pkg.dev/<project>/a3/agent:<tag> .
docker push us-west1-docker.pkg.dev/<project>/a3/agent:<tag>
gcloud beta run instances deploy a3-agent --region=us-west1 --image=<image@digest> \
  --service-account=<runtime-sa> --no-default-url --cpu=1 --memory=4Gi \
  --set-secrets=TS_AUTHKEY=tailscale-authkey:latest,TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,GOG_KEYRING_PASSWORD=gog-keyring-password:latest,GOG_OAUTH_CLIENT_JSON=gog-oauth-client:latest \
  --set-env-vars=GOG_ACCOUNT=<test-account>,TELEGRAM_OWNER_ID=<owner-id> \
  --add-volume='name=state,type=cloud-storage,bucket=<bucket>,mount-options=uid=10001;gid=10001' \
  --add-volume-mount=volume=state,mount-path=/mnt/state --restart-policy=on-failure --startup-probe=""
```
Then, once: ChatGPT browser sign-in and gog sign-in over `gcloud beta run instances ssh` as user `agent` ([deploy/LOGIN.md](deploy/LOGIN.md)). Device-code sign-in is blocked for the USC ChatGPT workspace, so the browser flow with the pasted localhost callback URL is used. After a restart, the login comes back from the latest snapshot.

## Assumptions and known limits

- **1 vCPU.** Turns are slow (median 32.5 s even for the trivial hourly turn) and the agent overloads when interactive turns, dashboard polling and the CPU-heavy snapshot overlap: turns of 50–150 s, snapshot timeouts. On Nov 17 evening this got bad enough that a briefing run-now came back with every section "(unavailable)"; it recovered without a restart once the dashboard tab was closed ([evidence/2026-11-17-evening-overload.txt](evidence/2026-11-17-evening-overload.txt)). 2 vCPU would help; it was not chosen to keep cost down.
- First turn after a boot takes about 90 s; Telegram replies are slow for about 10 min after a boot.
- The final snapshot on shutdown has an 8 s limit, which was too short once (Nov 15); the boot then restored the snapshot from 4 minutes earlier. A ChatGPT token refreshed after the last good snapshot would be lost and need a new sign-in.
- One Telegram send failed with a network error (Nov 17, 8:16 PM); OpenClaw does not resend when it can't tell whether the first send arrived. Running the job again delivered it.
- Each router health line appears twice (two pollers in the gateway process; cause not found, routing unaffected).
- USER.md is 4,006 characters; OpenClaw's limit is 4,000, so the last few characters are cut from prompts.
- `a3-watch` cannot see a one-shot job that is created and removed between two 5-minute checks.
- After `/new`, OpenClaw may show "Model Fallback … selected model unavailable"; it is cosmetic (the router chose Gemma, no model failed).
- The Gmail/Calendar OAuth app is in Testing mode, so the gog token expires about Nov 21; re-run the gog sign-in in [deploy/LOGIN.md](deploy/LOGIN.md) (no restart needed).
- Boot catch-up of missed briefing/recap was not verified in the cloud. Recap and briefing run-now were verified on Nov 17.
- Gemma's quality is limited: it answered "12 times 9" as 118 once in a CLI test (correct, 108, from the cloud agent), and it does not use memory tools, so memory statements and questions are routed to the cloud.
- Held means: the user gets a reply saying the message was held; nothing is queued.
