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
