#!/usr/bin/env bash
#
# Replaces a running kraftverk with new images, without dropping the station.
# What docs/DOCKER.md#operating-it says to do by hand, as one step a pipeline —
# or a person — can run.
#
#   scripts/deploy.sh          the server and the app. The broker is started if
#                              it is not running, and never recreated: that
#                              drops the station.
#   scripts/deploy.sh broker   recreate the broker, for when it is behind. The
#                              station is gone for about a minute.
#
# Against whichever Docker the environment names: the local one, a context, or
# DOCKER_HOST=ssh://user@host. The images must be on that Docker already, or
# pullable from where their names say.
#
# Everything about the installation comes from the environment, and nothing
# has a default here — a deploy that guessed would quietly change the running
# system:
#
#   COMPOSE_PROJECT_NAME     the stack's project. Its data volume belongs to
#                            it: another name is an empty installation.
#   KRAFTVERK_SERVER_IMAGE   the images to run — the ones the smoke test passed.
#   KRAFTVERK_WEB_IMAGE
#   KRAFTVERK_SECRET_KEY     never changed once set: secrets sealed with the
#                            old one cannot be read.
#   READ_ONLY                0 for a real installation; see docs/DOCKER.md.
#   KRAFTVERK_ALLOWED_HOSTS  the public name, if any. May be empty.
#
# and the ports, if not the defaults (docs/DOCKER.md#environment).

set -euo pipefail
cd "$(dirname "$0")/.."

what=${1:-app}
case $what in
  app | broker) ;;
  *) echo "usage: scripts/deploy.sh [broker]" >&2; exit 2 ;;
esac

for name in COMPOSE_PROJECT_NAME KRAFTVERK_SERVER_IMAGE KRAFTVERK_WEB_IMAGE KRAFTVERK_SECRET_KEY READ_ONLY; do
  if [ -z "${!name:-}" ]; then
    echo "$name is not set; refusing to deploy." >&2
    exit 1
  fi
done
if [ -z "${KRAFTVERK_ALLOWED_HOSTS+set}" ]; then
  echo "KRAFTVERK_ALLOWED_HOSTS is not set; set it, empty if nothing reaches this server by a public name." >&2
  exit 1
fi
export COMPOSE_PROJECT_NAME KRAFTVERK_SERVER_IMAGE KRAFTVERK_WEB_IMAGE KRAFTVERK_SECRET_KEY READ_ONLY KRAFTVERK_ALLOWED_HOSTS

compose() { docker compose -f docker-compose.yml "$@"; }

if [ "$what" = broker ]; then
  compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 broker
  compose ps broker
  exit 0
fi

# The broker first, and only if it is not there: started if it is stopped,
# created on the very first deploy, never recreated here.
compose up -d --no-build --no-recreate broker
# The server and the app, replaced with what was just tested.
compose up -d --no-build --no-deps --wait --wait-timeout 180 kraftverk web
compose ps

# Proof it answers, through the same door a browser uses.
compose exec -T web wget -qO- http://127.0.0.1:8080/api/auth/state
echo

expected=$(compose exec -T kraftverk bun --eval "console.log((await import('./packages/transports/mqtt/src/broker/shared.ts')).brokerBuild())")
running=$(compose exec -T broker bun --eval "console.log((await (await fetch('http://127.0.0.1:3883/health')).json()).build)")
if [ "$expected" != "$running" ]; then
  echo "The broker is running an older build ($running; these images' is $expected)."
  echo "Run 'scripts/deploy.sh broker' when losing the station for a minute is fine."
else
  echo "The broker is current ($running)."
fi

# These images and the ones before stay; kraftverk images older than a week go.
docker image prune --all --force --filter label=se.kraftverk.image --filter until=168h > /dev/null
