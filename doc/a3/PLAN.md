# Development plan

Tick boxes as work is **verified**, not just written. Effort ranges are estimates.

## Calendar (PST)

| Day | Focus |
|---|---|
| Wed Nov 11 | M0 feasibility (F1–F4 done), minimal router plugin, F3 automatic, F5. Create Gmail test account + Telegram bot |
| Thu Nov 12 | M1 cloud foundation, M2 vertical slice deployed |
| Fri Nov 13 | M3 full router, M4 skills + email gate, M5 focus-finder published |
| Sat Nov 14 | M6 proactive jobs, M7 memory/restart, M8 grader access + video dry run. ~8 PM: freeze, start overnight trial run |
| Sun Nov 15 | Review trial; one fix if needed; **~9 AM final deploy → 48-hour run starts**. README, audit, perf measurements |
| Mon Nov 16 | Renew Google sign-in, seed test meeting, rehearse, **record video**. Perf report, ClawHub install transcript |
| Tue Nov 17 | ~9 AM run ends. Export evidence, finish docs, secret scan, ZIP, Brightspace. **Submit by 6 PM**. Optional injection tests after |

## M0 Feasibility (laptop)
- [x] F1 pinned versions (OpenClaw 2026.10.9, Node 24.22.1)
- [x] F2 ChatGPT OAuth login and reply
- [x] F4 Gemma E2B 32K agent turn with tool
- [x] F3 manual model switching in one chat
- [x] Minimal router plugin (one rule + decision log): Lessons A1–A5 (Nov 12; the stdout line still needs a terminal check by the student)
- [x] F3 automatic switching via plugin (Nov 12, evidence/2026-11-12-a4-auto-switch.txt)
- [x] F5 cron turn passes through the plugin; run-now = `openclaw cron run <id>` (Nov 12)
- [x] Inspect effective exec policy (`openclaw exec-policy show`) and record (Nov 12: full, no approvals)

## M1 Cloud foundation (2–3 h) — ask before each cloud command
- [x] GCP project `chitti-assistant-a3`, billing linked, budget alert $25 (50/90/100%), region us-west1 (Cloud Run Instances supported there per docs) (Nov 12)
- [x] Enable APIs: Cloud Run, Artifact Registry, Secret Manager, Cloud Storage, Cloud Logging (+ billingbudgets) (Nov 12)
- [x] Service account `a3-agent` (no keys): objectAdmin on the state bucket, secretAccessor on `tailscale-authkey`, project logWriter (Nov 12)
- [x] Bucket `gs://chitti-assistant-a3-state` (us-west1, uniform access, public access prevention enforced) (Nov 12)
- [x] Tailscale: `tag:a3-agent`, grants (agent → laptop tcp:11434; members+shared → agent tcp:443), policy test passes, HTTPS certs + MagicDNS on, **reusable non-ephemeral** auth key → Secret Manager `tailscale-authkey` (Nov 12)
- [x] Laptop: `tailscale serve` exposing Ollama `tcp:11434 -> 127.0.0.1:11434` (Nov 12; tailnet Host header → 403, forwarder must send `Host: 127.0.0.1:11434`)

