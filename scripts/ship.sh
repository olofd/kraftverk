#!/usr/bin/env bash
#
# The pipeline without Forgejo: .forgejo/workflows/pipeline.yml's stages, run
# from your own machine, in order — for when no Forgejo is running.
#
#   npm run ship              the server and the app
#   npm run ship -- broker    the same, then the broker recreated: the station
#                             is gone for about a minute (docs/DOCKER.md)
#
# Needs git, bash and Docker here — macOS, Linux, or Windows through WSL. The
# checks and the smoke test run in containers (ci/Dockerfile), so they are the
# same on every machine, and on main's last commit as committed, not the
# working tree.
#
# The installation is described in KRAFTVERK_DEPLOY_ENV (default
# ~/.config/kraftverk/deploy.env; scripts/deploy.env.example), as for the
# pipeline's deploy job.
#
# Images reach the server only after passing. A commit whose images are there
# already has passed, so its checks are not repeated: running this again after
# a failed deploy, or for the broker, goes straight to the deploy. docs/CI.md.

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
export KRAFTVERK_DEPLOY_ENV=$config

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

on_server() {
  if [ -n "$deploy_host" ]; then DOCKER_HOST=$deploy_host docker "$@"; else docker "$@"; fi
}

step() { printf '\n==== %s\n' "$1"; }

work=$(mktemp -d)
run_id=$$
finish() {
  status=$?
  docker rm --force "kraftverk-check-$run_id" "kraftverk-smoke-$run_id" > /dev/null 2>&1 || true
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
  step "Checks: $short"
  checks_image=$(bash "$work/scripts/ci/checks-image.sh")
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
fi

step "The deploy"
bash "$work/scripts/ci/release.sh" "$commit"
if [ "$what" = broker ]; then
  step "The broker"
  bash "$work/scripts/ci/release.sh" "$commit" broker
fi

step "Shipped $short"
