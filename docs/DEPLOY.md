# Deploying kraftverk

kraftverk runs on one always-on server with Docker ([DOCKER.md](DOCKER.md)).
It is deployed **on that server, by that server**: a Forgejo with a runner
there checks every push to `main`, builds the images, attacks the stack, and
puts the new server and app in place without dropping the station. Nothing
hosted is involved, and nothing about the installation is in this
repository.

| | Where |
| --- | --- |
| The pipeline | `.forgejo/workflows/pipeline.yml`: checks, stack, deploy |
| Recreating the broker, by hand | `.forgejo/workflows/broker.yml` |
| The deploy itself | `scripts/deploy.sh`, which a person can run too |
| The installation's settings | a file on the server (`scripts/deploy.env.example`), given to Forgejo as the secret `DEPLOY_ENV` |

## What a push to main does

The checks and the stack run side by side; the deploy waits for all of them.

1. **the checks**, in parallel jobs, in one image built once
   (`scripts/ci/checks.Dockerfile`): **static** (the architecture check, the
   types, unused code), **unit** (the tests), and **e2e** — the app end to end
   in a browser, in two shards, each with a server of its own ([CI.md](CI.md)).
2. **stack** — both images built from the `Dockerfile`, tagged with the
   commit (`kraftverk-server:<sha>`, `kraftverk-web:<sha>`), started as a
   stack of their own on the server's Docker (project `kraftverk-smoke-<run>`,
   ports from 18080, 18090, 11883 and 13333 up, by run) and attacked by
   `scripts/ci/smoke-docker.sh`, then taken down, volume and all.
3. **deploy** — once both have passed, and while the repository's variable
   `KRAFTVERK_DEPLOY` is `on`: `scripts/deploy.sh` with the images the stack
   job just attacked.

## The deploy

`scripts/deploy.sh` replaces a running kraftverk's server and app:

- **The broker is started if it isn't running, and never recreated.**
  Recreating it drops the station, which may not come back without a
  power-cycle ([BROKER.md](BROKER.md)). The deploy says when the broker runs
  an older build than the images; recreate it then, at a moment when losing
  the station for a minute is fine: **Actions → Broker → Run** in Forgejo, or
  `scripts/deploy.sh broker` on the server.
- **It waits** until both containers are healthy, and proves the app answers
  through the same door a browser uses.
- **Images unused for a week go;** the ones just replaced stay, for a way
  back.

The installation comes from the environment or from the file
`KRAFTVERK_DEPLOY_ENV` names, and nothing about it has a default: a deploy that
guessed would quietly change the running system.

| Setting | |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | The stack's project. Its data volume belongs to it; another name is an empty installation |
| `KRAFTVERK_SECRET_KEY` | Seals plugin secrets and the configuration kept beside the database. **Never changed once set, and kept apart from the server too** — in a password manager: what a lost key sealed cannot be read again |
| `READ_ONLY` | `0` for a real installation ([DOCKER.md](DOCKER.md)) |
| `KRAFTVERK_ALLOWED_HOSTS` | The public name, if any. Empty, never unset |
| `KRAFTVERK_LAN_PORT`, `KRAFTVERK_PUBLIC_PORT`, `KRAFTVERK_MQTT_PORT` | If not the defaults |

### By hand, on the server

```bash
# main as it is in this checkout: the images built here, then deployed
KRAFTVERK_DEPLOY_ENV=/path/to/deploy.env bash scripts/deploy.sh --build

# images already on the server — a way back to the last commit that worked
KRAFTVERK_DEPLOY_ENV=/path/to/deploy.env \
  KRAFTVERK_SERVER_IMAGE=kraftverk-server:<sha> KRAFTVERK_WEB_IMAGE=kraftverk-web:<sha> \
  bash scripts/deploy.sh
```

`--build` builds the commit as committed (`git archive`), never the working
tree's changes. `docker image ls --filter label=se.kraftverk.image` lists the
images there are to go back to.

## Setting up the server

A Linux machine with Docker, always on, on the home network
([DOCKER.md](DOCKER.md)). On it:

1. **Forgejo**, with Actions on, and the repository pushed to it.
2. **A runner** (Forgejo's `forgejo-runner`), registered with the label
   `docker`, using the server's Docker. See below.
3. **The installation:** a copy of `scripts/deploy.env.example`, filled in,
   readable by root alone. A new installation gets a new key:
   `openssl rand -base64 32` — and a copy of it in your password manager.
4. **In the repository's settings:** the secret `DEPLOY_ENV` (the file's
   text) and the variable `KRAFTVERK_DEPLOY` set to `on`.

The first deploy can be the pipeline's, or `scripts/deploy.sh --build` by
hand.

### The runner

The jobs that build, start and ship images mount the server's Docker socket
by name (`/var/run/docker.sock`), and the check jobs npm's download cache,
a volume Docker makes on first use (`kraftverk-npm-cache`, at `/root/.npm`; the end-to-end jobs Metro's too, `kraftverk-metro-cache` at `/tmp/metro-cache`):
each `npm ci` takes from it (`--prefer-offline`) and asks the registry only
for what it lacks. The runner must allow those volumes and no other unasked.
Two settings matter on a server that also runs kraftverk:

- **A network of each job's own, never the server's.** The end-to-end suite
  starts a server of its own that looks for a broker on `127.0.0.1:1883`; on
  the server's own network that is the real broker, with the real station on
  it. On a network of its own it finds none, as intended.
- **The server reachable by name from the jobs:** Forgejo's address, for
  checkout, and `host.docker.internal` for the ports the stack job publishes
  (`--add-host=…:host-gateway`). The stack job resolves that name to an
  address before using it: kraftverk answers only to names it knows, and an
  address on the home network is one.

A runner configuration for this:

```yaml
runner:
  capacity: 4          # the checks' jobs and the stack side by side; each run's stack has ports of its own
  labels:
    - docker:docker://node:24-bookworm
container:
  network: ""          # a network of each job's own
  options: --add-host=<forgejo's host name>:host-gateway --add-host=host.docker.internal:host-gateway
  docker_host: "-"
  valid_volumes:
    - /var/run/docker.sock
    - kraftverk-npm-cache
    - kraftverk-metro-cache
```

A low CPU weight for the jobs (`--cpu-shares=256` in `options`, a quarter of
a container's default) keeps a pipeline from starving the kraftverk it
deploys, and lets a job use every core nothing else wants: a cap
(`--cpus=3`) held an end-to-end job at its limit with the machine idle.
Memory is capped (`--memory=6g`).
