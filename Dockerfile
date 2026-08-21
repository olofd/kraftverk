# syntax=docker/dockerfile:1

# kraftverk server, containerised.
#
# The server only — not the app. The app is a browser client that you point at
# this container's address under App settings, which is exactly the shape the
# "add a server" flow was built for. See docs/DOCKER.md.
#
# Two stages because the two jobs want different tools: npm resolves the
# lockfile exactly, and Bun runs the server. Nothing is compiled in between —
# TypeScript is executed directly, so there is no build output to carry over.

# --- dependencies ------------------------------------------------------------

FROM node:22-bookworm-slim AS deps

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

# --- runtime -----------------------------------------------------------------

FROM oven/bun:1 AS runtime

WORKDIR /app

# Every path the server writes to points into /data. The source tree stays a
# read-only image layer owned by root, which is both tidier and one less thing a
# running container can damage.
ENV NODE_ENV=production \
    KRAFTVERK_DB=/data/kraftverk.db \
    KRAFTVERK_BASELINE_FILE=/data/baseline.json \
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

# 3333 is the API. 1883 is the MQTT broker, and only matters with
# STATION_DRIVER=device — see docs/DOCKER.md for the DNS redirect it needs.
EXPOSE 3333 1883

VOLUME ["/data"]

# `bun` directly, not `npm start`: that script goes through scripts/run-bun.mjs,
# which exists to find Bun on a developer's machine and needs Node to do it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "process.exit((await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3333) + '/api/health').catch(() => null))?.ok ? 0 : 1)"

CMD ["bun", "run", "server/src/index.ts"]
