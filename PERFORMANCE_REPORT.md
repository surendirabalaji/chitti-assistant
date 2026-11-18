# Performance report: Chitti (CSCI 599 A3)

All numbers below were measured (Cloud Logging router lines, gateway logs, dashboard timers, benchmarks). Where something was not measured, it says so.

**Setup.** The cloud agent runs on a Cloud Run Instance with **1 vCPU / 4 GiB**. ChatGPT `openai/gpt-6-astra` runs at OpenClaw's default thinking level (medium). Local Gemma 4 E2B (`gemma4-a3:e2b`, 32K context, `think: false`) runs on a MacBook Air M4 16 GB (Ollama 0.40.16, 100% GPU, 7.4–7.6 GB loaded) and is reached over Tailscale.

**What "latency" means here.** Unless noted, latency is the router's `latencyMs`: from the routing decision to the end of the agent run. It includes OpenClaw's context assembly, tool calls and queueing on the single vCPU, not just the model call.

## Results by task type

| Task type | Route (rule) | Latency | Quality | Evidence |
|---|---|---|---|---|
| Simple arithmetic ("What is 12 times 9?", "7 times 5") | local Gemma (`simple-task`) | warm turn ~6 s (Gemma call 5.0 s); cold load 41.4 s; dry run 16.5 s; first turn after a boot ~90 s | 108 ✔ (cloud agent), "thirty-five" ✔; one CLI test on Nov 12 answered **118 ✘** | [m2-forwarder-cloud](evidence/2026-11-13-m2-forwarder-cloud.txt), [48h-run-start](evidence/2026-11-15-48h-run-start.txt), [m3-cloud-video-dryrun](evidence/2026-11-14-m3-cloud-video-dryrun.txt), [a5-f5-cli-turns](evidence/2026-11-12-a5-f5-cli-turns.txt) |
| Reasoning ("Explain step by step why the sky is blue.") | cloud ChatGPT (`reasoning-heavy`) | 10.4 s (Nov 14), 17.0 s (Nov 15), 47.9 s (Nov 17 evening, loaded) | full step-by-step explanation ✔ | [m3-cloud-video-dryrun](evidence/2026-11-14-m3-cloud-video-dryrun.txt), [48h-run-start](evidence/2026-11-15-48h-run-start.txt) |
| Private message, laptop up | local Gemma (`privacy-sensitive`) | 21 s (dashboard), 23.3 s (Nov 17) | answered locally; Gemma declined to "know" a locker code (reasonable) | [m3-cloud-video-dryrun](evidence/2026-11-14-m3-cloud-video-dryrun.txt), [evening-overload](evidence/2026-11-17-evening-overload.txt) |
| Private message, laptop off | cloud ChatGPT (`privacy-local-unavailable`) | 9.5 s (Nov 17) | answered ✔ (policy: cloud fallback) | [evening-overload](evidence/2026-11-17-evening-overload.txt) |
| Scheduled cloud check, n = 48 ("Reply with exactly: OK", no tools) | cloud (`tool-task`, cron) | **median 32.5 s**, mean 27.6 s, p90 44.0 s, min 6.3 s, max 46.1 s | 48/48 ok | [48h-latency-summary](evidence/2026-11-17-48h-latency-summary.txt) |
| Morning briefing (gog calendar + Gmail, focus-finder, weather) | cloud (`tool-task`) | 15.6 s, 29.9 s (scheduled); 38.3 s, 29.5 s (run-now Nov 17) | all sections filled after the calendar time-zone fix; unread items show "body unavailable" (cosmetic). Under overload one run-now returned every section "(unavailable)" | [48h-latency-summary](evidence/2026-11-17-48h-latency-summary.txt), [14e-cloud-memory-tests](evidence/2026-11-15-14e-cloud-memory-tests.txt), [evening-overload](evidence/2026-11-17-evening-overload.txt) |
| Evening recap (gog, a3-activity counts) | cloud (`tool-task`) | 69.3 s, 69.4 s (scheduled); 32.8 s, 56.2 s (run-now Nov 17) | filled: request counts by route, alerts, laptop checks, meetings, drafts | same |
| Memory recall ("What car do I have?" in a new chat) | cloud (`memory-task`) | 79.9 s (warm-up recall); first try after a boot timed out at 68 s | correct answer ✔ | [14e-cloud-memory-tests](evidence/2026-11-15-14e-cloud-memory-tests.txt), [48h-run-start](evidence/2026-11-15-48h-run-start.txt) |
| Web search / weather | cloud (`tool-task`) | weather ~10 s (laptop gateway); a cloud search turn took 80 s while a snapshot overlapped | F1 question answered with source link ✔; LA weather ✔ | [m4-search-laptop](evidence/2026-11-14-m4-search-laptop.txt), [15a-cloud-deploy-checks](evidence/2026-11-15-15a-cloud-deploy-checks.txt) |
| Meeting alert | no model (command job) | fires at the first 5-min check 15–30 min before the event | sent once per event, survived a restart without a duplicate | [m6-m7-cloud-deploy](evidence/2026-11-15-m6-m7-cloud-deploy.txt) |

