#!/usr/bin/env bash
# Container entrypoint for the A3 agent (run by tini as the non-root user "agent").
# Order: secrets -> config -> (restore: M7) -> tailscaled -> tailscale up -> forwarder
#        -> ChatGPT login check -> gateway (OpenClaw runs Tailscale Serve :443 itself)
#        -> isolation report -> scheduled jobs (deploy/jobs/install-jobs.sh) -> supervise.
# Logs are one JSON object per line on stdout (component a3-ops). Never log secret values.
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:?}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:?}"
TS_STATE_DIR="${STATE_MOUNT:?}/tailscale"
TS_SOCKET=/var/run/tailscale/tailscaled.sock

ops() { # ops <event> [extra JSON fields without braces]
  printf '{"component":"a3-ops","kind":"ops","event":"%s","ts":"%s"%s}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:+,$2}"
}
die() { ops "fatal" "\"reason\":\"$1\""; exit 1; }

ops "boot" "\"openclaw\":\"$(openclaw --version 2>/dev/null | head -1 | tr -d '"')\",\"node\":\"$(node --version)\""
# Boot time for the hourly evidence job's uptime field (inherited by the gateway and its command jobs).
A3_BOOT_TS="$(date +%s)"
export A3_BOOT_TS
# Scheduled command jobs (deploy/jobs/*.mjs) append metadata-only lines here; tail them to stdout so
# they reach Cloud Logging. Not supervised: if tail dies, only those lines stop.
OPS_LOG=/tmp/a3-ops.log
touch "$OPS_LOG"
tail -n 0 -F "$OPS_LOG" 2>/dev/null &
TAIL_PID=$!

# --- 0. Restore OpenClaw state from the newest good bucket snapshot (M7), before anything else writes
# to $OPENCLAW_STATE_DIR (the per-boot gateway token below, the config step, the gateway). Logs
# state-restored / state-restore-none / state-restore-failed. Never fails the boot.
[ -d "$STATE_MOUNT" ] || die "bucket mount missing"
node /app/jobs/restore.mjs || ops "state-restore-error"
GATEWAY_PID=""

# --- 1. Secrets (injected by Cloud Run from Secret Manager as env vars) -----------------
[ -n "${TS_AUTHKEY:-}" ] || die "TS_AUTHKEY missing"
umask 077
TS_KEY_FILE="$(mktemp)"
printf '%s' "$TS_AUTHKEY" > "$TS_KEY_FILE"
unset TS_AUTHKEY        # children (gateway, agent tools) must not inherit it

# Per-boot gateway token: only in-container CLI calls need it; people use Tailscale identity.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  export OPENCLAW_GATEWAY_TOKEN
fi
# Private copy (0600, agent only, local disk) so an SSH session running as "agent" can use
# the CLI against the running gateway. Never copied to the bucket.
mkdir -p "$STATE_DIR"
printf '%s' "$OPENCLAW_GATEWAY_TOKEN" > "$STATE_DIR/.gateway-token"

# gog (Gmail/Calendar). Secrets come from Cloud Run --update-secrets (Secret Manager):
#   GOG_KEYRING_PASSWORD  unlocks the encrypted token file keyring on the bucket ($GOG_HOME)
#   GOG_OAUTH_CLIENT_JSON the Desktop OAuth client (stored into $GOG_HOME, then dropped from env)
# The password is copied to a 0600 file on local disk (never the bucket) for the agent-facing gog
# wrapper and the SSH sign-in (the SSH shell has no gateway env), then unset like TS_AUTHKEY.
GOG_PW_FILE="$HOME/.config/a3/gog-keyring-password"
if [ -n "${GOG_KEYRING_PASSWORD:-}" ]; then
  mkdir -p "$(dirname "$GOG_PW_FILE")"
  printf '%s' "$GOG_KEYRING_PASSWORD" > "$GOG_PW_FILE"
  chmod 600 "$GOG_PW_FILE"
  unset GOG_KEYRING_PASSWORD
fi
# Telegram bot token (Cloud Run secret TELEGRAM_BOT_TOKEN) -> 0600 file named by channels.telegram.tokenFile.
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  mkdir -p "$HOME/.config/a3"
  printf '%s' "$TELEGRAM_BOT_TOKEN" > "$HOME/.config/a3/telegram-bot-token"
  chmod 600 "$HOME/.config/a3/telegram-bot-token"
  unset TELEGRAM_BOT_TOKEN
