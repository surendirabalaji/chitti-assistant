# Security audit: Chitti (CSCI 599 A3)

Scope: the deployed agent (Cloud Run Instance `a3-agent`, image `agent:2026-11-15b`), the laptop side (Ollama + Tailscale), the Telegram bot, and the class-only Gmail/Calendar test account. All accounts and data are throwaway and synthetic.

Security measures claimed: **container isolation**, **permission scoping** (exec approval gate + allowlist, file-tool scoping, least-privilege service account, tailnet grants), **credential management** (Secret Manager, no secrets in git/image/logs). Prompt-injection defense is **not** claimed: there are partial measures (below), but no guarantee.

## Isolation report (from the startup log)

`deploy/startup.sh` writes an `isolation-report` line to Cloud Logging about 20 s after every boot:

```
isolation-report user=agent uid=10001 capEff=0000000000000000 listening=127.0.0.1:1055,127.0.0.1:11435,127.0.0.1:18789,[::1]:18789 (+ tailscaled peerapi on its own loopback)
```

- The gateway and every tool run as the unprivileged user `agent` (uid 10001), with **no Linux capabilities** (`CapEff` all zero).
- **Every listener is loopback only.** The instance has no public URL (`--no-default-url`) and no container port. The dashboard is reachable only through OpenClaw-managed Tailscale Serve on the tailnet, with Tailscale identity login (`gateway.auth.allowTailscale`).
- OpenClaw (`/app/openclaw`) and the router (`/app/router`) are installed as root and are **not writable** by `agent`, so the agent cannot change its own router or runtime code.
- The image build context is an allowlist (`.dockerignore`), so no repo files with secrets can enter the image.

Evidence: [evidence/2026-11-15-m6-m7-cloud-deploy.txt](evidence/2026-11-15-m6-m7-cloud-deploy.txt) (line 13), [evidence/2026-11-14-m4-cloud-deploy-tests.txt](evidence/2026-11-14-m4-cloud-deploy-tests.txt) (line 16), [evidence/2026-11-15-15a-cloud-deploy-checks.txt](evidence/2026-11-15-15a-cloud-deploy-checks.txt), [evidence/2026-11-13-m2-step4-image-build.txt](evidence/2026-11-13-m2-step4-image-build.txt).

## Approval gate and allowlist

The exec policy ([deploy/exec-approvals.json5](deploy/exec-approvals.json5)) is re-seeded on **every boot** with `openclaw approvals set`, which replaces the whole document. Any "allow always" grant from a previous boot is therefore removed. Config: `tools.exec.mode: "ask"`, `strictInlineEval: true`.

- `security: "allowlist"`, `ask: "on-miss"`, `askFallback: "deny"`, `autoAllowSkills: false`.
- **Allowlisted (run without asking):**
  - read-only `gog` Gmail commands (search, get, read thread, list labels);
  - `gog` drafts create/list;
  - read-only `gog` Calendar commands (list calendars/events, get event, free/busy);
  - `/usr/local/bin/focus-finder` with only `--date`, `--min`, `--json`;
  - `/usr/local/bin/a3-activity` with no arguments or `--date YYYY-MM-DD`.

  Every entry is binary path + argument regex. There are no path-only entries, because a path-only entry would allow any arguments.
- **Everything else asks the owner** in Telegram (inline buttons; the owner is set by `commands.ownerAllowFrom`).
- **Scheduled jobs have no approver.** An allowlist miss in a cron run is denied immediately (`askFallback: "deny"`).
- **Inline code** (`node -e`, `sh -c`, …) needs approval every time, and `strictInlineEval` removes the "allow always" button.

### Email sending (enforced in code)

1. The agent-facing `gog` is a wrapper ([deploy/gog-agent.sh](deploy/gog-agent.sh)). It always adds `--gmail-no-send` and `--no-input`, which also blocks `drafts send`. The real binary is outside `PATH`.
2. The **only** send path is [skills/send-email/send-email.mjs](skills/send-email/send-email.mjs). It refuses any recipient not in [skills/send-email/allowlist.txt](skills/send-email/allowlist.txt), which contains only the test account (23 unit tests).
3. `send-email` is deliberately **not** on the exec allowlist. Every send is an allowlist miss, so a human must press Approve in Telegram, and in scheduled jobs it is denied automatically.

Cloud test results:
- approve → sent;
- recipient not on the allowlist → refused ([evidence/2026-11-14-m4-cloud-deploy-tests.txt](evidence/2026-11-14-m4-cloud-deploy-tests.txt));
- agent asked to schedule a job that sends mail → it refused and created no job ([evidence/2026-11-17-cron-draft-only-test.txt](evidence/2026-11-17-cron-draft-only-test.txt)). The code-level cron denial was not exercised by a real cron run in that test.

