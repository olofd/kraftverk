#!/usr/bin/env bash
#
# The deploy jobs' installation, from the repository's secrets — put there by
# ci/forgejo/setup.sh:
#
#   DEPLOY_ENV              the deploy.env (scripts/deploy.env.example)
#   DEPLOY_SSH_KEY          for a server reached over SSH: the pipeline's own
#   DEPLOY_SSH_CONFIG       key, the ssh_config that says how to reach it, and
#   DEPLOY_SSH_KNOWN_HOSTS  its host key — never accepted unseen
#
# Writes them where scripts/ci/release.sh and ssh look, readable only by this
# job's user.

set -euo pipefail
umask 077

if [ -z "${DEPLOY_ENV:-}" ]; then
  echo "The repository has no DEPLOY_ENV secret: ci/forgejo/setup.sh puts it there." >&2
  exit 1
fi
mkdir -p "$HOME/.config/kraftverk"
printf '%s\n' "$DEPLOY_ENV" > "$HOME/.config/kraftverk/deploy.env"

if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  mkdir -p "$HOME/.ssh"
  printf '%s\n' "$DEPLOY_SSH_KEY" > "$HOME/.ssh/deploy_key"
  printf '%s\n' "${DEPLOY_SSH_CONFIG:-}" > "$HOME/.ssh/config"
  printf '%s\n' "${DEPLOY_SSH_KNOWN_HOSTS:-}" > "$HOME/.ssh/known_hosts"
fi
