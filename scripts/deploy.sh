#!/usr/bin/env bash
#
# Puts new images into a running kraftverk without dropping the station: what
# docs/DEPLOY.md says to do by hand, as one step the pipeline — or a person on
# the server — runs.
#
#   scripts/deploy.sh              the server and the app, from the images named
#                                  by KRAFTVERK_SERVER_IMAGE and KRAFTVERK_WEB_IMAGE.
#                                  The broker is started if it is not running,
#                                  and recreated only when the protocols it
#                                  applies are not the ones these images install:
#                                  that drops the station for about a minute,
#                                  and without it a new protocol's devices could
#                                  be commanded by anything on the network.
#                                  Zigbee2MQTT is started where the zigbee
#                                  profile is on (COMPOSE_PROFILES).
#   scripts/deploy.sh --build      the images built first, from this checkout as
#                                  committed, and named by its commit.
#   scripts/deploy.sh broker       recreate the broker, for when it is behind.
#                                  The station is gone for about a minute.
#
# Against whichever Docker the environment names: this machine's, a context,
# or DOCKER_HOST=ssh://user@host.
#
# The installation comes from the environment, or from the file
# KRAFTVERK_DEPLOY_ENV names (scripts/deploy.env.example), and nothing about it
# has a default here — a deploy that guessed would quietly change the running
# system:
#
#   COMPOSE_PROJECT_NAME     the stack's project. Its data volume belongs to it:
#                            another name is an empty installation.
#   KRAFTVERK_SECRET_KEY     never changed once set: secrets sealed with the
#                            old one cannot be read.
#   READ_ONLY                0 for a real installation; docs/DOCKER.md.
#   KRAFTVERK_ALLOWED_HOSTS  the public name, if any. May be empty, never unset.
#
# and the ports, if not the defaults (docs/DOCKER.md#environment).

set -euo pipefail
cd "$(dirname "$0")/.."

build=0
what=app
for arg in "$@"; do
  case $arg in
    --build) build=1 ;;
    broker) what=broker ;;
    *) echo "usage: scripts/deploy.sh [--build] [broker]" >&2; exit 2 ;;
  esac
done

if [ -n "${KRAFTVERK_DEPLOY_ENV:-}" ]; then
  [ -r "$KRAFTVERK_DEPLOY_ENV" ] || { echo "Cannot read $KRAFTVERK_DEPLOY_ENV." >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$KRAFTVERK_DEPLOY_ENV"
  set +a
fi

if [ "$build" = 1 ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || echo "Uncommitted changes are left out: this builds $(git rev-parse --short HEAD) as committed."
  commit=$(git rev-parse HEAD)
  KRAFTVERK_SERVER_IMAGE=kraftverk-server:$commit
  KRAFTVERK_WEB_IMAGE=kraftverk-web:$commit
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  git archive HEAD | tar -x -C "$work"
  docker build --target server -t "$KRAFTVERK_SERVER_IMAGE" "$work"
  docker build --target web -t "$KRAFTVERK_WEB_IMAGE" "$work"
fi

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
# The server and the app, replaced with the images given.
compose up -d --no-build --no-deps --wait --wait-timeout 180 kraftverk relay web
compose ps

# Proof it answers, through the same door a browser uses.
compose exec -T web wget -qO- http://127.0.0.1:8080/api/auth/state
echo

# The protocols the broker applies, against those these images install. One new
# to it is a protocol whose commands it would forward unrecognised — and unguarded,
# to anyone — so the broker is recreated for it, whatever that costs the station.
installed=$(compose exec -T kraftverk bun --eval "console.log((await (await import('./packages/transports/mqtt/src/broker/policy.ts')).loadPolicies()).map((p) => p.protocol).sort().join(','))")
applied=$(compose exec -T broker bun --eval "console.log((await (await fetch('http://127.0.0.1:3883/health')).json()).protocols.sort().join(','))")
# And the clients it lets sign in, against those this installation names: a
# bridge whose password it was not given is one whose devices it refuses.
# Worked out as the broker does (shared.ts, clientsFingerprint).
clients=""
[ -n "${KRAFTVERK_ZIGBEE2MQTT_PASSWORD:-}" ] && clients="zigbee2mqtt=$KRAFTVERK_ZIGBEE2MQTT_PASSWORD"
wanted=$(printf '%s' "$clients" | sha256sum | cut -c1-12)
known=$(compose exec -T broker bun --eval "console.log((await (await fetch('http://127.0.0.1:3883/health')).json()).clients)")
if [ "$installed" != "$applied" ] || [ "$wanted" != "$known" ]; then
  echo "The broker applies [$applied] and knows clients $known; these images install [$installed], and this installation names $wanted. Recreating it: the station is gone for about a minute."
  compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 broker
fi

# Zigbee2MQTT, where the dongle is (the zigbee profile): after the broker, which it signs in to.
case ",${COMPOSE_PROFILES:-}," in
  *,zigbee,*) compose up -d --no-build --no-deps zigbee2mqtt ;;
esac

expected=$(compose exec -T kraftverk bun --eval "console.log((await import('./packages/transports/mqtt/src/broker/shared.ts')).brokerBuild())")
running=$(compose exec -T broker bun --eval "console.log((await (await fetch('http://127.0.0.1:3883/health')).json()).build)")
if [ "$expected" != "$running" ]; then
  echo "The broker is running an older build ($running; these images' is $expected)."
  echo "Run 'scripts/deploy.sh broker' when losing the station for a minute is fine."
else
  echo "The broker is current ($running)."
fi

# These images and the ones before stay; kraftverk images unused for a week go.
docker image prune --all --force --filter label=se.kraftverk.image --filter until=168h > /dev/null
