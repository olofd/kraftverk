# Continuous integration

Every push is checked on GitHub. Deploying is done by kraftverk's own
pipeline, on **Forgejo**, which runs wherever you run it: on your Mac or PC
now, and on the NAS or another server later. It runs the same checks on every
push to `main`, builds the images and attacks them, and only then puts them
on the server. No hosted service is involved in a deploy.

| | GitHub Actions (every push) | Forgejo (every push to `main`) |
| --- | --- | --- |
| Defined in | `.github/workflows/ci.yml` | `.forgejo/workflows/pipeline.yml`, `broker.yml` |
| Runs on | GitHub's runners | Forgejo's runner, on a machine of yours (`ci/forgejo/`) |
| Typecheck, tests, the web build | ✅ | ✅ `scripts/ci/check.sh` |
| The app end to end, in a browser | ✅ | ✅ `scripts/ci/check.sh` |
| Both images, the stack started and attacked | ✅ | ✅ `scripts/ci/images.sh`, `scripts/ci/smoke-docker.sh` |
| Images to the server | — | copied over SSH, only once they have passed |
| Deploy | never | `scripts/ci/release.sh`: the server and the app; the broker by hand |

The checks are the same on purpose: something that passes on one and fails on
the other is a bug in CI, not a difference of opinion. Each stage is a script,
so the pipeline is the same on any CI that can run them. When no Forgejo is
running, `npm run ship` runs them in order from your machine.

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


## The pipeline, on Forgejo

`.forgejo/workflows/pipeline.yml` runs on every push to `main`. Forgejo runs
it instead of `.github/workflows/`; GitHub ignores it:

1. **checks-image** builds the image the checks run in (`ci/Dockerfile`:
   Node, Chromium, the Docker CLI) with `scripts/ci/checks-image.sh`, only
   when `ci/Dockerfile` or the lockfile's Playwright has changed;
2. **checks** runs `scripts/ci/check.sh` in it: architecture, types, tests,
   the web build, and the app end to end in a browser. On a failure the report
   is kept;
3. **stack** builds both images for linux/amd64 (`scripts/ci/images.sh`),
   tagged with the commit, and attacks them (`scripts/ci/smoke-docker.sh`);
4. **deploy**, once both have passed and while the repository's
   `KRAFTVERK_DEPLOY` variable is `on`, runs `scripts/ci/release.sh`. It copies
   those images to the server if the server is another machine, then runs
   `scripts/deploy.sh` against the server's Docker. The broker is started if
   it is not running and is otherwise left alone, so the station stays
   connected. The server and the app are replaced, the script checks that the
   app answers, and it says whether the broker is behind.

`.forgejo/workflows/broker.yml` recreates the broker. Run it from the
repository's **Actions** tab when the deploy said the broker is behind, at a
moment when losing the station for about a minute is fine
([DOCKER.md](DOCKER.md#operating-it)).

A lock on the server, the container `kraftverk-deploying`, keeps two deploys
from running at once, whatever started them.

### Forgejo on your machine

[`ci/forgejo/compose.yml`](../ci/forgejo/compose.yml) is Forgejo and one
runner. The runner starts each job in a container on your machine's Docker,
and the jobs that build and start images use that same Docker.
You need Docker (Docker Desktop on a Mac; Docker Desktop with WSL integration
on Windows, working from WSL), plus git, curl, node and ssh. Set it up once,
from the repository:

```bash
bash ci/forgejo/setup.sh
```

It starts Forgejo on <http://localhost:3000> and creates one admin account,
printing its password once. It creates a private `kraftverk` repository, adds
a `forgejo` remote here, registers the runner, and gives the repository what
the deploy needs (below). After that:

```bash
git push forgejo main      # runs the pipeline; watch it at localhost:3000
```

To push to GitHub and Forgejo at once:
`git remote set-url --add --push origin <its GitHub URL>`, then
`git remote set-url --add --push origin "$(git remote get-url forgejo)"`.

Forgejo's data (repository, runs, secrets) lives in Docker volumes, and
`docker compose -f ci/forgejo/compose.yml down` stops it without losing
any of it. Forgejo can run on each machine you code on, or on one of them.

### What the deploy needs: `deploy.env`

Where the server is, and how the installation is set up, are kept out of this
repository. They live in a file on the machine that runs `setup.sh`, at
`~/.config/kraftverk/deploy.env` (or wherever `KRAFTVERK_DEPLOY_ENV`
points). Start from
[`scripts/deploy.env.example`](../scripts/deploy.env.example):

| Variable | Meaning |
| --- | --- |
| `KRAFTVERK_DEPLOY_HOST` | The server's Docker: `ssh://<user>@<host>`, or `ssh://<alias>` for a `Host` in `~/.ssh/config`. Empty: the Docker of the machine the pipeline runs on |
| `COMPOSE_PROJECT_NAME` | The stack's project. Its volume holds every device, account and reading; another name starts an empty installation |
| `READ_ONLY`, `KRAFTVERK_ALLOWED_HOSTS`, ports | As in [DOCKER.md](DOCKER.md#environment) |
| `KRAFTVERK_SECRET_KEY` | Seals plugin secrets. The one the running server has, never a new one |

`setup.sh` stores the file as the repository's `DEPLOY_ENV` secret and turns
`KRAFTVERK_DEPLOY` on. Without the file, the pipeline checks and builds but
does not deploy. Run `setup.sh` again after changing the file.
`deploy.sh` refuses to run when any of these settings is missing, rather than
fall back to a default that would change the running system.

### SSH

When `KRAFTVERK_DEPLOY_HOST` is `ssh://…`, the deploy reaches the server as an
ordinary SSH user: `docker` and `docker compose` in the job talk to the
server's Docker through SSH. Nothing is installed on the server for this.

That user must be able to run `docker` without `sudo`. On a Synology, that
means a user in the `docker` group, with SSH enabled in DSM. Being in that
group amounts to root on the server, so give it to a user only you can log in
as. Check from your machine that `ssh <host> docker version` works without a
password.

The pipeline doesn't use your key. `setup.sh` makes it a key of its own,
`~/.config/kraftverk/forgejo-deploy-key`, and authorises it on the server
with `ssh-copy-id` over your existing access. It stores that key, the
resolved address, and the server's host key as the repository's
`DEPLOY_SSH_*` secrets; `ci/forgejo/installation.sh` writes them out for the
deploy job. The host key is read once, at setup, and never accepted unseen
afterwards. To revoke the pipeline's access, remove its line from the
server's `~/.ssh/authorized_keys`.

### Moving it to a server

The same `compose.yml` runs on the NAS or another server: on a Synology, as a
Container Manager project. There:

- set `FORGEJO_ROOT_URL` to the address it is reached by, and `FORGEJO_BIND`
  to the address to listen on, for example the LAN address;
- leave `KRAFTVERK_DEPLOY_HOST` empty in its `deploy.env` if kraftverk runs
  on that same machine. The deploy then uses that machine's Docker, and no SSH
  key is involved.

The runner then builds and tests on the server itself. That is slower on a
small NAS, but the runner takes one job at a time.

## Without Forgejo: `npm run ship`

```bash
npm run ship              # main's last commit: the server and the app
npm run ship -- broker    # the same, then the broker recreated
```

`scripts/ship.sh` runs the pipeline's stages in order from your machine, with
your own SSH setup, using the same `deploy.env`. It runs on `main`'s last
commit as committed, not on the working tree, with the checks and the smoke
test inside the checks image. A commit whose images are already on the
server has passed, so `ship` goes straight to the deploy.
