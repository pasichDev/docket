# Official docket container image (RFC "Local and Self-Hosted Backend Modes" §25,
# Implementation Phase 5). Runs `docket serve` — the authoritative remote-mode server —
# never the stdio MCP process (that stays local, spawned by each MCP host via npx).
#
# Multi-stage: `builder` compiles TypeScript; `runtime` ships only the compiled output plus
# production dependencies. Buildx multi-arch clean: both stages use the standard
# node:20-alpine base image (published for linux/amd64 and linux/arm64), no
# architecture-specific steps, and this project has no native (node-gyp) dependencies to
# cross-compile — see the final report for what was and wasn't actually verified for arm64
# in this environment.
#
# Build (single-arch, for local testing):
#   docker build -t docket:local .
# Build + push both architectures (needs `docker buildx create --use` once):
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/pasichdev/docket:latest --push .

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Every tsconfig, not just the root one. `npm run build` runs three compilers — the server,
# the browser client, and the client's tests — so copying only tsconfig.json meant the image
# built the documented build command with two of its three configs missing. The build failed;
# nothing in CI ever ran it, so nothing noticed.
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY skills ./skills

# docs/headless.md tells operators to run `docker compose exec docket docket devices pair`.
# Without this the image has no `docket` on PATH at all and the documented command fails
# with "executable file not found" — the first thing a new self-hoster is asked to type.
RUN ln -s /app/dist/launcher.js /usr/local/bin/docket && chmod +x /app/dist/launcher.js

# Runs as an unprivileged user, not root — same posture a systemd `User=docket` deployment
# gets (see docs/docket.service), just expressed the container way.
RUN addgroup -S docket && adduser -S docket -G docket \
  && mkdir -p /data && chown -R docket:docket /data /app
USER docket

# RFC §9: binding to all interfaces (0.0.0.0) MUST be explicit — inside a container this
# IS the explicit choice (the host's own port mapping, not this process, is what actually
# exposes it beyond localhost), so it's the image's own default rather than something
# every docker-compose.yml has to repeat.
ENV DOCKET_DATA_DIR=/data
ENV DOCKET_SERVER_HOST=0.0.0.0
ENV DOCKET_SERVER_PORT=8788

EXPOSE 8788
VOLUME ["/data"]

# busybox wget (present in node:*-alpine) rather than curl, which alpine doesn't ship by
# default — avoids adding a package just for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${DOCKET_SERVER_PORT}/api/v1/health" || exit 1

# `docket serve` handles SIGTERM directly (server/cli.ts's shutdown handler closes the
# HTTP server and every open SSE connection before exiting) — no separate init/tini needed
# to forward the signal, since `node dist/launcher.js` runs as PID 1 here and Node itself
# delivers SIGTERM straight to the process's own handler.
ENTRYPOINT ["node", "dist/launcher.js", "serve"]
