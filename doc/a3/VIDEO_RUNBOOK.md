# Video runbook (Tue Nov 17): exact commands and messages

File: `Assignment3-CSCI599-<USCusername>.mp4`, 10–12 min (hard max 12). Follows REQUIREMENTS.md "Video script" steps 1–15.
Rules: no cloud restart/redeploy, no secrets on screen (no tokens, no `~/.openclaw` auth files, no test-account password, no Telegram owner chat id), no SSH `cat` of anything under `/home/agent/.openclaw` or `~/.config/a3`.

## A. Before recording (off camera, ~15 min)

1. Mac: plugged in, lid open, Low Power off. Terminal 1:
   ```sh
   caffeinate -dims
   ```
   (Router health was flapping up/down 5:42–6:38 PM PST today, probably the Mac sleeping. Keep this running until the video is done.)
2. Terminal 2 (checks):
   ```sh
   which node            # must be the nvm path
   open -a Ollama
   curl -s http://127.0.0.1:11434/api/tags | head -c 200; echo
   tailscale status | head -3
   tailscale serve status   # expect: tcp 11434 -> tcp://127.0.0.1:11434 (tailnet only)
   ```
   Laptop gateway stays **off** (one Telegram poller per bot token).
3. Router sees the laptop as up (expect a `down -> up` or no recent lines and the last one `to up`):
   ```sh
   gcloud logging read 'jsonPayload.component="a3-router" AND jsonPayload.kind="health"' --project=chitti-assistant-a3 --freshness=30m --order=desc --limit=4 --format="table(timestamp.date('%H:%M:%S'),jsonPayload.from,jsonPayload.to)"
   ```
4. Dashboard warm-up in a **throwaway chat**: open `https://a3-cloud-agent.tail9bf1e8.ts.net/`, new chat, send `What is 7 times 5?` (first Gemma reply ~40 s cold). Then click **New chat** so the recorded chat starts at size 0.
   Why: the long-context rule (20k tokens) holds private messages in long chats (`privacy-long-context`). A fresh chat keeps step 9 under it.
5. **Rehearse steps 6–7 once** (quit Ollama, send the confidential message, reopen Ollama). The cloud fallback (`privacy-local-unavailable` → cloud) was verified on the laptop (Nov 13) but **never on the cloud agent**; the cloud dry run on Nov 14 was still on the old held policy. If the rehearsal shows `held` instead of `cloud`, say so in the video and in the README, don't change the config. After the rehearsal: New chat again, re-warm Gemma with one message in the throwaway chat.
6. Open SSH in Terminal 3 and define the helper (do this off camera; it prints nothing secret, but no need to show it):
   ```sh
   gcloud beta run instances ssh a3-agent --region us-west1
   # inside (root shell):
   oc() { runuser -u agent -- env HOME=/home/agent OPENCLAW_STATE_DIR=/home/agent/.openclaw OPENCLAW_CONFIG_PATH=/home/agent/.openclaw/openclaw.json PATH=/app/openclaw/node_modules/.bin:/usr/local/bin:/usr/bin:/bin sh -c 'OPENCLAW_GATEWAY_TOKEN="$(cat /home/agent/.openclaw/.gateway-token)" exec openclaw "$@"' sh "$@"; }
   oc automations list
   ```
   Write down the job ids of `a3-briefing` and `a3-recap` on paper (the list output can show the delivery route with the owner chat id: **clear the screen** afterwards with `clear`).
7. Telegram (desktop app or phone mirrored): open the bot chat, send `/new` (current Telegram session is ~15k tokens). Don't send anything else yet.
8. Seed the alert meeting **right before you press record**: in the test account's Google Calendar (off camera), create an event titled `A3 demo sync` starting **35–40 min from now** (alerts fire when an event is 15–30 min away, checked every 5 min). The alert should land 5–10 min into the recording.
9. Screen layout: browser (dashboard) + terminal + Telegram visible. Close other tabs/notifications.

## B. Recording (target ~11 min)