fi
[ -n "${TELEGRAM_OWNER_ID:-}" ] || die "TELEGRAM_OWNER_ID missing (deploy env var; the config's allowFrom needs it)"
GOG_CLIENT_FILE=""
if [ -n "${GOG_OAUTH_CLIENT_JSON:-}" ]; then
  GOG_CLIENT_FILE="$(mktemp)"
  printf '%s' "$GOG_OAUTH_CLIENT_JSON" > "$GOG_CLIENT_FILE"
  unset GOG_OAUTH_CLIENT_JSON
fi

# --- 2. Config: repo template wins on every boot; keep the `auth` block the login wrote ---
mkdir -p "$STATE_DIR"
AUTH_JSON=""
if [ -f "$CONFIG_PATH" ]; then
  # Exit 1 + an error object on stdout when `auth` is unset (e.g. a restored config from before the
  # ChatGPT sign-in): treat that as "nothing to keep", or `config set` below would fail the boot.
  AUTH_JSON="$(openclaw config get auth --json 2>/dev/null)" || AUTH_JSON=""
fi
cp /app/openclaw.template.json5 "$CONFIG_PATH"
if [ -n "$AUTH_JSON" ] && [ "$AUTH_JSON" != "null" ]; then
  openclaw config set auth "$AUTH_JSON" --strict-json >/dev/null
fi
openclaw config validate --json >/dev/null || die "config invalid"
ops "config-applied"

# Exec approvals: replace the whole document on every boot (gog reads allowlisted; send-email and
# everything else ask the owner; cron gets "deny"). Drops any "allow-always" grants from last boot.
openclaw approvals set --file /app/exec-approvals.json5 >/dev/null || die "exec approvals not applied"
ops "exec-approvals-applied" "\"allowlistEntries\":$(openclaw approvals get --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const f=j.file??j.document??j;process.stdout.write(String(f.agents?.main?.allowlist?.length??"null"))}catch{process.stdout.write("null")}})' || echo null)"

# --- 3. Persona/workspace files (M7). Repo wins on every boot for AGENTS.md (command-safety rules),
# SOUL.md and IDENTITY.md, so a rule the agent edited away comes back on restart. USER.md is seeded
# once (marker "a3-persona"), because the agent records learned preferences there. BOOTSTRAP.md (the
# first-run naming ritual) is removed: the persona is given.
WS="$STATE_DIR/workspace"
mkdir -p "$WS"
for f in AGENTS.md SOUL.md IDENTITY.md; do cp /app/workspace-seed/$f "$WS/$f"; done
if ! grep -q 'a3-persona' "$WS/USER.md" 2>/dev/null; then
  cp /app/workspace-seed/USER.md "$WS/USER.md"
  ops "persona-applied" "\"userSeeded\":true"
else
  ops "persona-applied" "\"userSeeded\":false"
fi
rm -f "$WS/BOOTSTRAP.md"

# --- 4. Tailscale: userspace networking, SOCKS5 for outbound, state on the bucket mount --
mkdir -p "$TS_STATE_DIR" || die "bucket mount not writable"
tailscaled --tun=userspace-networking \
  --socks5-server=127.0.0.1:1055 \
  --statedir="$TS_STATE_DIR" \
  --socket="$TS_SOCKET" &
TAILSCALED_PID=$!

for _ in $(seq 1 30); do
  tailscale --socket="$TS_SOCKET" status >/dev/null 2>&1 && break
  # "Logged out" / "NeedsLogin" still means the daemon answers; check the socket exists.
  [ -S "$TS_SOCKET" ] && break
  sleep 1
done
[ -S "$TS_SOCKET" ] || die "tailscaled did not start"

# The auth key is only used if the saved state needs a login (first boot or lost state).
tailscale --socket="$TS_SOCKET" up \
  --auth-key="file:$TS_KEY_FILE" \
  --hostname="$TS_HOSTNAME" \
  --advertise-tags=tag:a3-agent \
  --operator=agent \
  --timeout=60s >/dev/null || die "tailscale up failed"
rm -f "$TS_KEY_FILE"
ops "tailscale-up" "\"hostname\":\"$TS_HOSTNAME\",\"ip\":\"$(tailscale --socket="$TS_SOCKET" ip -4 2>/dev/null | head -1)\""

# --- 4b. gog: OAuth client onto the bucket (idempotent); report whether an account is signed in --
if [ -n "$GOG_CLIENT_FILE" ]; then
  mkdir -p "$GOG_HOME"
  # The client secret is stored in the encrypted keyring, so this needs the keyring password too.
  if [ -f "$GOG_PW_FILE" ] && GOG_KEYRING_PASSWORD="$(cat "$GOG_PW_FILE")" \
       /usr/local/lib/gogcli/gog --no-input auth credentials set "$GOG_CLIENT_FILE" >/dev/null 2>&1; then
    ops "gog-client-stored"
  else
    ops "gog-client-failed"
  fi
  rm -f "$GOG_CLIENT_FILE"
