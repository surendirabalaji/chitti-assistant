# syntax=docker/dockerfile:1
# Cloud Run image for the A3 agent: OpenClaw 2026.10.9 + a3-router plugin + Tailscale (userspace).
# Build from the repo root:  docker build --platform linux/amd64 -f deploy/Dockerfile -t <tag> .

# Base image pinned by digest (resolved Nov 12 for node:24.22.1-bookworm-slim).
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ARG TAILSCALE_VERSION=1.104.7
ARG TAILSCALE_SHA256=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c
# gogcli (Gmail/Calendar for the gog skill). v0.47.1 released 2026-10-27 (>= 14 days old, AGENTS.md rule 4);
# sha256 from the release's checksums.txt.
ARG GOG_VERSION=0.47.1
ARG GOG_SHA256=279bc3a03c1919d774e268ef229949f45b753a0e21257f9fb315b05be7a40ea9

# tini: PID 1 that forwards SIGTERM. iproute2 (ss) + procps (ps): isolation report.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini iproute2 procps \
 && rm -rf /var/lib/apt/lists/*

# Tailscale static binaries; the build fails if the download doesn't match the checksum.
ADD --checksum=sha256:${TAILSCALE_SHA256} \
    https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz /tmp/tailscale.tgz
RUN tar -xzf /tmp/tailscale.tgz -C /tmp \
 && install -m 0755 /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale \
                    /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled /usr/local/bin/ \
 && rm -rf /tmp/tailscale*

# gog: the real binary lives outside PATH; /usr/local/bin/gog is the no-send wrapper the agent uses.
ADD --checksum=sha256:${GOG_SHA256} \
    https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_amd64.tar.gz /tmp/gog.tgz
RUN mkdir -p /tmp/gog /usr/local/lib/gogcli \
 && tar -xzf /tmp/gog.tgz -C /tmp/gog \
 && install -m 0755 /tmp/gog/gog /usr/local/lib/gogcli/gog \
 && rm -rf /tmp/gog /tmp/gog.tgz
COPY --chmod=0755 deploy/gog-agent.sh /usr/local/bin/gog

# Unprivileged runtime user. Only its home, the Tailscale socket dir and the bucket mount are writable.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid agent --create-home --home-dir /home/agent --shell /usr/sbin/nologin agent \
 && mkdir -p /var/run/tailscale /mnt/state \
 && chown agent:agent /var/run/tailscale /mnt/state

# OpenClaw from the lockfile only (root-owned, so the agent can't modify its own code).
WORKDIR /app/openclaw
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Router plugin (no runtime dependencies; OpenClaw provides the SDK import at runtime).
COPY router/package.json router/openclaw.plugin.json /app/router/
COPY router/src /app/router/src

# send-email: the only send path (recipient allowlist in code; human approval via exec approvals).
# Root-owned and not writable by the agent, including the allowlist file.
# (COPY --chmod would also apply to the created directories and make them untraversable.)
COPY skills/send-email/send-email.mjs skills/send-email/allowlist.txt /app/send-email/
COPY skills/send-email/SKILL.md /app/skills/send-email/SKILL.md
RUN chown -R root:root /app/send-email /app/skills \
 && chmod 0755 /app/send-email /app/skills /app/skills/send-email \
 && chmod 0644 /app/send-email/* /app/skills/send-email/SKILL.md \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /app/send-email/send-email.mjs "$@"\n' > /usr/local/bin/send-email \
 && chmod 0755 /usr/local/bin/send-email

# focus-finder v1.0.0 (same bytes as the ClawHub release, sha256 7dadb58c...450a): a root-owned copy the
# agent can't edit, so `focus-finder` can be allowlisted for unattended cron jobs (the ClawHub install in
# the workspace is agent-writable and stays approval-gated). Reads stdin, prints times, no network.
COPY skills/focus-finder/focus-finder.mjs /app/focus-finder/
RUN chown -R root:root /app/focus-finder \
 && chmod 0755 /app/focus-finder \
 && chmod 0644 /app/focus-finder/focus-finder.mjs \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /app/focus-finder/focus-finder.mjs "$@"\n' > /usr/local/bin/focus-finder \
 && chmod 0755 /usr/local/bin/focus-finder

# Scheduled jobs (M6): installer, command-job scripts, briefing/recap prompts. Root-owned and read-only for
# the agent, because command jobs run unattended in the gateway and a3-activity is allowlisted.
COPY deploy/jobs/lib.mjs deploy/jobs/alerts.mjs deploy/jobs/hourly.mjs deploy/jobs/activity.mjs \
     deploy/jobs/catchup.mjs deploy/jobs/briefing.md deploy/jobs/recap.md deploy/jobs/install-jobs.sh /app/jobs/
RUN chown -R root:root /app/jobs \
 && chmod 0755 /app/jobs /app/jobs/install-jobs.sh \
 && chmod 0644 /app/jobs/*.mjs /app/jobs/*.md \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /app/jobs/activity.mjs "$@"\n' > /usr/local/bin/a3-activity \
 && chmod 0755 /usr/local/bin/a3-activity

COPY deploy/exec-approvals.json5 /app/exec-approvals.json5
COPY deploy/openclaw.template.json5 /app/openclaw.template.json5
COPY --chmod=0755 deploy/startup.sh /app/startup.sh

ENV PATH=/app/openclaw/node_modules/.bin:$PATH \
    NODE_ENV=production \
    HOME=/home/agent \
    OPENCLAW_STATE_DIR=/home/agent/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/agent/.openclaw/openclaw.json \
    OPENCLAW_NO_AUTO_UPDATE=1 \
    DO_NOT_TRACK=1 \
    TS_HOSTNAME=a3-cloud-agent \
    STATE_MOUNT=/mnt/state \
    FORWARDER_LISTEN=127.0.0.1:11435 \
    OLLAMA_UPSTREAM=http://surendiras-macbook-air.tail9bf1e8.ts.net:11434 \
    SOCKS_PROXY=socks5h://127.0.0.1:1055 \
    GOG_HOME=/mnt/state/gogcli \
    GOG_KEYRING_BACKEND=file \
    DBUS_SESSION_BUS_ADDRESS=disabled:

USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/app/startup.sh"]