| # | Do / say | Command or message | Expect |
|---|---|---|---|
| 1 | Hardware | `system_profiler SPHardwareDataType \| grep -E "Model Name\|Chip\|Memory\|Hardware UUID"` | MacBook Air, M4, 16 GB, UUID |
| 2 | Running version from the Cloud Run startup log | `gcloud logging read 'jsonPayload.component="a3-ops" AND jsonPayload.event="boot"' --project=chitti-assistant-a3 --freshness=3d --limit=1 --format="table(timestamp,jsonPayload.openclaw,jsonPayload.node)"` | `2026-11-15T11:05:55Z  OpenClaw 2026.10.9 (8b18b55)  v24.22.1` (checked by the assistant tonight). Optional: `gcloud beta run instances describe a3-agent --region us-west1 --format="value(status.conditions)"` to show Running since Nov 15 |
| 3 | Local model + tunnel | `ollama list` then `tailscale serve status` | `gemma4-a3:e2b`; tcp 11434 → 127.0.0.1:11434 |
| 4 | Dashboard, recorded chat | `What is 12 times 9?` | local Gemma, "108" (warm ~6–20 s) |
| 5 | Same chat | `Explain step by step why the sky is blue.` | ChatGPT (17–90 s on 1 vCPU; keep talking about the router while waiting) |
| 6 | Quit Ollama (menu bar icon → Quit Ollama), then | `curl -s -m 3 http://127.0.0.1:11434/api/tags \|\| echo "Ollama is off"` | `Ollama is off`. Wait ~20 s (router polls every 10 s) |
| 7 | Same chat | `This is confidential: remind me my locker code is on a sticky note.` | ChatGPT answers (cloud fallback). Say: private goes local when the laptop is up; when it's down the policy is cloud fallback, switchable to held |
| 8 | Reopen | `open -a Ollama` then `ollama list`, then warm Gemma: `curl -s http://127.0.0.1:11434/api/generate -d '{"model":"gemma4-a3:e2b","prompt":"ok","stream":false}' > /dev/null && echo warm` | `warm` after ~20–40 s. Wait ~10 s more for the router `down -> up` |
| 9 | Same chat | `This is confidential: say "back online" in three words.` | local Gemma. **If the reply is a "held" message** (chat got too long): New chat, resend, and explain the long-context privacy rule |
| 10 | Routing log | see command below | rows for steps 4, 5, 7, 9 + health down/up |
| 11 | | `ollama ps` | Gemma loaded, 100% GPU |
| 12 | Telegram | `Hi, what can you do?` | reply (local or cloud depending on the label; read the route from the log if asked) |
| 13 | **Live (preferred, worked 8:01–8:03 PM with the dashboard closed):** `oc automations run "$BRIEF"` (no `--wait`), show the Telegram briefing (~30 s). Fallback if it comes back empty: | | |
| 13b | **Fallback (decision Nov 17 8:05 PM (no restart, agent overloaded):** show the real scheduled 7:30 AM briefing in Telegram + its log line `gcloud logging read 'jsonPayload.component="a3-router" AND jsonPayload.kind="route_result" AND timestamp>="2026-11-17T15:29:00Z" AND timestamp<="2026-11-17T15:32:00Z"' --project=chitti-assistant-a3 --format="table(timestamp,jsonPayload.rule,jsonPayload.target,jsonPayload.servedModel,jsonPayload.ok,jsonPayload.latencyMs)"`; say the evening run-now came back empty (1 vCPU overload) | | `tool-task cloud openai/gpt-6-astra True 29931` |
| 14 | Alert | point at the Telegram message `⏰ In NN min: A3 demo sync at h:mm PM` when it arrives (unsolicited, from the `a3-alerts` job) | arrives by itself; if it came earlier, scroll to it and show its time |
| 15 | **Live (preferred, verified 8:01 PM, 32.8 s):** `oc automations run "$RECAP"` (no `--wait`), show the Telegram recap. Fallback: | | |
| 15b | Recap: show yesterday's real 6 PM recap in Telegram + its line (same command, times `2026-11-17T02:00:00Z` to `2026-11-17T02:03:00Z`) | | `tool-task cloud … True 69385` |
| end | | `exit` (close SSH) | |

Step 10 command (all on one line):
```sh
gcloud logging read 'jsonPayload.component="a3-router" AND jsonPayload.kind=("route_decision" OR "route_result" OR "health")' --project=chitti-assistant-a3 --freshness=30m --order=desc --format="table(timestamp.date('%H:%M:%S'),jsonPayload.kind,jsonPayload.rule,jsonPayload.target,jsonPayload.model,jsonPayload.servedModel,jsonPayload.ok,jsonPayload.latencyMs,jsonPayload.to)"
```
Expected rules: `simple-task` local, `reasoning-heavy` cloud, `privacy-local-unavailable` cloud, `privacy-sensitive` local, plus `health` `down`/`up`. Health lines appear in pairs a few ms apart (known: two pollers, unexplained). If Cloud Logging lags, wait 30 s and rerun.

Things to say briefly (honest points): the "Model Fallback … selected model unavailable" banner after a new chat is cosmetic (router chose Gemma); every line is metadata only, no message text; the cloud agent has not been restarted since Nov 15 11:05 UTC.

## C. If something goes wrong

- Step 4 reply is slow / routed via `heuristic`: Gemma was cold (2 s classifier limit). Keep going.
- Step 5 or 15 takes > 2 min: 1 vCPU overload if a snapshot overlaps (known limit). Keep going or cut the wait and say so.
- Briefing fails once with "Spawn broker launch authority refused": rerun once (seen once on Nov 15).
- Alert never arrives: check the event is in the test account's **primary** calendar and starts 15–30 min out at a 5-min mark; show the `a3-ops` line instead: `gcloud logging read 'jsonPayload.event="alert-sent"' --project=chitti-assistant-a3 --freshness=1h --limit=3 --format="table(timestamp,jsonPayload.count,jsonPayload.minutes)"`
- **Never** restart the instance or the gateway to fix anything during recording.

After recording: stop `caffeinate` only if you no longer need the local model (graders may test local routing: leaving the Mac awake and Ollama on during grading is better).
