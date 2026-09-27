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
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# Every workspace's manifest has to exist for `npm ci` to validate the lockfile,
# even the ones this image will never run. They are a few hundred bytes each.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY packages ./packages

# --omit=optional is what leaves Bluetooth out, and it is the whole reason the
# server declares noble optional. noble drags in four native builds — node-gyp,
# usb, bluetooth-hci-socket, serialport — for a radio a container has no honest
# access to, and it is imported lazily, so the simulator and the MQTT transport
# never reach for it.
#
# --ignore-scripts costs nothing here: with dev and optional dependencies gone,
# nothing left in the tree has an install script.
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
      --workspace server --include-workspace-root

# --- the app, built for the web ----------------------------------------------

FROM node:24-bookworm-slim AS web-build

WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY packages ./packages

# The client's whole tree, dev tools included — Expo is what does the export.
# --ignore-scripts keeps the native Bluetooth builds out; nothing the export
# uses needs an install script.
RUN npm ci --ignore-scripts --workspace client --include-workspace-root

COPY client ./client

# The app finds its server at whatever address it was loaded from, and asks for
# /api there — one build for the LAN address and the public name alike.
ENV EXPO_PUBLIC_API_URL=same-origin
RUN npm run build:web --workspace client

# --- web ---------------------------------------------------------------------

FROM caddy:2.11.4-alpine AS web

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

# --- server ------------------------------------------------------------------
#
# Last, so a plain `docker build .` builds it.

# The same Bun the tests run on — root package.json pins it — so what CI
# tested is what the container runs. Bump both together.
FROM oven/bun:1.4.0 AS server

LABEL se.kraftverk.image="server"

WORKDIR /app

# Every path the server writes to points into /data. The source tree stays a
# read-only image layer owned by root, which is both tidier and one less thing a
# running container can damage.
ENV NODE_ENV=production \
    KRAFTVERK_DB=/data/kraftverk.db \
    KRAFTVERK_BASELINE_FILE=/data/baseline.json \
    KRAFTVERK_BROKER_DIR=/data/broker \
    KRAFTVERK_LOG_DIR=/data/logs \
    PORT=3333 \
    HOST=0.0.0.0

# npm links workspaces as relative symlinks — node_modules/@kraftverk/protocol
# points at ../../packages/protocol — so this only resolves because both stages
# build in /app and packages/ is copied alongside.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY server ./server

# The plugin host reads packages/plugins at runtime rather than importing a
# fixed list, so that directory is not optional: without it the container starts
# with no extensions and no explanation.
# Only /data is writable, and only it is chowned — a recursive chown of /app
# would copy every node_modules file into a new layer to change one bit of
# metadata the server never needs changed.
RUN mkdir -p /data && chown bun:bun /data

USER bun

# 3333 is the API. 1883 is the MQTT broker, which runs from this same image as
# its own container (`bun run server/src/broker/main.ts`) — see
# docker-compose.yml and docs/BROKER.md.
EXPOSE 3333 1883

VOLUME ["/data"]

# `bun` directly, not `npm start`: that script goes through scripts/run-bun.mjs,
# which exists to find Bun on a developer's machine and needs Node to do it.
# The broker's service replaces this check with its own in docker-compose.yml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "process.exit((await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3333) + '/api/health').catch(() => null))?.ok ? 0 : 1)"

CMD ["bun", "run", "server/src/index.ts"]
