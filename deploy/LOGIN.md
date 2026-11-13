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
