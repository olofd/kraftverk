#!/usr/bin/env bash
#
# The pipeline, from your own machine: checks main's last commit, builds its
# images, attacks them, and puts them on the server — the server and the app
# replaced, the station kept connected.
#
#   npm run ship              the server and the app
#   npm run ship -- broker    the same, then the broker recreated: the station
#                             is gone for about a minute (docs/DOCKER.md)
#
# Needs git, bash and Docker here — macOS, Linux, or Windows through WSL. The
# checks and the smoke test run in containers (ci/Dockerfile), so they are the
# same on every machine, and on the commit as committed, not the working tree.
#
# The installation is described outside the repository, in KRAFTVERK_DEPLOY_ENV
# (default ~/.config/kraftverk/deploy.env) — see scripts/deploy.env.example.
# KRAFTVERK_DEPLOY_HOST there is the server's Docker: ssh://<user>@<host>, and
# the images are copied there and deployed over SSH with your own key; empty,
# and this machine's Docker is the server's, as for a pipeline running on the
# server itself.
#
# Images reach the server only after passing. A commit whose images are there
# already has passed, so its checks are not repeated: running this again after
# a failed deploy, or for the broker, goes straight to the deploy.
#
# Each stage is a script of its own — scripts/ci/check.sh, scripts/ci/images.sh,
# scripts/ci/smoke-docker.sh, scripts/deploy.sh — for a CI server to run the
# same way. docs/CI.md.

set -euo pipefail
cd "$(dirname "$0")/.."

what=${1:-app}
case $what in
  app | broker) ;;
  *) echo "usage: npm run ship [-- broker]" >&2; exit 2 ;;
esac

config=${KRAFTVERK_DEPLOY_ENV:-$HOME/.config/kraftverk/deploy.env}
if [ ! -f "$config" ]; then
  echo "No $config. Copy scripts/deploy.env.example there, fill it in, and keep it to yourself (chmod 600)." >&2
  exit 1
fi
if ! deploy_host=$(. "$config" && [ -n "${KRAFTVERK_DEPLOY_HOST+set}" ] && printf '%s' "$KRAFTVERK_DEPLOY_HOST"); then
  echo "$config does not set KRAFTVERK_DEPLOY_HOST (empty for this machine's Docker), or does not read as a shell file." >&2
  exit 1
fi

branch=$(git symbolic-ref --short -q HEAD || true)
if [ "$branch" != main ]; then
  echo "Only main is shipped; this is ${branch:-a detached HEAD}." >&2
  exit 1
fi
commit=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
server_image=kraftverk-server:$commit
web_image=kraftverk-web:$commit
[ -z "$(git status --porcelain)" ] || echo "Uncommitted changes are not shipped: this ships $short as committed."

# The server's Docker.
on_server() {
  if [ -n "$deploy_host" ]; then DOCKER_HOST=$deploy_host docker "$@"; else docker "$@"; fi
}

step() { printf '\n==== %s\n' "$1"; }

work=$(mktemp -d)
run_id=$$
locked=0
finish() {
  status=$?
  docker rm --force "kraftverk-check-$run_id" "kraftverk-smoke-$run_id" > /dev/null 2>&1 || true
  [ "$locked" = 0 ] || on_server rm kraftverk-deploying > /dev/null 2>&1 || true
  rm -rf "$work"
  exit $status
}
trap finish EXIT
git archive HEAD | tar -x -C "$work"

# in_checks <name> <docker run options...> -- <command>: the commit, run in the
# checks image, in a container kept until the end so what it leaves can be read.
# A repository of its own there, of this commit alone: the architecture check
# asks git which files there are.
in_checks() {
  name=$1
  shift
  options=()
  while [ "$1" != -- ]; do options+=("$1"); shift; done
  shift
  git archive HEAD | docker run --name "$name" -i -e CI=1 "${options[@]}" "$checks_image" \
    bash -c 'mkdir -p /src && tar -x -C /src && cd /src && git init -q && git add . \
      && git -c user.name=ship -c user.email=ship@localhost commit -q -m '"$short"' && '"$*"
}

if on_server image inspect "$server_image" "$web_image" > /dev/null 2>&1; then
  step "$short has passed before and is on the server: straight to the deploy"
else
  # Named for what it is made of — ci/Dockerfile and the lockfile's
  # Playwright — and built only when that changes.
  playwright=$(sed -n '/"node_modules\/@playwright\/test": {/{n;s/.*"version": "\([^"]*\)".*/\1/p;q;}' "$work/package-lock.json")
  checks_image=kraftverk-ci:$(git rev-parse --short=12 HEAD:ci/Dockerfile)-$playwright
  if ! docker image inspect "$checks_image" > /dev/null 2>&1; then
    step "The checks image"
    docker build --quiet --tag "$checks_image" --build-arg "PLAYWRIGHT_VERSION=$playwright" - < "$work/ci/Dockerfile" > /dev/null
  fi

  step "Checks: $short"
  if ! in_checks "kraftverk-check-$run_id" -v kraftverk-npm-cache:/root/.npm -- bash scripts/ci/check.sh; then
    rm -rf e2e-report e2e-results
    docker cp "kraftverk-check-$run_id:/src/e2e-report" e2e-report > /dev/null 2>&1 || true
    docker cp "kraftverk-check-$run_id:/src/e2e-results" e2e-results > /dev/null 2>&1 || true
    [ ! -d e2e-report ] || echo "The end-to-end report is in e2e-report/." >&2
    exit 1
  fi

  step "The images"
  bash "$work/scripts/ci/images.sh" "$server_image" "$web_image"

  step "The stack, started and attacked"
  # Host networking: the stack's ports are published on this machine's Docker
  # host, which is where the checks container then is too.
  if ! in_checks "kraftverk-smoke-$run_id" --network host -v /var/run/docker.sock:/var/run/docker.sock \
    -e SMOKE_BUILD=0 -e "KRAFTVERK_SERVER_IMAGE=$server_image" -e "KRAFTVERK_WEB_IMAGE=$web_image" \
    -- bash scripts/ci/smoke-docker.sh; then
    docker cp "kraftverk-smoke-$run_id:/src/smoke-logs.txt" smoke-logs.txt > /dev/null 2>&1 || true
    [ ! -f smoke-logs.txt ] || echo "The stack's logs are in smoke-logs.txt." >&2
    exit 1
  fi

  if [ -n "$deploy_host" ]; then
    step "The images, to the server"
    docker save --platform linux/amd64 "$server_image" "$web_image" | on_server load
  fi
fi

step "The deploy"
# One change to the running system at a time: a container that only holds the
# name is the lock, wherever the deploy runs from.
if ! on_server create --name kraftverk-deploying --label "se.kraftverk.deploying=$short" "$server_image" true > /dev/null; then
  echo "Another deploy is running, or one stopped without cleaning up. If none is running:" >&2
  echo "  docker rm kraftverk-deploying   (on the server)" >&2
  exit 1
fi
locked=1
(
  set -a
  . "$config"
  set +a
  export KRAFTVERK_SERVER_IMAGE=$server_image KRAFTVERK_WEB_IMAGE=$web_image
  if [ -n "$deploy_host" ]; then export DOCKER_HOST=$deploy_host; fi
  bash "$work/scripts/deploy.sh"
  if [ "$what" = broker ]; then bash "$work/scripts/deploy.sh" broker; fi
)

step "Shipped $short"
