# Continuous integration

Every push to `main` is checked by the pipeline on Forgejo, on the server
kraftverk runs on, and — once everything has passed — deployed there.
[DEPLOY.md](DEPLOY.md) has the deploy and the server's setup; this is what the
checks are.

| | Defined in |
| --- | --- |
| The pipeline: checks, stack, deploy | `.forgejo/workflows/pipeline.yml` |
| Recreating the broker, by hand | `.forgejo/workflows/broker.yml` |

## What the checks are

1. **the checks** — in parallel jobs, in one image built once from
   `scripts/ci/checks.Dockerfile` (the Playwright the lockfile pins, its
   browser and libraries, and the tools native modules build with):
   - `npm ci`;
   - `npm run check:architecture`: the dependency rule and the
     product-identifier ratchet ([ARCHITECTURE.md §7](ARCHITECTURE.md#7-guardrails-in-ci));
   - `npm run typecheck` and `npm test`;
   - `npm run knip`: nothing exported, depended on or written that nothing uses;
   - `npm run test:e2e`: Playwright, in Chromium, drives the web build against
     a read-only server of its own, every device simulated
     ([DEVELOPING.md](DEVELOPING.md#end-to-end-in-a-browser)) — in two
     shards, each a job with a server of its own — and its own share of the
     machine: run side by side in one job (`--shards=2`, quick on a
     developer's machine), they starve each other there. On a failure the
     report, the screenshots and the traces are kept for a week.
2. **stack** — both images built from the `Dockerfile`, the three services
   started from `docker-compose.yml`, and `scripts/ci/smoke-docker.sh` run
   against them. It uses the stack the way someone at home would, and attacks
   it the way someone on the internet would:
   - creating the first account from the internet, directly and by forging
     the entrance stamp;
   - both tripwires: a request that came through a proxy, and one addressed
     by a public name;
   - DNS rebinding, forged writes without the client header, session cookie
     flags;
   - a client on the station port trying to command a station through the
     broker;
   - the server reaching the broker, and both keeping their logs on the
     volume.

   The images it attacks are the ones the deploy then ships.

## Run the same locally

```bash
npm run check:architecture && npm run typecheck && npm test && npm run knip
npm run test:e2e
bash scripts/ci/smoke-docker.sh     # needs Docker
```

`scripts/ci/smoke.sh` alone runs the HTTP checks against any fresh stack —
`LAN_URL` and `PUBLIC_URL` say where.
