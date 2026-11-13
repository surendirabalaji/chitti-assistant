# syntax=docker/dockerfile:1
# Cloud Run image for the A3 agent: OpenClaw 2026.10.9 + a3-router plugin + Tailscale (userspace).
# Build from the repo root:  docker build --platform linux/amd64 -f deploy/Dockerfile -t <tag> .

# Base image pinned by digest (resolved Nov 12 for node:24.22.1-bookworm-slim).
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ARG TAILSCALE_VERSION=1.104.7
ARG TAILSCALE_SHA256=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c

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
    SOCKS_PROXY=socks5h://127.0.0.1:1055

USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/app/startup.sh"]
