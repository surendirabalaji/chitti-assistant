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
- [ ] GCP project, billing budget alert, region (us-west1 unless told otherwise)
- [ ] Enable APIs: Cloud Run, Artifact Registry, Secret Manager, Cloud Storage, Cloud Logging
- [ ] Service account for the instance (least privilege: bucket objectAdmin on one bucket, secretAccessor on named secrets, log writer)
- [ ] Bucket for snapshots + Tailscale state
- [ ] Tailscale: `tag:a3-agent`, grants (agent → laptop tcp:11434; members+shared → agent tcp:443), HTTPS certs + MagicDNS on, **reusable non-ephemeral** auth key → Secret Manager `tailscale-authkey`
- [ ] Laptop: `tailscale serve` exposing Ollama `tcp:11434 -> 127.0.0.1:11434`

## M2 Vertical slice (4–6 h)
- [ ] `deploy/package.json` + `package-lock.json` pinning openclaw 2026.10.9 (resolved with `--before`)
- [ ] Dockerfile `node:24.22.1-bookworm-slim`, non-root user, `npm ci`, Tailscale binaries, writable `/var/run/tailscale`
- [ ] Startup script: read secrets → restore state → tailscaled (userspace, SOCKS5 :1055, state on bucket) → tailscale up → serve :443 → forwarder → isolation report → `openclaw gateway run`
- [ ] Ollama forwarder on 127.0.0.1 → laptop via `socks5h://127.0.0.1:1055`; logs `ollama_call`
- [ ] OpenClaw config template for the container (single agent, minimal plugins, browser import off, dreaming off, failover off)
- [ ] Cloud ChatGPT sign-in (browser flow, separate from laptop) and auth file persisted to bucket
- [ ] Deploy as **Cloud Run Instance**; one cloud and one local reply through the deployed dashboard, visible in Cloud Logging

## M3 Router (4–5 h) — see ROUTER_SPEC.md
- [ ] Rules 1–6 with precedence, privacy keyword list in config
- [ ] Health poller (10 s, 3 s timeout, 2 fails = down, 1 success = up), cached state, `health` log on change
- [ ] Held reply via `before_agent_reply`; logs target `held`, model `none`, ok false
- [ ] Simulated rate-limit flag + documented toggle command
- [ ] `route_decision` + `route_result` with shared requestId; session size estimate for `long-context`
- [ ] OpenClaw automatic model failover disabled
- [ ] Four video prompts route local → cloud → held → local; video log command works

## M4 Skills and email gate (4–6 h)
- [ ] Telegram channel; command owner set to the student's Telegram id
- [ ] Throwaway Gmail account; gog email + calendar working (OAuth testing mode; renew within 7 days)
- [ ] Web search + weather working
- [ ] `send-email` wrapper: recipient allowlist, refuses others (logged), only send path
- [ ] Exec policy: wrapper requires human approval every time; other mail-send paths disabled
- [ ] Tests: approval required; non-allowlisted refused; cron produces draft only

## M5 focus-finder (2–3 h)
- [ ] `skills/focus-finder/SKILL.md` + script: read-only, gaps ≥ 45 min between 9 AM–6 PM
- [ ] Local test; `clawhub skill publish ./skills/focus-finder --dry-run`
- [ ] Publish (ask first; releases under MIT-0); record URL + version
- [ ] Fresh install from ClawHub on the agent; save transcript

## M6 Proactive jobs (3–4 h)
- [ ] Briefing 7:30 AM: events + gaps (focus-finder), weather, top unread email summaries → Telegram
- [ ] Recap 6:00 PM: actual activity from logs, drafts awaiting approval, tomorrow's first events
- [ ] Alerts every 5 min for events 15–30 min ahead; dedupe by event id across restarts
- [ ] Hourly evidence job (cloud request + health line)
- [ ] Run-now works for briefing and recap; missed-job catch-up (briefing before noon)

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
