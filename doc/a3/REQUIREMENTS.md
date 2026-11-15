# Requirements checklist (grading-critical)

Source of truth: `doc/course/` PDFs. The Local Gemma guide replaces the Description's 5–7 min video with one 10–12 min (max 12) recording.

## Rubric
Routing 20% · proactive features 15% · security 15% · skills/utility 15% · memory/personalization/scheduling 15% · code/docs/demo 10% · advanced integration 10% (part of the base 100%).

## Must exist
- [ ] Cloud agent on **Cloud Run Instances** (not Services), containerized
- [ ] Cloud model (ChatGPT OAuth) + local Gemma 4 via Ollama on student hardware over Tailscale; both really execute
- [ ] Task-aware routing with Cloud Logging line per request: time, route (local/cloud/held), reason, model, success; no message text
- [ ] Reversible simulated rate limit; no real quota exhaustion
- [ ] Non-private tasks answered by cloud while laptop is off; private-task policy (held) stated in README and matching logs
- [ ] Telegram integration
- [ ] ≥ 4 skills: calendar, email, web search, + one more (weather; focus-finder also)
- [ ] ≥ 4 advanced features: briefing, recap, alerts, email integration
- [ ] Persistent memory across sessions **and restarts**, durable via Cloud Storage bucket
- [ ] Cron/heartbeat scheduling (scheduled polling OK; sleep loop not OK)
- [ ] 48-hour continuous operation with evidence across the whole window (managed restarts OK if recovery verified; record outages honestly)
- [ ] Container isolation + ≥ 1 more measure; startup isolation report
- [ ] **Every email send needs human approval enforced in code** + recipient allowlist; scheduled jobs only draft
- [ ] Secrets never in git/source/image/logs/video; grader credentials via Brightspace only
- [ ] Throwaway class-only accounts with synthetic data for email, calendar, messaging
- [ ] Advanced integration: focus-finder published on ClawHub (original), public URL + pinned version, fresh install + run evidence

## Submission ZIP `firstname_lastname_a3.zip`
- [ ] Root README; source/config/skills/router/scheduling/deployment files; `.env.example` placeholders
- [ ] Deployment URL + 48-hour evidence; bucket persistence evidence
- [ ] Security audit: ≥ 5 risks, implemented mitigations, remaining risks with rationale, isolation evidence, approval gate + allowlist
- [ ] Performance report: ≥ 3 task types; response time, quality, cost; routing decisions and evidence; measured numbers only
- [ ] Personalization files (SOUL.md, USER.md, IDENTITY.md), synthetic
- [ ] Root `PROCESS_LOG.md`: tools/models; 200–300 word chronological narrative with material prompts (student's words); AI-generated code attribution; verification narrative; 2–3 sentence learning reflection
- [ ] MP4 `Assignment3-CSCI599-USCusername.mp4`

## Video script (Local Gemma guide Part 4)
1. Hardware UUID. 2. Running OpenClaw version from Cloud Run startup log. 3. `ollama list` + `tailscale serve status` (tcp:11434 → 127.0.0.1:11434).
4. Deployed dashboard: "What is 12 times 9?" → local. 5. "Explain step by step why the sky is blue." → cloud.
6. Quit Ollama; `curl -s -m 3 http://127.0.0.1:11434/api/tags || echo "Ollama is off"`; wait for router to notice.
7. "This is confidential: remind me my locker code is on a sticky note." → cloud fallback (policy changed Nov 13; held only with `privateWhenLocalDown: "held"`).
8. Restart Ollama; `ollama list`; wait. 9. "This is confidential: say "back online" in three words." → local.
10. Routing log command (`--freshness=30m --order=desc`). 11. `ollama ps`. 12. Telegram "Hi, what can you do?".
13. Briefing delivered by the real job (run-now). 14. Unsolicited meeting alert (seed meeting 35–40 min ahead). 15. Recap via the real job.
No cloud restart during recording, no secrets on screen, under 12 minutes. Warm Gemma one minute before recording.

## Grader access (OpenClaw, Local Gemma guide Part 2 and 5)
HTTPS certs + MagicDNS; grants with tcp:443 only for graders; reusable non-ephemeral tagged auth key read as `tailscale-authkey:latest`; Tailscale state on bucket; Serve 443 → gateway; `gateway.auth.allowTailscale true`; exact `allowedOrigins`; test from a fresh browser; reusable share link created near submission; Brightspace comment with share link, agent URL, test email/calendar logins (2-step off). Keep agent running and unchanged until regrades close; renew Google sign-in near deadline.

## Grader sign-in to the test accounts (course announcement, received Nov 13)
- Graders sign in to the test email/calendar account to plant a test meeting (proactive alert) or a test email. Dedicated class-only account with made-up data only.
- **Our path: Path 1** (Gmail API via OAuth/gog, no App Password): **2-Step Verification OFF**, password only. Account: `chittia3assistant@gmail.com` (calendar in the same account).
- OAuth consent screen in Testing → refresh token expires after 7 days → ~~publish to Production~~ **stay in Testing, test account added as test user (Nov 14; Production needs public homepage + privacy URLs)**; re-authorize gog ~Nov 20 and shortly before grading (course §3.5 step 2).
- Test before submitting: Incognito window in a *different* browser, sign in exactly as a grader would.
- Submit address + password only in Brightspace Comments (CloudRunSettings.txt template), never in the ZIP, README, or video. Points may be deducted if graders can't sign in.
- Consequence for M6: the proactive alert must watch the calendar graders will use (the account's primary calendar unless the README names another).
