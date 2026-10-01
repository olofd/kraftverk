# Continuous integration

Every push is checked on GitHub. Deploying is a separate step that runs from
your own machine: `npm run ship` runs the same checks on the commit, builds
the images, attacks them, and only then puts them on the server. No hosted
service is involved in a deploy.

| | GitHub Actions (every push) | `npm run ship` (a deploy) |
| --- | --- | --- |
| Defined in | `.github/workflows/ci.yml` | `scripts/ship.sh`, one script per stage |
| Runs on | GitHub's runners | your machine — macOS, Linux, or Windows through WSL — in containers |
| Typecheck, tests, the web build | ✅ | ✅ `scripts/ci/check.sh` |
| The app end to end, in a browser | ✅ | ✅ `scripts/ci/check.sh` |
| Both images, the stack started and attacked | ✅ | ✅ `scripts/ci/images.sh`, `scripts/ci/smoke-docker.sh` |
| Images to the server | — | copied over SSH, only once they have passed |
| Deploy | never | `main` only: the server and the app; the broker on request |

The checks are the same on purpose: something that passes on one and fails on
the other is a bug in CI, not a difference of opinion.

## What the checks are

1. **validate** — `npm ci`, `npm run check:architecture` (the dependency rule
   and the product-identifier ratchet, [ARCHITECTURE.md §7](ARCHITECTURE.md#7-guardrails-in-ci)),
   `npm run typecheck`, `npm test`, and the web app
   exported the way the web container builds it
   (`EXPO_PUBLIC_API_URL=same-origin`).
2. **e2e** — `npm run test:e2e`: Playwright, in Chromium, drives the web
   build against a read-only server of its own, every device simulated
   ([DEVELOPING.md](DEVELOPING.md#end-to-end-in-a-browser)). On a failure the
   report, the screenshots and the traces are kept.
3. **stack** — both images built from the `Dockerfile`, the three services
   started from `docker-compose.yml`, and `scripts/ci/smoke-docker.sh` run
   against them. It uses the stack the way someone at home would, and attacks it
   the way someone on the internet would:
   - creating the first account from the internet, directly and by forging the
     entrance stamp;
   - both tripwires: a request that came through a proxy, and one addressed by
     a public name;
   - DNS rebinding, forged writes without the client header, session cookie
     flags;
   - a client on the station port trying to command a station through the
     broker;
   - the server reaching the broker, and both keeping their logs on the volume.

Run the same locally, with Docker:

```bash
bash scripts/ci/smoke-docker.sh
```

`scripts/ci/smoke.sh` alone runs the HTTP checks against any fresh stack —
`LAN_URL` and `PUBLIC_URL` say where.

## The deploy

```bash
npm run ship              # main's last commit: the server and the app
npm run ship -- broker    # the same, then the broker recreated
```

On your machine you need git, bash and Docker. That means Docker Desktop on a
Mac, or Docker Desktop with WSL integration on Windows, with the command run
from WSL.

`scripts/ship.sh` takes `main`'s last commit as committed, not the working
tree, and:

1. **runs the checks** (`scripts/ci/check.sh`) in a container built from
   `ci/Dockerfile`, which has Node, Chromium and the Docker CLI. The checks are
   therefore the same on a Mac as on a PC, and leave your own `node_modules`
   alone;
2. **builds both images** for linux/amd64 (`scripts/ci/images.sh`), tagged
   with the commit. An Apple Silicon Mac builds them emulated, which is slower
   but gives the same images;
3. **attacks the stack** (`scripts/ci/smoke-docker.sh`) on your machine's
   Docker, from the checks container;
4. **copies the images to the server** over SSH (`docker save | docker load`);
5. **deploys** (`scripts/deploy.sh`) against the server's Docker over SSH.
   The broker is started if it is not running and is otherwise left alone, so
   the station stays connected. The server and the app are replaced, the
   script checks that the app answers, and it says whether the broker is
   behind. `-- broker` then recreates the broker
   ([DOCKER.md](DOCKER.md#operating-it)).

Images reach the server only after passing. A commit whose images are already
there has therefore passed, so running `ship` again (after a failed deploy, or
for the broker) goes straight to step 5. A lock on the server, the container
`kraftverk-deploying`, keeps two machines from deploying at once.

### What it needs: `deploy.env`

Where the server is, and how the installation is set up, are kept out of this
repository. They live in a file on each machine you ship from, at
`~/.config/kraftverk/deploy.env` (or wherever `KRAFTVERK_DEPLOY_ENV` points).
Start from [`scripts/deploy.env.example`](../scripts/deploy.env.example):

| Variable | Meaning |
| --- | --- |
| `KRAFTVERK_DEPLOY_HOST` | The server's Docker: `ssh://<user>@<host>`, or `ssh://<alias>` for a `Host` in `~/.ssh/config`. Empty: this machine's Docker |
| `COMPOSE_PROJECT_NAME` | The stack's project. Its volume holds every device, account and reading; another name starts an empty installation |
| `READ_ONLY`, `KRAFTVERK_ALLOWED_HOSTS`, ports | As in [DOCKER.md](DOCKER.md#environment) |
| `KRAFTVERK_SECRET_KEY` | Seals plugin secrets. The one the running server has, never a new one |

`deploy.sh` refuses to run when any of these is missing, rather than fall back
to a default that would change the running system.

### SSH

The deploy reaches the server as an ordinary SSH user, with your own key.
`docker` and `docker compose` run on your machine and talk to the server's
Docker through SSH (`DOCKER_HOST=ssh://…`). Nothing is installed on the server
for this, and no key is stored anywhere but `~/.ssh` on your machine.

That user must be able to run `docker` without `sudo`, with a key and no
password prompt. On a Synology, that means a user in the `docker` group, with
SSH enabled in DSM. Being in that group amounts to root on the server, so give
it to a user that only you can log in as, and use one key per machine
(`ssh-copy-id`) rather than copying a key between machines. Check it from
each machine with:

```bash
ssh <host> docker version
```

### Later: a CI server

Each stage is a script, so a CI server can run the same pipeline on every
push, on the NAS or on another machine. Forgejo or Gitea with their Actions
runners can run `.github/workflows/ci.yml` largely as it is, and Woodpecker can
run the same scripts. A job would:

- run `scripts/ci/check.sh` in the `ci/Dockerfile` image;
- run `scripts/ci/images.sh` and `scripts/ci/smoke-docker.sh` with the host's
  Docker;
- run `scripts/ship.sh` with `KRAFTVERK_DEPLOY_HOST` empty when the runner is
  on the server itself, or `ssh://…` when it is not.

`ship.sh` insists on a checked-out `main`. A runner's checkout is usually a
detached commit, so the job checks out `main` by name first.
