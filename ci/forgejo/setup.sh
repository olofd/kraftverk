#!/usr/bin/env bash
#
# Forgejo and its runner on this machine, with kraftverk's pipeline in it. Run
# once from the repository; safe to run again, to change the deploy settings.
#
#   bash ci/forgejo/setup.sh
#
# Then `git push forgejo main` runs .forgejo/workflows/pipeline.yml, which you
# can watch at http://localhost:3000.
#
# It:
#   - starts ci/forgejo/compose.yml: Forgejo on http://localhost:3000, its data
#     in Docker volumes;
#   - makes one admin account, FORGEJO_USER (default kraftverk), printing its
#     password the first time;
#   - makes a private repository, kraftverk, and adds the `forgejo` remote here;
#   - registers the runner;
#   - gives the repository what the deploy needs, from your deploy.env
#     (KRAFTVERK_DEPLOY_ENV, default ~/.config/kraftverk/deploy.env;
#     scripts/deploy.env.example). For a server reached over SSH, the pipeline
#     gets a key of its own — made here, and authorised on the server with
#     your existing SSH access — not yours.
#
# Without a deploy.env, the pipeline checks and builds but does not deploy:
# its KRAFTVERK_DEPLOY variable is off. Needs git, bash, curl, node, ssh and
# Docker.

set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

user=${FORGEJO_USER:-kraftverk}
url=http://localhost:3000
config=${KRAFTVERK_DEPLOY_ENV:-$HOME/.config/kraftverk/deploy.env}
key=$HOME/.config/kraftverk/forgejo-deploy-key

compose() { docker compose -f "$here/compose.yml" "$@"; }
forgejo() { compose exec -T -u git forgejo forgejo "$@"; }
step() { printf '\n==== %s\n' "$1"; }

step "Forgejo"
compose up -d forgejo
for _ in $(seq 1 60); do
  curl -fsS "$url/api/healthz" > /dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$url/api/healthz" > /dev/null || { echo "Forgejo did not start: docker compose -f ci/forgejo/compose.yml logs forgejo" >&2; exit 1; }

if ! forgejo admin user list | awk 'NR > 1 { print $2 }' | grep -qx "$user"; then
  password=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
  forgejo admin user create --admin --username "$user" --password "$password" \
    --email "$user@localhost" --must-change-password=false > /dev/null
  echo "Your Forgejo account: $user, password $password — shown this once. Change it at $url/user/settings/account."
fi
token=$(forgejo admin user generate-access-token --username "$user" --token-name "setup-$(date +%s)" --scopes all --raw)

api() { curl -fsS -H "Authorization: token $token" -H 'Content-Type: application/json' "$@"; }
# json <key> <file>: {"<key>": <the file's text>}
json() { node -e 'const fs = require("fs"); process.stdout.write(JSON.stringify({ [process.argv[1]]: fs.readFileSync(process.argv[2], "utf8") }))' "$1" "$2"; }
secret() { api -X PUT "$url/api/v1/repos/$user/kraftverk/actions/secrets/$1" -d "$(json data "$2")" > /dev/null; }
variable() {
  body=$(printf '{"value":"%s"}' "$2")
  api -X PUT "$url/api/v1/repos/$user/kraftverk/actions/variables/$1" -d "$body" > /dev/null 2>&1 \
    || api -X POST "$url/api/v1/repos/$user/kraftverk/actions/variables/$1" -d "$body" > /dev/null
}

step "The repository"
api "$url/api/v1/repos/$user/kraftverk" > /dev/null 2>&1 \
  || api -X POST "$url/api/v1/user/repos" -d '{"name":"kraftverk","private":true}' > /dev/null
# The token in the remote's URL: this machine's own Forgejo, on loopback.
remote="http://$user:$token@localhost:3000/$user/kraftverk.git"
if git -C "$repo" remote get-url forgejo > /dev/null 2>&1; then
  git -C "$repo" remote set-url forgejo "$remote"
else
  git -C "$repo" remote add forgejo "$remote"
fi
echo "The remote 'forgejo': $url/$user/kraftverk"

step "The runner"
if ! compose run --rm --no-deps -T runner test -f /data/.runner; then
  runner_secret=$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n')
  forgejo forgejo-cli actions register --name "$(hostname)" --secret "$runner_secret" --labels docker > /dev/null
  compose run --rm --no-deps -T runner forgejo-runner create-runner-file \
    --instance "$url" --secret "$runner_secret" --name "$(hostname)" > /dev/null
fi
compose up -d runner

step "The deploy"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ ! -f "$config" ]; then
  variable KRAFTVERK_DEPLOY off
  echo "No $config: the pipeline checks and builds, and does not deploy."
  echo "Make one from scripts/deploy.env.example and run this again."
else
  secret DEPLOY_ENV "$config"
  deploy_host=$(. "$config" && printf '%s' "${KRAFTVERK_DEPLOY_HOST-}")
  if [ -n "$deploy_host" ]; then
    # ssh://[user@]host[:port] — host perhaps an alias from ~/.ssh/config.
    target=${deploy_host#ssh://}
    name=${target#*@}
    name=${name%%:*}
    destination=${target%:*}
    port_option=()
    case $target in *:*) port_option=(-p "${target##*:}") ;; esac
    # What ssh makes of it here: the real address, user and port.
    resolved=$(ssh -G ${port_option[@]+"${port_option[@]}"} "$destination")
    hostname=$(printf '%s\n' "$resolved" | awk '$1 == "hostname" { print $2 }')
    ssh_user=$(printf '%s\n' "$resolved" | awk '$1 == "user" { print $2 }')
    ssh_port=$(printf '%s\n' "$resolved" | awk '$1 == "port" { print $2 }')

    if [ ! -f "$key" ]; then
      mkdir -p "$(dirname "$key")"
      ssh-keygen -q -t ed25519 -N '' -C "kraftverk pipeline, $(hostname)" -f "$key"
      echo "Authorising the pipeline's key on $name, with your own SSH access:"
      ssh-copy-id -i "$key.pub" ${port_option[@]+"${port_option[@]}"} "$destination"
    fi
    printf 'Host %s\n  HostName %s\n  User %s\n  Port %s\n  IdentityFile ~/.ssh/deploy_key\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n' \
      "$name" "$hostname" "$ssh_user" "$ssh_port" > "$work/ssh_config"
    ssh-keyscan -p "$ssh_port" "$hostname" > "$work/known_hosts" 2> /dev/null
    [ -s "$work/known_hosts" ] || { echo "Could not read $hostname's host key." >&2; exit 1; }
    secret DEPLOY_SSH_KEY "$key"
    secret DEPLOY_SSH_CONFIG "$work/ssh_config"
    secret DEPLOY_SSH_KNOWN_HOSTS "$work/known_hosts"
    echo "Deploys go to $ssh_user@$hostname:$ssh_port over SSH, with the pipeline's key."
  else
    echo "Deploys go to this machine's Docker."
  fi
  variable KRAFTVERK_DEPLOY on
fi

step "Ready"
echo "git push forgejo main   — and watch it at $url/$user/kraftverk/actions"