## M2 Vertical slice (4–6 h)
- [x] `deploy/package.json` + `package-lock.json` pinning openclaw 2026.10.9 (resolved with `--before`, generated in linux/amd64 `node:24.22.1-bookworm-slim`; pinned `allowScripts` for 5 packages) (Nov 12). `npm ci` in the image ok Nov 13
- [x] Dockerfile `node:24.22.1-bookworm-slim`, non-root user, `npm ci`, Tailscale binaries, writable `/var/run/tailscale`. **Written Nov 13** (digest-pinned base, Tailscale 1.104.7 checksum-verified, uid 10001, root-owned code, allowlist `.dockerignore`; `docker build --check` clean). **Built + smoke-tested locally Nov 13** (amd64, uid 10001, no install-scripts warning, gateway ready with 4 plugins on loopback only)
- [x] Startup script: read secrets → restore state → tailscaled (userspace, SOCKS5 :1055, state on bucket) → tailscale up → serve :443 → forwarder → isolation report → `openclaw gateway run`. **Written Nov 13** (`bash -n` + shellcheck clean; Serve is done by OpenClaw `gateway.tailscale.mode: serve`; restore/snapshot = M7 TODO; device-code login on first boot); not run yet
- [x] Ollama forwarder on 127.0.0.1 → laptop via `socks5h://127.0.0.1:1055`; logs `ollama_call`. **Done Nov 13** (Lesson A10, assistant-written at the student's request; laptop `evidence/2026-11-13-a10-forwarder-laptop.txt`, cloud `evidence/2026-11-13-m2-forwarder-cloud.txt`)
- [ ] OpenClaw config template for the container (single agent, minimal plugins, browser import off, dreaming off, failover off). **Written + validated locally Nov 13** (`config validate` ok, `doctor --lint` 3 info warnings, 4 plugins enabled); runtime in the container not verified
- [ ] Cloud ChatGPT sign-in (browser flow, separate from laptop) and auth file persisted to bucket. **Sign-in done Nov 13** (instance SSH as `agent`, `Inference verified: openai/gpt-6-astra`); persistence to bucket = M7 (login lost on restart until then)
- [ ] Deploy as **Cloud Run Instance**; one cloud and one local reply through the deployed dashboard, visible in Cloud Logging. **Cloud reply done Nov 13 09:29 UTC** (`evidence/2026-11-13-m2-cloud-reply.txt`); **local reply done Nov 13 19:39 UTC** (`evidence/2026-11-13-m2-forwarder-cloud.txt`; ~90 s end to end on 1 vCPU, Gemma 15.6 s)

## M3 Router (4–5 h) — see ROUTER_SPEC.md
- [x] Rules 1–6 with precedence, privacy keyword list in config. **Done Nov 13 (Lesson A6, assistant-written at the student's request)**; lists are in `DEFAULT_CONFIG` in code, reading them from plugin config is A9. Laptop-verified (`evidence/2026-11-13-a6-rules-laptop.txt`). **Router v2 (layered: fixed checks + Gemma label + scoring fallback) done Nov 13**, laptop-verified (`evidence/2026-11-13-router-v2-laptop.txt`); not in the cloud image yet
- [x] Health poller (10 s, 3 s timeout, 2 fails = down, 1 success = up), cached state, `health` log on change. **Done Nov 13 (A7, assistant-written), laptop-verified** (`evidence/2026-11-13-a7-a8-a9-laptop.txt`)
- [x] Held reply via `before_agent_reply`; logs target `held`, model `none`, ok false. **Done Nov 13 (A8), laptop-verified**; utility model moved to local Gemma so held turns make no cloud call
- [x] Simulated rate-limit flag + documented toggle command (ROUTER_SPEC "Rate-limit switch"; README text is the student's). **Done Nov 13 (A9), laptop-verified**
- [x] `route_decision` + `route_result` with shared requestId; session size estimate for `long-context`. **Done Nov 13 (A6 + A9), laptop-verified**
- [ ] OpenClaw automatic model failover disabled (**verified Nov 13: a failed Ollama turn is retried on the same model only, never on ChatGPT**; tick after checking the container config)
- [ ] Four video prompts route local → cloud → held → local; video log command works

## M4 Skills and email gate (4–6 h)
- [x] Telegram channel; command owner set to the student's Telegram id (cloud, Nov 14)
- [x] Throwaway Gmail account; gog email + calendar working (OAuth testing mode; renew within 7 days → ~Nov 20)
- [x] Web search + weather working (Parallel free + wttr.in, cloud Nov 14)
- [x] `send-email` wrapper: recipient allowlist, refuses others (logged), only send path (cloud Nov 14)
- [x] Exec policy: wrapper requires human approval every time; other mail-send paths disabled (gog `--gmail-no-send`; reads allowlisted)
- [ ] Tests: approval required ✅; non-allowlisted refused ✅; cron produces draft only (test in M6)

## M5 focus-finder (2–3 h)
- [x] `skills/focus-finder/SKILL.md` + script: read-only, gaps ≥ 45 min between 9 AM–6 PM (Nov 14; 26 tests; real gog JSON shape still to check)
- [x] Local test; `clawhub skill publish ./skills/focus-finder --dry-run` (Nov 14; needs an absolute path in clawhub 0.24.1)
- [x] Publish (ask first; releases under MIT-0); record URL + version → https://clawhub.ai/surendirabalaji/focus-finder v1.0.0 (Nov 14, audit Pass)
- [x] Fresh install from ClawHub on the agent; save transcript (Nov 14; `skills info` Ready from openclaw-workspace; real-gap check 09:00–15:30 + 17:15–18:00 correct; `evidence/2026-11-14-m5-cloud-install.txt`)

## M6 Proactive jobs (3–4 h)
Code done + local container test Nov 14 (`evidence/2026-11-14-m6-jobs-local.txt`); tick each after the cloud test.
- [ ] Briefing 7:30 AM: events + gaps (focus-finder), weather, top unread email summaries → Telegram (`deploy/jobs/briefing.md`)
- [ ] Recap 6:00 PM: actual activity from logs (`a3-activity`), drafts awaiting approval, tomorrow's first events (`deploy/jobs/recap.md`)
- [ ] Alerts every 5 min for events 15–30 min ahead; dedupe by event id across restarts (local: scheduled slot fired, error path ok)
- [ ] Hourly evidence job (cloud request + health line) (`a3-hourly-cloud` at :05, `a3-hourly-health` at :00)
- [ ] Run-now works for briefing and recap; missed-job catch-up (briefing before noon, recap before 22:00; `skipMissedJobs: true` + `catchup.mjs` at boot)
- [ ] Cron draft-only test (from M4): one-off job asking to email → send-email denied (askFallback deny), no send

## M7 Memory and restart (3–4 h)
- [ ] Snapshot agent (5 min), auth-file-on-change copy, SQLite backup API, atomic upload, final snapshot on SIGTERM
- [ ] Restore before gateway start; `state-restored` log
- [ ] Persona files (SOUL.md, USER.md, IDENTITY.md) synthetic
- [ ] Restart test: same Tailscale name, preference recalled in fresh chat, ChatGPT still logged in

## M8 Grader access and rehearsal (2–3 h)
- [ ] `gateway.auth.allowTailscale true`, `gateway.controlUi.allowedOrigins` exact URL, socket link, Serve :443
- [ ] Fresh browser session opens dashboard with no token; laptop off → non-private question answered by cloud
- [ ] Full video dry run under 12 minutes

## M9 Run, docs, submission
- [ ] Overnight trial run Nov 14 → review
- [ ] 48-hour run; export logs every 12 h
- [ ] README (setup, architecture, routing rules, held policy, privacy statement, rate-limit toggle, run-now)
- [ ] Security audit (≥5 risks, mitigations, remaining risks, approval + allowlist, isolation report)
- [ ] Performance report (≥3 task types; latency, quality, cost; measured only)
- [ ] PROCESS_LOG.md complete (student writes narrative + reflection)
- [ ] Video recorded per REQUIREMENTS.md
- [ ] Secret scan; ZIP `firstname_lastname_a3.zip`; Brightspace comment with access details
