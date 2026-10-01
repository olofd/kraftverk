# Deploying to the NAS

How kraftverk gets from a commit to the running stack on the owner's
Synology DiskStation (DS220+, DSM 7, Docker 24 / Compose 2.20), and how an
agent does it by hand. The pipeline itself is described in [CI.md](CI.md);
this is the connection to the NAS. Addresses below are placeholders
(`192.0.2.x`); the real ones live in the owner's `~/.ssh/config` and
`deploy.env`, never in the repository.

## The picture

```
 your PC / Mac ──git push forgejo main──▶  Forgejo (on the NAS, :3000)
                                               │ Actions
                                               ▼
                                         runner (on the NAS)
                                               │ the NAS's own Docker socket
                                               ▼
                        checks → build images → smoke test → release.sh
                                               │
                                               ▼
                       project "kraftverk": kraftverk, web, broker
```

Forgejo and its runner are a Compose project of their own
(`kraftverk-forgejo`, files in `/volume1/docker/forgejo` on the NAS, copied
from `ci/forgejo/`). The runner mounts the NAS's Docker socket, so a job's
`docker` commands act on the NAS directly: **no SSH is involved in the
pipeline's deploy**. The deploy settings secret `DEPLOY_ENV` therefore has
`KRAFTVERK_DEPLOY_HOST=` empty, meaning "this machine's Docker". The live
stack is the Compose project `kraftverk`; its data volume and
`KRAFTVERK_SECRET_KEY` must never change (a new key makes stored device
secrets unreadable).

## Reaching the NAS from a development machine

- `ssh diskstation` — host alias in `~/.ssh/config`, user `deploy`, key
  login, no password. `deploy` is in the `docker` group.
- **`docker` is not on the PATH of a non-interactive SSH shell.** Prefix
  commands with `export PATH=$PATH:/usr/local/bin;`.
- `scp` does not work against DSM here; stream files instead:
  `ssh diskstation "cat > /volume1/docker/forgejo/x" < x`.
- Shared folders are under `/volume1/`. Forgejo's files: `/volume1/docker/forgejo`.
- Windows: use the same commands from Git Bash, or from WSL (then the key and
  `~/.ssh/config` must exist inside WSL). Docker on the PC is only needed for
  `npm run ship`, below.

## Setting Forgejo and the runner up on the NAS (once)

`ci/forgejo/setup.sh` targets a machine running Forgejo locally and does not
yet do the NAS; these are the manual steps it replaces.

1. Copy `ci/forgejo/compose.yml` and `runner.yml` to
   `/volume1/docker/forgejo/`, and create `.env` beside them:
   ```
   FORGEJO_ROOT_URL=http://192.0.2.10:3000/
   FORGEJO_BIND=192.0.2.10
   ```
2. `docker compose up -d forgejo` there.
3. Create the one account (pick the password yourself, do not store it):
   `docker compose exec -u git forgejo forgejo admin user create --admin --username kraftverk --email kraftverk@localhost --password '<password>'`
4. Register the runner:
   ```
   secret=$(openssl rand -hex 20)
   docker compose exec -T -u git forgejo forgejo forgejo-cli actions register --name diskstation --secret "$secret"
   docker compose run --rm --no-deps runner forgejo-runner create-runner-file --instance http://192.0.2.10:3000 --secret "$secret" --name diskstation
   docker compose up -d runner
   ```
   The runner log should say `declared successfully`, and it shows online
   under Site administration → Actions → Runners.
5. In the web UI: create the private repository `kraftverk`; add the secret
   `DEPLOY_ENV` (the contents of `deploy.env`, `KRAFTVERK_DEPLOY_HOST=` empty)
   and the variable `KRAFTVERK_DEPLOY=on`.
6. `git remote add forgejo http://192.0.2.10:3000/kraftverk/kraftverk.git`,
   then `git push forgejo main` (use an access token as the password).

## Deploying

- **Normal:** `git push forgejo main`. The workflow
  (`.forgejo/workflows/pipeline.yml`) runs checks, builds, smoke test, then
  `scripts/release.sh`, which replaces `kraftverk` and `web` and leaves the
  broker alone. The broker is recreated only by the manual `Broker` workflow.
- **By hand, without Forgejo:** `npm run ship` (`scripts/ship.sh`) runs the same
  stage scripts on the dev machine and sends the images to the NAS over SSH
  (`KRAFTVERK_DEPLOY_HOST=ssh://deploy@192.0.2.10` in
  `~/.config/kraftverk/deploy.env`). `npm run ship -- broker` recreates the
  broker. Needs Docker on the dev machine.
- A lock stops two deploys at once; a stuck lock is documented in CI.md.

## Things that bite

- The DS220+ has two slow cores: a full run may take 30–60 minutes.
- Ports in use on the NAS: 3000 (Forgejo), 8080/1883 (live stack); the smoke
  test uses 18080, 18090, 11883, 13333.
- Docker Hub rate limits shared IPs; the checks image is tagged by content so
  it rebuilds only when its inputs change.
- Retiring GitLab: once a Forgejo deploy has succeeded, remove the old
  `kraftverk-runner` container and revoke that runner in GitLab.
