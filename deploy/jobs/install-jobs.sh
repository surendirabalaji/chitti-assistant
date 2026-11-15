#!/usr/bin/env bash
# Declare the A3 scheduled jobs (M6). Run by startup.sh on every boot, after the gateway listens.
# Idempotent: `openclaw cron add --declaration-key K` updates job K in place (or does nothing if it
# is unchanged; verified in the installed 2026.10.9 dist, service `cron.add`), so the repo files win
# on every boot and nothing is duplicated. The enabled/disabled state is kept (no --disabled flag).
# Then runs a missed daily job once if it is still in its catch-up window (catchup.mjs).
# Needs: OPENCLAW_GATEWAY_TOKEN (exported by startup.sh), TELEGRAM_OWNER_ID.
# Logs one JSON line per job on stdout (component a3-ops); never prompts or message text.
# Assistant-written at the student's request (Nov 14).
set -uo pipefail

JOBS_DIR="${A3_JOBS_DIR:-/app/jobs}"
TZNAME="America/Los_Angeles"
NODE="$(command -v node)"
OWNER="${TELEGRAM_OWNER_ID:?TELEGRAM_OWNER_ID missing}"
FAILED=0
# The gateway answers slowly right after boot on 1 vCPU (cloud, Nov 14: "OpenClaw took too long to
# respond" with the 30 s default).
CLI_TIMEOUT_MS=90000

ops() { # ops <event> [extra JSON fields without braces]
  printf '{"component":"a3-ops","kind":"ops","event":"%s","ts":"%s"%s}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:+,$2}"
}

declare_job() { # declare_job <key> <cron add args...>
  local key="$1"; shift
  local out errfile
  errfile="$(mktemp)"
  if out="$(openclaw cron add --timeout "$CLI_TIMEOUT_MS" --declaration-key "$key" --name "$key" "$@" --json 2>"$errfile")"; then
    local state
    state="$(printf '%s' "$out" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.created?"created":j.updated?"updated":"unchanged")}catch{process.stdout.write("ok")}})')"
    ops "job-declared" "\"job\":\"$key\",\"result\":\"$state\""
  else
    FAILED=$((FAILED + 1))
    # CLI errors are about flags/validation; first line only, quotes stripped, bounded.
    ops "job-declare-failed" "\"job\":\"$key\",\"error\":\"$(head -1 "$errfile" | tr -d '"\\' | cut -c1-200)\""
  fi
  rm -f "$errfile"
}

TELEGRAM=(--announce --channel telegram --to "$OWNER")

# 1. Meeting alerts: command job (no model), every 5 min, prints alert text or NO_REPLY.
declare_job a3-alerts \
  --cron "*/5 * * * *" --tz "$TZNAME" --exact \
  --command-argv "[\"$NODE\",\"$JOBS_DIR/alerts.mjs\"]" \
  --timeout-seconds 60 "${TELEGRAM[@]}" \
  --description "Telegram alert for calendar events starting in 15-30 min (once per event)"

# 2. Hourly evidence, local half: command job, laptop health through the forwarder -> ops line.
declare_job a3-hourly-health \
  --cron "0 * * * *" --tz "$TZNAME" --exact \
  --command-argv "[\"$NODE\",\"$JOBS_DIR/hourly.mjs\"]" \
  --timeout-seconds 30 --no-deliver \
  --description "Hourly evidence: laptop Ollama reachable through the forwarder"

# 3. Hourly evidence, cloud half: tiny isolated agent turn; the router logs route_decision/route_result.
declare_job a3-hourly-cloud \
  --cron "5 * * * *" --tz "$TZNAME" --exact \
  --agent main --session isolated --light-context --tools "" \
  --message "[a3-cron] Hourly cloud check for the uptime log. Reply with exactly: OK" \
  --timeout-seconds 300 --no-deliver \
  --description "Hourly evidence: one routed cloud model turn (no tools, not delivered)"

# 4. Morning briefing 7:30 and 5. recap 18:00: isolated agent turns, read-only tools, to the owner.
declare_job a3-briefing \
  --cron "30 7 * * *" --tz "$TZNAME" --exact \
  --agent main --session isolated --tools "exec,web_fetch" \
  --message "$(cat "$JOBS_DIR/briefing.md")" \
  --timeout-seconds 600 "${TELEGRAM[@]}" \
  --description "Morning briefing: events, focus blocks, weather, unread mail"

declare_job a3-recap \
  --cron "0 18 * * *" --tz "$TZNAME" --exact \
  --agent main --session isolated --tools "exec" \
  --message "$(cat "$JOBS_DIR/recap.md")" \
  --timeout-seconds 600 "${TELEGRAM[@]}" \
  --description "End-of-day recap: activity counts, meetings, drafts awaiting approval, tomorrow"

# 6. State snapshots (M7): checks every minute, snapshots when due (5 min, or the ChatGPT login changed).
declare_job a3-state-snapshot \
  --cron "* * * * *" --tz "$TZNAME" --exact \
  --command-argv "[\"$NODE\",\"$JOBS_DIR/snapshot.mjs\"]" \
  --timeout-seconds 200 --no-deliver \
  --description "Bucket snapshot of OpenClaw state when due (5 min or login change)"

# 7. Change watch (Nov 15): USER.md / MEMORY.md changes and agent-created jobs -> owner's Telegram.
#    Offset from the alerts slot (minute 2, 7, 12, ...) to spread load on 1 vCPU.
declare_job a3-watch \
  --cron "2-59/5 * * * *" --tz "$TZNAME" --exact \
  --command-argv "[\"$NODE\",\"$JOBS_DIR/watch.mjs\"]" \
  --timeout-seconds 120 "${TELEGRAM[@]}" \
  --description "Report USER.md/MEMORY.md changes and scheduled jobs not created by the setup"

# Missed-job catch-up (briefing before noon, recap before 22:00).
if LIST="$(openclaw cron list --timeout "$CLI_TIMEOUT_MS" --all --json 2>/dev/null)"; then
  while read -r id key; do
    [ -n "${id:-}" ] || continue
    if openclaw cron run --timeout "$CLI_TIMEOUT_MS" "$id" >/dev/null 2>&1; then
      ops "job-missed-catchup" "\"job\":\"$key\""
    else
      ops "job-catchup-failed" "\"job\":\"$key\""
    fi
  done < <(printf '%s' "$LIST" | "$NODE" "$JOBS_DIR/catchup.mjs")
else
  ops "job-list-failed"
fi

ops "jobs-installed" "\"failed\":$FAILED"
[ "$FAILED" -eq 0 ]
