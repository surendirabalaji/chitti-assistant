# Process log

## 1. AI tools used

I used AI throughout this project for explanations, API research, tests, implementation, debugging, and documentation. Section 3 says which work was mine and which was AI-generated. Section 4 says which results were observed and which checks were still pending.

| Tool or model | How I used it |
| --- | --- |
| OpenCode with Claude Opus 5.5 through OpenRouter (`openrouter/anthropic/claude-opus-5.5`, as recorded in my development notes) | Main development assistant: teaching, research in the installed code and documentation, tests, router and deployment implementation, debugging, evidence collection, and documentation drafts. |
| OpenCode explore/research subagents | Read-only investigation of the installed OpenClaw documentation, configuration, and approval behavior. The notes do not record which model the subagents ran on. |
| ChatGPT (model/version not recorded) | Clarified assignment and submission requirements, helped prepare the video script, reviewed the demonstration recording, and reorganized my development notes into this process log, including a first draft of the narrative and reflection. |

The deployed assistant also ran `openai/gpt-6-astra` and local `gemma4-a3:e2b` in runtime tests and demonstrations. That is runtime use, separate from the AI help I had while building the project. An early utility-model configuration also tried `openai/gpt-5.6-luna`; the notes record a 403 response and no successful call.

## 3. AI-generated code and documentation attribution

I wrote part of the initial router, but Claude generated or rewrote most of the later versions. The table gives the major contributions and changes per file. Where Claude rewrote my original code, the row says so.

| File or area | Who wrote what | How it was checked |
| --- | --- | --- |
| `router/src/decide.ts` | I wrote the initial one-rule version and chose the routing policies. Claude generated the later extensions: classification, follow-up and memory routing, private-task fallback, and long-context handling. | Test cases and live routing results. |
| `router/src/plugin.ts`, `router/src/index.ts` | I wrote the initial plugin structure. Claude helped with the later integration changes for logging, health checks, routing signals, held replies, and session-reset handling. | Test results and real OpenClaw sessions. |
| `router/src/log.ts` | Claude drafted the metadata-only logging. | I confirmed the output had routing decisions and results and no message text. |
| `router/src/socks5.ts`, `router/src/forwarder.ts` | Claude generated the SOCKS5 and Ollama-forwarding code and explained it. | I reviewed the test results and confirmed that requests from the cloud agent reached local Gemma. |
| `router/src/signals.ts`, `router/src/classifier.ts`, `router/src/health.ts` | Claude generated signal extraction, classification, follow-up detection, and availability checks. | Synthetic cases, benchmark results, and tests where I shut the local model down and brought it back. |
| `router/test/` | Claude generated and expanded the unit tests. | I read the results next to the live behavior to find wrong assumptions and to see whether a change worked. |
| `local/classifier-bench.mjs`, `local/followup-bench.mjs` | Claude generated the benchmark scripts and synthetic cases. | I used the results for design decisions, including keeping privacy checks rule-based. Some cases were reused after fixes, which limits what these results show. |
| `router/openclaw.plugin.json`, `router/tsconfig.json`, related package/configuration edits | I created the initial router package and chose Vitest. Claude helped with plugin schemas, configuration, and editor integration. | Validation output, tests, and runtime behavior. |
| `deploy/Dockerfile`, `deploy/startup.sh`, `deploy/openclaw.template.json5`, `.dockerignore`, deployment package/configuration files | Claude generated most of the deployment configuration from the architecture I chose. I did the deployment and console steps. The assistant also ran some build and deployment commands at my request. | Container checks and cloud logs for startup, authentication, integrations, and persistence. |
| `deploy/tailscale-policy.hujson` | Claude drafted the policy. I applied it in the Tailscale console. | Connection tests for the access restrictions and connectivity. |
| `deploy/gog-agent.sh`, `deploy/exec-approvals.json5` | Claude generated the email-tool wrapper and approval configuration. | Test results and live interactions, including approved operations and a refused recipient. |
| `skills/send-email/` | Claude generated the initial implementation, tests, and supporting configuration. I chose the recipient policy. | Live Telegram approval and refusal with the dedicated test account. |
| `skills/focus-finder/focus-finder.mjs` | I wrote `findGaps` and the unused `mergeIntervals` helper. Claude wrote the input conversion, formatting, date handling, CLI, and tests. | Test results, and a check that it worked in the calendar workflows. |
| `deploy/jobs/` and `deploy/jobs/install-jobs.sh` | Claude generated scheduling, activity aggregation, briefing, recap, snapshot/restore, and monitoring. | Test results, cloud logs, and the Telegram deliveries I received. I recorded the failures and limits found in testing. |
| `workspace/SOUL.md`, `workspace/USER.md`, `workspace/IDENTITY.md`, `workspace/AGENTS.md` | I supplied the persona text and directed the revisions. Claude helped adapt the files to synthetic assignment data and the deployment's controls. | I reviewed the result and tested memory behavior in live chats and restart tests. |
| `deploy/LOGIN.md`, `doc/a3/VIDEO_RUNBOOK.md` | Claude drafted these from the development notes and recorded evidence. | I reviewed the technical steps, checked claims against test results and observed behavior, and kept the known limits in. |

