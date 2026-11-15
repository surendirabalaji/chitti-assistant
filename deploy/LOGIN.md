# Cloud ChatGPT sign-in (one time, browser flow over instance SSH)

Device-code sign-in is blocked for the USC ChatGPT Edu workspace ("Please contact your workspace
admin to enable device code authentication", verified Nov 13 2026). The course Setup Recommendations
(§4.7) describe the fallback used here: browser sign-in, then paste the returned localhost callback
URL into the waiting terminal. This is a separate login from the laptop's (never copy laptop auth).

The SSH shell is **root without the gateway's environment** (Setup Recommendations §4.7). Run the
login as user `agent` with the container's paths, or the credentials land where the gateway never
reads them.

```sh
gcloud beta run instances ssh a3-agent --region us-west1
# inside the instance (root shell):
runuser -u agent -- env HOME=/home/agent \
  OPENCLAW_STATE_DIR=/home/agent/.openclaw \
  OPENCLAW_CONFIG_PATH=/home/agent/.openclaw/openclaw.json \
  PATH=/app/openclaw/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  sh -c 'OPENCLAW_GATEWAY_TOKEN="$(cat /home/agent/.openclaw/.gateway-token)" exec openclaw models auth login --provider openai'
```

1. Open the printed URL in the laptop browser, sign in with the USC account.
2. The browser ends on a `http://localhost:1455/...` page that fails to load. Copy that full URL and
   paste it into the waiting terminal. **It is login material: never paste it in chat, screenshots
   or logs.**
3. Check as the same user: `openclaw models auth list` shows an openai profile.

Persistence: the login lives in SQLite on local disk (`agents/main/agent/openclaw-agent.sqlite`).
Until M7 snapshots exist, a container restart loses it and this must be repeated.

# Gmail + Calendar sign-in for gog (one time; the token survives restarts)

gog keeps its refresh token in an **encrypted file keyring on the bucket** (`GOG_HOME=/mnt/state/gogcli`),
so unlike the ChatGPT login this survives container restarts. Run it as user `agent` with the
container's gog environment; the keyring password comes from the 0600 file `startup.sh` writes.
Use the **real** binary (`/usr/local/lib/gogcli/gog`): the agent-facing `gog` wrapper adds `--no-input`.

```sh
gcloud beta run instances ssh a3-agent --region us-west1
# inside the instance (root shell):
runuser -u agent -- env HOME=/home/agent GOG_HOME=/mnt/state/gogcli GOG_KEYRING_BACKEND=file \
  DBUS_SESSION_BUS_ADDRESS=disabled: PATH=/usr/local/bin:/usr/bin:/bin \
  sh -c 'GOG_KEYRING_PASSWORD="$(cat /home/agent/.config/a3/gog-keyring-password)" exec \
    /usr/local/lib/gogcli/gog auth add chittia3assistant@gmail.com --services gmail,calendar \
    --gmail-scope read-send --extra-scopes https://www.googleapis.com/auth/gmail.compose --manual'
```

1. Open the printed URL in the laptop browser, sign in as the **test account** (never personal/USC).
   The app is unverified (published, single user): Advanced → "Go to chitti-a3 (unsafe)".
2. Grant Gmail + Calendar. The browser ends on a `localhost` page that fails to load. Copy that full URL
   into the waiting terminal. **It is login material: never paste it in chat, screenshots or logs.**
3. Check (same `runuser ... sh -c` prefix, command `/usr/local/lib/gogcli/gog auth list --check`):
   the account shows as valid. Then the wrapper: `gog --account chittia3assistant@gmail.com calendar events --today --json`.

Scopes: Gmail read + send (`read-send`) + compose (drafts), Calendar. Sending is blocked for the
agent by the wrapper (`--gmail-no-send`); the send-email wrapper (allowlist + human approval) is the
only send path. Re-run with `--force-consent` and the same flags if Google ever revokes the token.
