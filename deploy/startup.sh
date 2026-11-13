#!/usr/bin/env bash
# Container entrypoint for the A3 agent (run by tini as the non-root user "agent").
# Order: secrets -> config -> (restore: M7) -> tailscaled -> tailscale up -> forwarder
#        -> gateway (OpenClaw runs Tailscale Serve :443 itself) -> isolation report -> supervise.
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

# --- 2. Config: repo template wins on every boot; keep the `auth` block the login wrote ---
mkdir -p "$STATE_DIR"
AUTH_JSON=""
if [ -f "$CONFIG_PATH" ]; then
  AUTH_JSON="$(openclaw config get auth --json 2>/dev/null || true)"
fi
cp /app/openclaw.template.json5 "$CONFIG_PATH"
if [ -n "$AUTH_JSON" ] && [ "$AUTH_JSON" != "null" ]; then
  openclaw config set auth "$AUTH_JSON" --strict-json >/dev/null
fi
openclaw config validate --json >/dev/null || die "config invalid"
ops "config-applied"

# --- 3. Restore OpenClaw state from the bucket: TODO M7 (snapshot/restore, guided) -------
ops "state-restore-skipped" "\"reason\":\"not implemented until M7\""

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

# --- 5. Ollama forwarder (student-written, M2 step 8). Absent -> local route unavailable --
FORWARDER_PID=""
if [ -f /app/router/src/forwarder.ts ]; then
  node /app/router/src/forwarder.ts &
  FORWARDER_PID=$!
  ops "forwarder-started" "\"listen\":\"$FORWARDER_LISTEN\""
else
  ops "forwarder-missing" "\"reason\":\"router/src/forwarder.ts not in image\""
fi

# --- 6. Gateway (foreground process we supervise) --------------------------------------
openclaw gateway run &
GATEWAY_PID=$!

shutdown() { # shutdown <exit code>: 0 on SIGTERM, 1 if a child died (Cloud Run restarts us)
  ops "shutdown" "\"exitCode\":${1:-0}"
  # TODO M7: final state snapshot to the bucket before exiting.
  kill -TERM "$GATEWAY_PID" ${FORWARDER_PID:+"$FORWARDER_PID"} 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  kill -TERM "$TAILSCALED_PID" 2>/dev/null || true
  wait "$TAILSCALED_PID" 2>/dev/null || true
  ops "stopped"
  exit "${1:-0}"
}
trap 'shutdown 0' TERM INT

# --- 7. Isolation report (evidence for the security audit) -----------------------------
(
  sleep 20
  CAPEFF="$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
  PORTS="$(ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u | paste -sd, -)"
  ops "isolation-report" "\"user\":\"$(id -un)\",\"uid\":$(id -u),\"capEff\":\"$CAPEFF\",\"listening\":\"$PORTS\""
) &

# --- 8. ChatGPT sign-in on first boot (device code shown in the logs; separate from laptop)
if ! openclaw models auth list 2>/dev/null | grep -q 'openai'; then
  ops "chatgpt-login-needed" "\"hint\":\"open the URL and enter the code printed below\""
  (
    if openclaw models auth login --provider openai --method device-code; then
      ops "chatgpt-login-done"
    else
      ops "chatgpt-login-failed"
    fi
  ) &
fi

# --- 9. Supervise: if the gateway, tailscaled or the forwarder dies, exit so Cloud Run restarts us
set +e
wait -n "$GATEWAY_PID" "$TAILSCALED_PID" ${FORWARDER_PID:+"$FORWARDER_PID"}
STATUS=$?
ops "child-exited" "\"status\":$STATUS"
shutdown 1