### External sources

- OpenClaw's bundled documentation, type definitions, and installed implementation, version 2026.10.9 (public documentation: <https://docs.openclaw.ai>). I used these for hook order, model and authentication selection, plugin configuration, approvals, memory, scheduling, and backup/restore. The installed AGENTS template was also copied and adapted, as the dated notes record.
- The course Assignment 3 PDFs for the required architecture, security constraints, deployment guidance, and demonstration procedure.
- gogcli v0.47.1 documentation and Google Cloud, Tailscale, and npm documentation during integration. The notes keep the exact local document paths and commands where they were recorded.

This table is a summary. The assignment still requires an exact source URL and rationale beside any code copied or substantially adapted from an external source, and the notes do not contain a complete snippet-by-snippet inventory of those URLs.

## 4. Verification narrative

I evaluated the generated code with unit tests, real provider calls, container checks, and interactions with the deployed agent. The chronological notes record who ran each check and which tests were still pending at each stage. The test counts below come from those notes; the last recorded rerun was on November 17.

### Router behavior and logging

The tests covered routing precedence, character boundaries, case handling, malformed events, private-task policies, local health, follow-up detection, session reset, and metadata-only logging. The latest recorded suite had 253 router tests passing. The earlier failures found real bugs: the 200-character boundary error, incorrect model-call accounting, wrong assumptions about hook order, and state that `/new` did not clear.

I also tested the router in real OpenClaw sessions and on the deployed dashboard, where I could see the completed model call as well as the selected route. In one case the route was correct and local Gemma still gave the wrong arithmetic answer. I recorded that as an output-quality failure. Tests of local failure and recovery covered the held policy I used first and the cloud-fallback policy I chose later.

The classifier was measured on synthetic examples before integration. It missed private messages, so privacy detection stayed rule-based. Follow-up tests checked that a short answer to a cloud task stayed with that task and that an unrelated new question could still route locally. Some cases were reused after fixes, so these numbers are development checks and do not estimate accuracy on unseen messages.

### Forwarder and deployment

The SOCKS5 and forwarder tests covered streaming, Host-header rewriting, dead upstreams, and failure handling. In real tests, rewriting the Host header changed an Ollama request from 403 to 200. Before cloud deployment the container went through shell syntax checks, ShellCheck, image builds, configuration validation, checks of runtime identity and file permissions, plugin loading, and smoke tests with dummy credentials.

### Skills, approvals, and proactive jobs

The latest recorded non-router suites had 80 passing tests across jobs, send-email, and focus-finder. They checked recipient restrictions, argument validation, malformed input, gap calculations, and timezone behavior. The generated approval rules were also run against OpenClaw's actual matcher, since a reimplementation inside a unit test could agree with itself and still be wrong. Cloud interactions then checked Telegram delivery, email approval, recipient refusal, calendar access, search, weather, briefing, alerts, and recap.

Adversarial Telegram tests showed filesystem access outside the workspace and autonomous behavior that needed restricting. The notes record the mitigations and the retests. They do not show protection against every attack or against an unrestricted shell bypass.

### Persistence and sustained operation

Local container tests checked snapshot verification, fallback from a corrupt latest snapshot, refusal to overwrite good backups when every restore failed, and locking against overlapping snapshots. Cloud tests checked whether authentication and saved memory survived restarts, and whether a fresh chat could retrieve a saved preference. When a recall failed, I investigated it even though the memory file existed.

The recorded 48-hour window started November 15 at 8:45 AM Pacific Time. The completion notes report 49/49 hourly checks with local availability, 53 successful cloud turns, and 476 snapshots with two recovered timeouts. They also record no local Gemma turns inside that window, so the availability checks are not evidence of local inference. The interactive tests and the video show local inference separately.

### Final demonstration and limitations

The November 17 recording shows the local route, the cloud route, private-task cloud fallback, and the local route after recovery, along with Telegram interaction and proactive deliveries. ChatGPT reviewed sampled frames, scene changes, and key full-resolution screens. That review supports the recording; it was not a frame-by-frame security audit.

Known limitations remain:

- Confidential content in a conversation can be included in a later cloud-bound turn.
- Cloud fallback itself lets private requests leave the laptop.
- The 1-vCPU instance can respond slowly when jobs and snapshots overlap.
- Duplicated health entries were observed and never explained.
- In the recording, the evening briefing offered a daytime focus block that had already passed.