### Observations
- **Local Gemma is fast once loaded** (about 5 s per answer), but the agent around it is not. On 1 vCPU, OpenClaw's context assembly adds seconds to minutes. The first turn after a boot spent about 38 s in preparation and 27 s in reply setup before Gemma started.
- **Ollama unloads Gemma after about 5 min idle.** The next local turn pays a 20–40 s cold load, and the router's 2 s Gemma label times out, so the scoring fallback decides. A warm-up message before demos avoids this.
- **The single vCPU is the main bottleneck.** When an interactive turn overlaps a snapshot (`backup create --verify`), turns take 50–150 s and snapshots time out.
  - On Nov 17 from about 6:40 PM, snapshot time rose from ~10 s to 100–160 s and then hit the 170 s limit. Agent setup rose from ~1 s to 39–60 s, and a briefing came back empty.
  - Closing the dashboard tab and stopping status polling brought it back without a restart: the next recap took 32.8 s ([evening-overload](evidence/2026-11-17-evening-overload.txt)).
- **ChatGPT quality was consistently good** on tool and reasoning tasks. Gemma E2B is fine for short answers but made an arithmetic error once, and it does not use memory tools. That is why memory statements and questions are routed to the cloud.

## Routing quality

| Benchmark | Result | Evidence |
|---|---|---|
| Gemma task label on 27 synthetic messages | 89% correct, ~150 ms warm, deterministic; missed 4 of 16 private messages → privacy stays rule-based | [classifier-bench](evidence/2026-11-13-classifier-bench.json) |
| Follow-up detection (60 cases) | 51–54/60 with real Gemma; 57/60 after rule fixes | [followup-bench](evidence/2026-11-14-followup-bench.json), [router-followup-laptop](evidence/2026-11-14-router-followup-laptop.txt) |
| Memory label (33 cases) | 33/33, earlier cases unchanged | [classifier-bench-memory](evidence/2026-11-15-classifier-bench-memory.json) |
| Real gateway, 8 new messages (laptop) | 7/8; the miss ("before my 3pm") was fixed and rerun | [router-v2-laptop](evidence/2026-11-13-router-v2-laptop.txt) |
| Unit tests | 253 router tests pass (Vitest) | `cd router && npm test` |

**Routing decisions in the 48-hour window:** 53 turns, all cloud (`tool-task` 52, `memory-task` 1), 0 local, 0 held, 0 failures. Only scheduled jobs ran, and they always route to the cloud. The laptop was reachable at all 49 hourly checks ([48h-run-complete](evidence/2026-11-17-48h-run-complete.txt)).

**Day-level mix (from the Nov 17 evening recap):** 34 requests answered (local Gemma 5, cloud ChatGPT 29), 0 held, 0 unavailable, 1 failed; 26 of them were scheduled job turns.

## Cost

- **ChatGPT:** ChatGPT Edu subscription through OpenClaw OAuth. No per-token charges and no rate-limit errors were seen. Token usage was not measured.
- **Gemma:** runs on the owner's laptop, so the only cost is electricity. Not measured.
- **Google Cloud:** a 1 vCPU / 4 GiB Cloud Run Instance running continuously since Nov 13–15, plus Artifact Registry, Cloud Storage, Secret Manager and Cloud Logging. A $25/month budget alert is set (alerts at 50/90/100%; it alerts only, it doesn't cap spending). **Actual usage cost Nov 1–17 (Billing → Reports export, Nov 17 evening): $3.56**:

  | Service | Usage cost |
  |---|---|
  | Cloud Run | $3.18 |
  | Artifact Registry | $0.30 |
  | Cloud Storage | $0.08 |

  All of it was covered by education credits, so the amount billed is $0.00 ([evidence/2026-11-17-billing-report-nov.csv](evidence/2026-11-17-billing-report-nov.csv)). Billing data lags by several hours, so the last day is likely undercounted. Secret Manager and Cloud Logging do not appear in the export, presumably because they stayed in the free tier. Cloud Run cost about $0.70 a day ($3.18 over roughly 4.5 days since the first deploy on Nov 13), at 1 vCPU / 4 GiB.
- **Trade-off:** 2 vCPU would likely fix the overload and shorten every turn, but doubles the instance's CPU cost. It was not chosen.

## Local model choice

| Model | Memory | Speed | Decision |
|---|---|---|---|
| Gemma 4 E4B | 9.4 GB, 14% memory free | cold `ollama run` 49.0 s; 600-word answer 26.2 s warm | rejected (memory pressure on 16 GB) |
| Gemma 4 E2B | 7.4 GB, 25% memory free | 600-word answer 24.0 s incl. cold load; agent turn with a tool 21 s | **chosen** |
