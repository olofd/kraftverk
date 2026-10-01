#!/usr/bin/env bash
#
# The pipeline's last stage: images that passed, put on the server and
# deployed. The deploy job in .forgejo/workflows/pipeline.yml, and the end of
# scripts/ship.sh.
#
#   scripts/ci/release.sh <commit>          the server and the app; the broker
#                                           started if it is not running
#   scripts/ci/release.sh <commit> broker   the broker recreated: the station
#                                           is gone for about a minute
#
# The images are kraftverk-server:<commit> and kraftverk-web:<commit>, as
# scripts/ci/images.sh made them — on this machine's Docker, or already on the
# server's. The installation is described in KRAFTVERK_DEPLOY_ENV (default
# ~/.config/kraftverk/deploy.env; scripts/deploy.env.example).
# KRAFTVERK_DEPLOY_HOST there is the server's Docker: ssh://…, and the images
# are copied there first; empty, and this machine's Docker is the server's.

set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -ge 1 ] || { echo "usage: scripts/ci/release.sh <commit> [broker]" >&2; exit 2; }
commit=$1
what=${2:-app}
case $what in
  app | broker) ;;
  *) echo "usage: scripts/ci/release.sh <commit> [broker]" >&2; exit 2 ;;
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

server_image=kraftverk-server:$commit
web_image=kraftverk-web:$commit

on_server() {
  if [ -n "$deploy_host" ]; then DOCKER_HOST=$deploy_host docker "$@"; else docker "$@"; fi
}

if ! on_server image inspect "$server_image" "$web_image" > /dev/null 2>&1; then
  if [ -z "$deploy_host" ] || ! docker image inspect "$server_image" "$web_image" > /dev/null 2>&1; then
    echo "The images of $commit are not here: they are made, and checked, by the stages before this one." >&2
    exit 1
  fi
  echo "The images, to the server"
  docker save --platform linux/amd64 "$server_image" "$web_image" | on_server load
fi

# One change to the running system at a time: a container that only holds the
# name is the lock, wherever the deploy runs from.
if ! on_server create --name kraftverk-deploying --label "se.kraftverk.deploying=$commit" "$server_image" true > /dev/null; then
  echo "Another deploy is running, or one stopped without cleaning up. If none is running:" >&2
  echo "  docker rm kraftverk-deploying   (on the server)" >&2
  exit 1
fi
trap 'on_server rm kraftverk-deploying > /dev/null 2>&1 || true' EXIT

(
  set -a
  . "$config"
  set +a
  export KRAFTVERK_SERVER_IMAGE=$server_image KRAFTVERK_WEB_IMAGE=$web_image
  if [ -n "$deploy_host" ]; then export DOCKER_HOST=$deploy_host; fi
  if [ "$what" = broker ]; then bash scripts/deploy.sh broker; else bash scripts/deploy.sh; fi
)