## Risks, mitigations and remaining risks

### 1. Unapproved or misdirected email
- **Risk:** the agent (or text injected into it) sends mail the owner did not intend, or to an outside address.
- **Mitigation:** no-send wrapper, send-email recipient allowlist, human approval for every send, cron sends denied (above).
- **Remaining risk:** a human can still approve a bad email. If the owner ever picked "allow always" for a send, that exact command could be replayed until the next boot. It's acceptable because only the owner can approve and only the test account can receive.

### 2. Arbitrary command execution
- **Risk:** the agent runs shell commands that read secrets, change files or reach the network.
- **Mitigation:** allowlist + ask-on-miss + deny in cron (above); policy re-seeded on every boot; `strictInlineEval`.
  - Incident (Nov 14): a diagnostic the assistant suggested made the agent run `gog … | node -e '…'`. The gate asked the owner and it ran once after approval. Afterwards `strictInlineEval` was set, and the workspace `AGENTS.md` got a "Command safety" rule ([evidence/2026-11-14-m5-inline-eval-hardening.txt](evidence/2026-11-14-m5-inline-eval-hardening.txt)).
  - focus-finder is allowlisted only as a root-owned copy. The agent-writable workspace copy is not, because allowlisting it would let the agent edit a file and run it unapproved.
- **Remaining risk:** a human can approve a harmful command. The `AGENTS.md` rule is advice only: the agent can edit its own workspace, and the rule did not stop an explicit owner request in testing. The owner's practice is to deny prompts containing `-e`, `-c`, `eval`, `| sh` or `curl … |`. There is no hard block without disabling exec entirely, which would break the email/calendar skills.

### 3. Credential exposure
- **Risk:** tokens (Tailscale, Telegram, Google OAuth, ChatGPT login) leak through git, the image, logs, the agent's tools or the video.
- **Mitigation:**
  - All secrets are in Google Secret Manager (`tailscale-authkey`, `telegram-bot-token`, `gog-keyring-password`, `gog-oauth-client`), injected only at runtime. At boot, `startup.sh` writes the Tailscale key to a 0600 temp file, uses it, deletes it, and unsets the variable before the gateway starts.
  - A random gateway token is generated on every boot.
  - The runtime service account `a3-agent-v2` has **no user-managed keys** and only the roles it needs: bucket object admin on the state bucket, secret accessor on the secrets, log writer.
  - The gog token lives in an encrypted keyring on the bucket.
  - `.env.example` has placeholders only, and a secret scan of the repo was clean (138 text files; images checked by eye).
  - Logs never contain message text, prompts, tool arguments, email addresses or tokens.
  - Incident: after a leaked container on Nov 14, the instance was recreated with a new service account, the Telegram bot token was rotated, and the Tailscale machine was rejoined ([evidence/2026-11-15-m6-m7-cloud-deploy.txt](evidence/2026-11-15-m6-m7-cloud-deploy.txt)).
- **Remaining risk:**
  - The state snapshots in the bucket contain the ChatGPT login and chat history. The bucket is private (uniform access, public access prevention enforced), but anyone with project access can read them.
  - Sign-in URLs and codes briefly appear in the instance SSH terminal.
  - The Tailscale auth key is reusable for 90 days.

  To do after grading: revoke the Tailscale key, delete the old service account `a3-agent` and Telegram token version 1, and delete the bucket.

### 4. The agent reading its own config and secret files
- **Risk:** the file-read tool reads `~/.openclaw` (config, login database) or `~/.config/a3` (gog keyring password).
- **Found Nov 15:** canary files in both folders were readable through the read tool ([evidence/2026-11-15-telegram-failure-tests.txt](evidence/2026-11-15-telegram-failure-tests.txt)).
- **Mitigation:** `tools.fs.workspaceOnly: true` (in the image from `2026-11-15a`). The retest blocked the reads, and weather and send-email still worked ([evidence/2026-11-15-15a-cloud-deploy-checks.txt](evidence/2026-11-15-15a-cloud-deploy-checks.txt)).
- **Remaining risk:** allowlisted binaries still run as `agent` and could read what `agent` can read. They are fixed, read-only tools with constrained arguments.

