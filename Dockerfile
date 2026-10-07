# syntax=docker/dockerfile:1

# kraftverk, containerised: two images from one file.
#
#   --target server   the API, and — as a second service from the same image —
#                     the MQTT broker stations connect to. The default.
#   --target web      the app, built for the browser and served by Caddy, which
#                     also forwards /api to the server. See web/Caddyfile.
#
# docker-compose.yml builds both. See docs/DOCKER.md.
#
# The server needs no build step: npm resolves the lockfile exactly, and Bun
# runs the TypeScript directly. The app is exported to static files by Expo.

# --- dependencies ------------------------------------------------------------

# Node 24, as package.json's volta pin: the lockfile is written by its npm.
FROM node:24.21.0-bookworm-slim AS sources

# Every workspace's manifest has to exist for `npm ci` to validate the lockfile,
# even the ones an image will never run — and only the manifests, so that both
# installs below, and the large layers they produce, are rebuilt when
# dependencies change rather than whenever any source file does. With the build
# cache CI keeps, an unchanged lockfile then means byte-identical layers, which
# a host that already has them does not download again.
#
# Found rather than listed: a device type is a package, and adding one must not
# mean editing this file (docs/ARCHITECTURE.md §1). This stage sees every
# source change, but what it hands on is only the manifests — so the copy
# below, and everything after it, stays cached until one of them changes.
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \; \
 && cp package-lock.json /manifests/

FROM node:24.21.0-bookworm-slim AS manifests

WORKDIR /app
COPY --from=sources /manifests ./

FROM manifests AS deps

# The server, and every package it finds at startup: transports,
# integrations (with their protocols) and device packages each bring their own dependencies — the MQTT
# transport its broker (aedes). A parent folder selects every workspace in it,
# so a package added there is installed with no change here.
#
# --omit=optional is what leaves Bluetooth out, and it is the whole reason the
# Bluetooth transport declares noble optional. noble drags in four native
# builds — node-gyp, usb, bluetooth-hci-socket, serialport — for a radio a
# container has no honest access to, and it is imported lazily, so nothing
# else reaches for it.
#
# --ignore-scripts costs nothing here: with dev and optional dependencies gone,
# nothing left in the tree has an install script.
#
# npm nests a package wherever versions disagree: the server's zod v4 lives in
# server/node_modules, because an Expo dependency holds v3 at the root. The
# server stage copies the root and that one; a nested node_modules anywhere
# else would be left behind, so the build stops and says so instead.
#
# (The server's tree also carries React, Tamagui and Expo: the device package's
# screens name them as optional peers, and npm resolves optional peers that
# the app installs elsewhere in the workspace. Unused by the server, and in a
# layer that changes only with the lockfile.)
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
      --workspace server --workspace packages/device-sdk \
      --workspace packages/transports \
      --workspace packages/integrations --workspace packages/devices \
      --include-workspace-root \
 && mkdir -p server/node_modules \
 && if find packages -mindepth 2 -maxdepth 4 -type d -name node_modules | grep .; then \
      echo "A workspace has its own node_modules; copy it into the server stage." >&2; exit 1; \
    fi

# --- the app, built for the web ----------------------------------------------

FROM manifests AS web-build

# Every workspace, dev tools included — Expo is what does the export, and the
# app imports device types' screens from their own packages, which a
# client-only install leaves unlinked. --ignore-scripts keeps the native
# Bluetooth builds out; nothing the export uses needs an install script.
RUN npm ci --ignore-scripts

COPY packages ./packages
COPY client ./client

# The app finds its server at whatever address it was loaded from, and asks for
# /api there — one build for the LAN address and the public name alike.
ENV EXPO_PUBLIC_API_URL=same-origin
RUN npm run build:web --workspace client

# --- web ---------------------------------------------------------------------

FROM caddy:2.11.6-alpine AS web

# So a host can find — and prune — kraftverk's images and nothing else.
LABEL se.kraftverk.image="web"

# Not root: both ports are above 1024, and Caddy only needs to write its own
# small state.
RUN addgroup -S web && adduser -S -G web web \
 && mkdir -p /data/caddy /config/caddy && chown -R web:web /data /config
USER web

COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/client/dist /srv

# 8080 is the home network's entrance, 8090 the internet's — the reverse proxy
# in front forwards there. docker-compose.yml publishes 8090 on loopback only.
EXPOSE 8080 8090

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

# --- server ------------------------------------------------------------------
#
# Last, so a plain `docker build .` builds it.

# The same Bun the tests run on — root package.json pins it — so what CI
# tested is what the container runs. Bump both together.
FROM oven/bun:1.4.2 AS server

LABEL se.kraftverk.image="server"

WORKDIR /app

# Every path the server writes to — and the reset passphrase it reads
# (docs/DOCKER.md) — points into /data. The source tree stays a
# read-only image layer owned by root, which is both tidier and one less thing a
# running container can damage.
ENV NODE_ENV=production \
    KRAFTVERK_DB=/data/kraftverk.db \
    KRAFTVERK_BROKER_DIR=/data/broker \
    KRAFTVERK_LOG_DIR=/data/logs \
    KRAFTVERK_RESET_SECRET_FILE=/data/reset-secret \
    PORT=3333 \
    HOST=0.0.0.0

# Dependencies first — a large layer that changes only with the lockfile — then
# the sources, which change with every commit. Both node_modules: see the deps
# stage. npm links workspaces as relative symlinks (node_modules/@kraftverk/
# integration-sydpower → ../../packages/integrations/sydpower), which resolve because
# both stages build in /app and packages/ is copied alongside.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY packages ./packages
COPY server ./server

# The server finds its integrations, transports and device types in packages/ at
# startup rather than importing a fixed list, so that directory is not
# optional: without it the container starts able to reach nothing.
# Only /data and /relay are writable, and only they are chowned — a recursive
# chown of /app would copy every node_modules file into a new layer to change
# one bit of metadata the server never needs changed. /relay holds the relay's
# token, which the server makes (docs/DOCKER.md#the-relay): a new volume there
# takes this owner from the image.
RUN mkdir -p /data /relay && chown bun:bun /data /relay

USER bun

# 3333 is the API. 1883 is the MQTT broker, which runs from this same image as
# its own container (`bun run packages/transports/mqtt/src/broker/main.ts`) — see
# docker-compose.yml and docs/BROKER.md.
EXPOSE 3333 1883

VOLUME ["/data"]

# `bun` directly, not `npm start`: that script goes through scripts/run-bun.mjs,
# which exists to find Bun on a developer's machine and needs Node to do it.
# The broker's service replaces this check with its own in docker-compose.yml.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "process.exit((await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3333) + '/api/health').catch(() => null))?.ok ? 0 : 1)"

CMD ["bun", "run", "server/src/index.ts"]
