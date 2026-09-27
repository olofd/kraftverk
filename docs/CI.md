# Continuous integration

The repository lives in two places, and both check every push the same way.
Only one of them deploys.

| | GitHub (public) | GitLab (private mirror) |
| --- | --- | --- |
| Defined in | `.github/workflows/ci.yml` | `ci/gitlab/validate.yml` |
| Typecheck, tests, the web build | ✅ | ✅ |
| Both images, the stack started and attacked | ✅ | ✅ |
| Images pushed to a registry | — | To the project's private registry, with a build cache so unchanged layers are neither rebuilt nor downloaded again |
| Deploy | never | `main` only, once everything above has passed |

The checks are the same on purpose: something that passes on one and fails on
the other is a bug in CI, not a difference of opinion.

## What the checks are

1. **validate** — `npm ci`, `npm run check:architecture` (the dependency rule
   and the product-identifier ratchet, [ARCHITECTURE.md §7](ARCHITECTURE.md#7-guardrails-in-ci)),
   `npm run typecheck`, `npm test`, and the web app
   exported the way the web container builds it
   (`EXPO_PUBLIC_API_URL=same-origin`).
2. **stack** — both images built from the `Dockerfile`, the three services
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

GitLab's pipeline is defined in a separate private project, which includes
`ci/gitlab/validate.yml` from here and adds the deploy. That keeps where and
how kraftverk is deployed out of this public repository, while the deploy
itself is still code, reviewed and versioned. Anyone running their own server
can do the same: include `ci/gitlab/validate.yml`, and add a deploy job that
runs `docker compose` against their host — see [DOCKER.md](DOCKER.md) for
updating a running stack without dropping the station.