### 5. Private data reaching the cloud model
- **Risk:** messages the owner marks private end up at ChatGPT.
- **Mitigation:**
  - Privacy-pattern messages go to local Gemma when the laptop is up. Privacy is decided by fixed patterns first; Gemma can add privacy but never remove it.
  - Utility calls (titles etc.) use local Gemma, so they fail rather than go to the cloud.
  - Skill Workshop autonomous mode, which forked whole chats (including private turns) to ChatGPT with no routing decision, was turned off (`skills.workshop.autonomous.mode: "off"`, found Nov 15).
  - A private message in a chat too long for Gemma is held (`privacy-long-context`).
- **Remaining risk:**
  - **By policy**, private messages go to ChatGPT when the laptop is off (`privacy-local-unavailable`; switch `privateWhenLocalDown: "held"` to stop that).
  - **Chat history:** OpenClaw sends the whole session with each turn, so a later cloud turn in the same chat carries earlier private messages. Sticky privacy was considered and not built for time; users should keep private topics in their own chat (`/new`).
  - **Detection limits:** the pattern list has no stemming or negation ("not confidential" counts as private). The Gemma label scored 89% on 27 synthetic messages and missed 4 of 16 private ones ([evidence/2026-11-13-classifier-bench.json](evidence/2026-11-13-classifier-bench.json)).
  - **Gemma-only privacy is not detected in long chats**, because Gemma isn't asked there.
  - **Timeout:** if OpenClaw's 5 s hook timeout fired, a message only Gemma flagged would use the default (cloud) model.

### 6. Prompt injection through email, calendar or web text
- **Risk:** a planted email or event tells the agent to send mail, run commands or change memory.
- **Mitigation:**
  - Gmail output is wrapped as untrusted (`--wrap-untrusted` in the gog wrapper).
  - SOUL.md, AGENTS.md and the job prompts say outside text is data, not instructions.
  - Sends and non-allowlisted commands still need human approval.
  - Scheduled jobs can't get approval at all.
- **Remaining risk:** a model can still be talked into actions inside its allowed set (reading mail, creating drafts, writing memory). Prompt-injection defense is not claimed.

### 7. Memory poisoning and persona drift
- **Risk:** injected or mistaken text gets written into USER.md / MEMORY.md and changes later behaviour.
- **Mitigation:** the `a3-watch` job messages the owner a diff whenever USER.md or MEMORY.md changes, and keeps the previous 20 versions on the bucket (restore steps in [deploy/LOGIN.md](deploy/LOGIN.md)). memory-core "dreaming" (automatic rewriting of MEMORY.md) is disabled.
- **Remaining risk:** detection only, not prevention; the owner has to notice and restore. Notes saved by `/new` (`memory/*.md`) are not watched.

### 8. Agent-created scheduled jobs
- **Risk:** the agent creates its own cron job (found Nov 15: it created a one-shot reminder itself), which then runs unattended.
- **Mitigation:** `a3-watch` reports any job not created by `install-jobs.sh`. Unattended jobs cannot get approvals, so they can't send mail or run non-allowlisted commands.
- **Remaining risk:** detected only, not blocked. A one-shot job created and removed between two 5-minute checks is missed.

### 9. Network exposure
- **Risk:** the dashboard or the laptop's Ollama is reachable by others.
- **Mitigation:**
  - No public URL and no container port; all listeners are loopback.
  - The tailnet policy is deny-by-default ([deploy/tailscale-policy.hujson](deploy/tailscale-policy.hujson)):
    - owner and graders reach only `tag:a3-agent` on `tcp:443`;
    - the agent reaches only the laptop's `tcp:11434`;
    - a policy test asserts the agent cannot reach laptop ports 22 or 18789.
  - Ollama listens on `127.0.0.1` only (never `OLLAMA_HOST=0.0.0.0`) and is exposed with `tailscale serve --tcp 11434`.
  - Only the owner's numeric Telegram id is allowed; groups are disabled.
- **Remaining risk:** anyone given the share link can use the dashboard with full owner rights while sharing is active. Revoke the share after grading.

### 10. Supply chain
- **Risk:** a compromised or broken dependency gets into the image.
- **Mitigation:**
  - Pinned versions: OpenClaw `2026.10.9`, Node `24.22.1`, base image by digest, Tailscale 1.104.7 and gog v0.47.1 by sha256.
  - `npm ci` from a lockfile resolved with `--before=2026-10-30`.
  - Install scripts are allowed only for pinned packages.
- **Remaining risk:** `npm audit` reports 29 transitive advisories (25 moderate, 4 high). They were not auto-fixed, because that would change pinned versions.

### Open items (not investigated further)
- A nested inference tool may ignore the router's auth-profile pin. Noted in testing (Nov 15) and not traced.
- Memory poisoning (risk 7) and agent-created jobs (risk 8) are detected, not prevented.
