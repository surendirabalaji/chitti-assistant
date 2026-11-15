// Tests for send-email (assistant-written). Run: node --test skills/send-email/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRequest, parseAllowlist } from "./send-email.mjs";

const SCRIPT = fileURLToPath(new URL("./send-email.mjs", import.meta.url));
const OK = "chittia3assistant@gmail.com";
const allow = parseAllowlist(`# comment\n${OK}\n\n  Other@Example.org  # trailing comment\n`);
const req = (over = {}) => ({ to: [OK], subject: ["Hello"], "body-file": ["body.txt"], ...over });

test("parseAllowlist: lowercases, trims, drops comments and blanks", () => {
  assert.deepEqual([...allow].sort(), ["chittia3assistant@gmail.com", "other@example.org"]);
});

test("checkRequest: allowlisted recipient passes, case-insensitive", () => {
  assert.deepEqual(checkRequest(req({ to: [" ChittiA3Assistant@Gmail.com "] }), allow), {
    ok: true, to: OK, subject: "Hello", bodyFile: "body.txt",
  });
});

const refusals = [
  ["missing --to", req({ to: undefined }), 2, "missing-to"],
  ["two --to flags", req({ to: [OK, OK] }), 2, "multiple-to"],
  ["comma list in one --to", req({ to: [`${OK},evil@example.com`] }), 2, "invalid-to"],
  ["display-name form", req({ to: [`Chitti <${OK}>`] }), 2, "invalid-to"],
  ["missing subject", req({ subject: undefined }), 2, "missing-subject"],
  ["blank subject", req({ subject: ["   "] }), 2, "missing-subject"],
  ["newline in subject (header injection)", req({ subject: ["hi\nBcc: evil@example.com"] }), 2, "newline-in-subject"],
  ["CR in subject", req({ subject: ["hi\rX: y"] }), 2, "newline-in-subject"],
  ["subject too long", req({ subject: ["x".repeat(201)] }), 2, "subject-too-long"],
  ["two subjects", req({ subject: ["a", "b"] }), 2, "multiple-subject"],
  ["missing body file", req({ "body-file": undefined }), 2, "missing-body-file"],
  ["stdin body", req({ "body-file": ["-"] }), 2, "stdin-body-not-supported"],
  ["not on allowlist", req({ to: ["someone@example.com"] }), 3, "recipient-not-allowed"],
  ["lookalike domain", req({ to: ["chittia3assistant@gmail.co"] }), 3, "recipient-not-allowed"],
];
for (const [name, values, code, reason] of refusals) {
  test(`checkRequest refuses: ${name}`, () => {
    assert.deepEqual(checkRequest(values, allow), { ok: false, code, reason });
  });
}

test("checkRequest: empty allowlist refuses everyone", () => {
  assert.equal(checkRequest(req(), new Set()).code, 3);
});

// End-to-end: run the script with a fake gog that records its argv, one arg per line.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "send-email-test-"));
  const fakeGog = join(dir, "gog");
  writeFileSync(fakeGog, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/argv"\nexit \${FAKE_GOG_EXIT:-0}\n`);
  chmodSync(fakeGog, 0o755);
  writeFileSync(join(dir, "allowlist.txt"), `${OK}\n`);
  writeFileSync(join(dir, "body.txt"), "secret body text\n");
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEND_EMAIL_ALLOWLIST: join(dir, "allowlist.txt"),
      SEND_EMAIL_GOG: fakeGog,
      SEND_EMAIL_LOG: join(dir, "log.jsonl"),
      GOG_KEYRING_PASSWORD: "test-only",
      ...extraEnv,
    },
  });
  const logLines = () => (existsSync(join(dir, "log.jsonl"))
    ? readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, run, logLines };
}

test("e2e: allowed send calls real gog with an argv array (no shell), without --gmail-no-send", () => {
  const { dir, run, logLines } = setup();
  const subject = `Hi"; touch ${dir}/pwned; echo "$(id)`;
  const r = run(["--to", OK, "--subject", subject, "--body-file", join(dir, "body.txt")]);
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(join(dir, "argv"), "utf8").trimEnd().split("\n");
  assert.deepEqual(argv, ["--no-input", "gmail", "send", "--to", OK, "--subject", subject, "--body-file", join(dir, "body.txt")]);
  assert.equal(existsSync(join(dir, "pwned")), false);
  assert.deepEqual(logLines().map((l) => [l.kind, l.recipientDomain]), [["email_sent", "gmail.com"]]);
});

test("e2e: --dry-run is forwarded and logged as a dry run", () => {
  const { dir, run, logLines } = setup();
  const r = run(["--to", OK, "--subject", "x", "--body-file", "b.txt", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "argv"), "utf8").trimEnd().split("\n").at(-1), "--dry-run");
  assert.equal(logLines()[0].kind, "email_dry_run");
});

test("e2e: refused recipient exits 3, gog never runs, log has no subject/body/address", () => {
  const { dir, run, logLines } = setup();
  const r = run(["--to", "someone@example.com", "--subject", "TopSecretSubject", "--body-file", join(dir, "body.txt")]);
  assert.equal(r.status, 3);
  assert.equal(existsSync(join(dir, "argv")), false);
  const [line] = logLines();
  assert.equal(line.kind, "email_refused");
  assert.equal(line.reason, "recipient-not-allowed");
  assert.equal(line.recipientDomain, "example.com");
  const raw = readFileSync(join(dir, "log.jsonl"), "utf8");
  for (const leak of ["TopSecretSubject", "secret body", "someone@"]) assert.equal(raw.includes(leak), false, leak);
});

test("e2e: unknown flag (--cc) is a usage error, gog never runs", () => {
  const { dir, run, logLines } = setup();
  const r = run(["--to", OK, "--cc", "evil@example.com", "--subject", "x", "--body-file", "b.txt"]);
  assert.equal(r.status, 2);
  assert.equal(existsSync(join(dir, "argv")), false);
  assert.equal(logLines()[0].reason, "bad-arguments");
});

test("e2e: missing allowlist file refuses (fail closed)", () => {
  const { dir, run } = setup();
  const r = run(["--to", OK, "--subject", "x", "--body-file", "b.txt"], { SEND_EMAIL_ALLOWLIST: join(dir, "nope.txt") });
  assert.equal(r.status, 3);
  assert.equal(existsSync(join(dir, "argv")), false);
});

test("e2e: gog failure exits 4 and is logged", () => {
  const { run, logLines } = setup();
  const r = run(["--to", OK, "--subject", "x", "--body-file", "b.txt"], { FAKE_GOG_EXIT: "7" });
  assert.equal(r.status, 4);
  assert.deepEqual([logLines()[0].kind, logLines()[0].gogExit], ["email_failed", 7]);
});