fi
if [ -f "$GOG_PW_FILE" ]; then
  GOG_ACCOUNTS="$(GOG_KEYRING_PASSWORD="$(cat "$GOG_PW_FILE")" /usr/local/lib/gogcli/gog --no-input auth list --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.accounts||j.results||[]);process.stdout.write(String(a.length))}catch{process.stdout.write("unknown")}})' || echo unknown)"
  ops "gog-status" "\"accounts\":\"$GOG_ACCOUNTS\""   # a count only, never addresses or tokens
else
  ops "gog-not-configured" "\"reason\":\"no GOG_KEYRING_PASSWORD secret\""
fi

# --- 5. Ollama forwarder (student-written, M2 step 8). Absent -> local route unavailable --
FORWARDER_PID=""
if [ -f /app/router/src/forwarder.ts ]; then
  node /app/router/src/forwarder.ts &
  FORWARDER_PID=$!
  ops "forwarder-started" "\"listen\":\"$FORWARDER_LISTEN\""
else
  ops "forwarder-missing" "\"reason\":\"router/src/forwarder.ts not in image\""
fi

# --- 6. ChatGPT sign-in check (no login at boot) -----------------------------------------
# Device-code sign-in is blocked for the USC ChatGPT Edu workspace (verified Nov 13), so the
# login is done once over `gcloud beta run instances ssh` with the browser flow, as user
# "agent" with this container's env (see deploy/LOGIN.md). Here we only report the state.
if openclaw models auth list 2>/dev/null | grep -q 'openai'; then
  ops "chatgpt-login-present"
else
  ops "chatgpt-login-needed" "\"how\":\"instance ssh, browser sign-in as user agent\""
fi

# --- 7. Gateway (foreground process we supervise) --------------------------------------
openclaw gateway run &
GATEWAY_PID=$!

shutdown() { # shutdown <exit code>: 0 on SIGTERM, 1 if a child died (Cloud Run restarts us)
  ops "shutdown" "\"exitCode\":${1:-0}"
  # Final snapshot first, while the gateway still runs (Cloud Run allows ~10 s after SIGTERM). No
  # --verify to save time; restore verifies anyway. Best effort: the 1-minute job (5-minute interval,
  # or right after a ChatGPT token refresh) is the real guarantee. snapshot.mjs refuses if boot restore
  # failed (marker), so this never overwrites good snapshots with empty state.
  if [ -f "$STATE_DIR/state/openclaw.sqlite" ]; then
    timeout 8 node /app/jobs/snapshot.mjs --force --no-verify --reason shutdown >/dev/null 2>&1 \
      || ops "final-snapshot-failed"
  fi
  [ -n "$GATEWAY_PID" ] && kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  kill -TERM ${FORWARDER_PID:+"$FORWARDER_PID"} 2>/dev/null || true
  [ -n "$GATEWAY_PID" ] && wait "$GATEWAY_PID" 2>/dev/null || true
  kill -TERM "$TAILSCALED_PID" 2>/dev/null || true
  wait "$TAILSCALED_PID" 2>/dev/null || true
  kill -TERM "$TAIL_PID" 2>/dev/null || true
  ops "stopped"
  exit "${1:-0}"
}
trap 'shutdown 0' TERM INT

# --- 8. Isolation report once the gateway listens (evidence for the security audit) ----
(
  for _ in $(seq 1 120); do
    ss -ltnH 2>/dev/null | grep -q '127.0.0.1:18789' && break
    sleep 2
  done
  CAPEFF="$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
  PORTS="$(ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u | paste -sd, -)"
  ops "isolation-report" "\"user\":\"$(id -un)\",\"uid\":$(id -u),\"capEff\":\"$CAPEFF\",\"listening\":\"$PORTS\""
  # --- 8b. Scheduled jobs (M6): declare/update from the image, then missed-job catch-up. The HTTP
  # listener can come up before the scheduler accepts calls, so retry a few times.
  for attempt in 1 2 3; do
    /app/jobs/install-jobs.sh && break
    ops "jobs-install-retry" "\"attempt\":$attempt"
    sleep 30
  done
) &

# --- 9. Supervise: if the gateway, tailscaled or the forwarder dies, exit so Cloud Run restarts us
set +e
wait -n "$GATEWAY_PID" "$TAILSCALED_PID" ${FORWARDER_PID:+"$FORWARDER_PID"}
STATUS=$?
ops "child-exited" "\"status\":$STATUS"
if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  ops "gateway-log-tail" "\"file\":\"/tmp/openclaw\""
  tail -n 40 /tmp/openclaw/openclaw-*.log 2>/dev/null | cut -c1-400 || true
fi
shutdown 1
