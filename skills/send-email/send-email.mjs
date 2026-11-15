#!/usr/bin/env node
// send-email: the ONLY path that can send mail from the agent (M4, A3 security gate).
// Written by the assistant at the student's request (Nov 14); see PROCESS_LOG.md.
//
// Two layers, both required by the assignment (§2.3):
//   1. Recipient allowlist, enforced HERE in code: exactly one recipient, must be listed in a
//      root-owned file the agent cannot edit. Anything else exits non-zero without contacting Gmail.
//   2. Human approval, enforced by OpenClaw exec approvals: this command is NOT on the exec
//      allowlist, so every call asks the owner (Telegram), and cron calls are denied (askFallback deny).
//
// Usage: send-email --to <address> --subject <text> --body-file <path> [--dry-run]
// Exit codes: 0 sent (or dry run ok), 2 bad usage, 3 recipient not allowed, 4 gog failed.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const ALLOWLIST_FILE = process.env.SEND_EMAIL_ALLOWLIST ?? "/app/send-email/allowlist.txt";
const REAL_GOG = process.env.SEND_EMAIL_GOG ?? "/usr/local/lib/gogcli/gog";
// /proc/1/fd/1 = container stdout (tini, same uid) -> Cloud Logging, outside the agent's transcript.
const LOG_TARGET = process.env.SEND_EMAIL_LOG ?? "/proc/1/fd/1";
const PW_FILE = `${process.env.HOME ?? "/home/agent"}/.config/a3/gog-keyring-password`;

const EXIT = { ok: 0, usage: 2, notAllowed: 3, gogFailed: 4 };
// Deliberately strict: one plain address, no display name, no list separators or whitespace.
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MAX_SUBJECT = 200;

export function parseAllowlist(text) {
  return new Set(
    text
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim().toLowerCase())
      .filter(Boolean),
  );
}

// Pure check: no I/O. `values` is parseArgs output ({ to: string[], subject: string[], ... }).
export function checkRequest(values, allowlist) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  const one = (name) => (Array.isArray(values[name]) && values[name].length === 1 ? values[name][0] : undefined);

  if (!values.to || values.to.length === 0) return fail(EXIT.usage, "missing-to");
  if (values.to.length > 1) return fail(EXIT.usage, "multiple-to");
  const to = one("to").trim().toLowerCase();
  if (!ADDRESS.test(to)) return fail(EXIT.usage, "invalid-to");

  const subject = one("subject");
  if (values.subject?.length > 1) return fail(EXIT.usage, "multiple-subject");
  if (subject === undefined || subject.trim() === "") return fail(EXIT.usage, "missing-subject");
  if (/[\r\n]/.test(subject)) return fail(EXIT.usage, "newline-in-subject"); // header injection
  if (subject.length > MAX_SUBJECT) return fail(EXIT.usage, "subject-too-long");

  const bodyFile = one("body-file");
  if (values["body-file"]?.length > 1) return fail(EXIT.usage, "multiple-body-file");
  if (bodyFile === undefined || bodyFile === "") return fail(EXIT.usage, "missing-body-file");
  if (bodyFile === "-") return fail(EXIT.usage, "stdin-body-not-supported"); // stdin is not passed to gog

  if (!allowlist.has(to)) return fail(EXIT.notAllowed, "recipient-not-allowed");
  return { ok: true, to, subject, bodyFile };
}

// Metadata only: never the subject or body. The recipient's domain only, not the full address.
function log(kind, fields) {
  const line = JSON.stringify({ component: "send-email", kind, ts: new Date().toISOString(), ...fields });
  process.stderr.write(line + "\n");
  try {
    appendFileSync(LOG_TARGET, line + "\n");
  } catch {
    // Not inside the container (tests, laptop): stderr is enough.
  }
}

const domainOf = (address) => String(address ?? "").split("@").pop()?.toLowerCase().slice(0, 100) || null;

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true, // unknown flags (e.g. --cc, --bcc) are an error, not ignored
      allowPositionals: false,
      options: {
        to: { type: "string", multiple: true },
        subject: { type: "string", multiple: true },
        "body-file": { type: "string", multiple: true },
        "dry-run": { type: "boolean" },
      },
    }));
  } catch (err) {
    log("email_refused", { reason: "bad-arguments", code: EXIT.usage });
    process.stderr.write(`send-email: ${err.message}\nusage: send-email --to <address> --subject <text> --body-file <path> [--dry-run]\n`);
    return EXIT.usage;
  }

  let allowlist;
  try {
    allowlist = parseAllowlist(readFileSync(ALLOWLIST_FILE, "utf8"));
  } catch {
    allowlist = new Set(); // missing allowlist = nobody allowed (fail closed)
  }

  const check = checkRequest(values, allowlist);
  if (!check.ok) {
    log("email_refused", { reason: check.reason, code: check.code, recipientDomain: domainOf(values.to?.[0]) });
    process.stderr.write(`send-email: refused (${check.reason})\n`);
    return check.code;
  }

  const env = { ...process.env };
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      env.GOG_KEYRING_PASSWORD = readFileSync(PW_FILE, "utf8");
    } catch {
      // gog will report the missing keyring password itself.
    }
  }

  const dryRun = values["dry-run"] === true;
  // execFileSync with an argument array: no shell, so quotes/semicolons in the subject stay plain text.
  const args = ["--no-input", "gmail", "send", "--to", check.to, "--subject", check.subject, "--body-file", check.bodyFile];
  if (dryRun) args.push("--dry-run");
  try {
    execFileSync(REAL_GOG, args, { env, stdio: ["ignore", "inherit", "inherit"] });
  } catch (err) {
    log("email_failed", { code: EXIT.gogFailed, gogExit: err.status ?? null, recipientDomain: domainOf(check.to), dryRun });
    return EXIT.gogFailed;
  }
  log(dryRun ? "email_dry_run" : "email_sent", { recipientDomain: domainOf(check.to), dryRun });
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
