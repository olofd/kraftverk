# The image the pipeline's checks run in, on whichever machine runs them — a
# Mac, Windows through WSL, or a server's CI runner — so that they are the same
# everywhere: Node as package.json's volta pin, Chromium and its libraries for
# the end-to-end tests, and the Docker CLI for the smoke test, which drives the
# Docker it is given. scripts/ship.sh builds it; see docs/CI.md.

FROM docker:29-cli AS docker

FROM node:24.21.0-bookworm

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# The lockfile's version, passed in: Playwright only drives the browser build it
# was released with.
ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN test -n "$PLAYWRIGHT_VERSION" \
 && npx --yes "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium \
 && rm -rf /root/.npm
