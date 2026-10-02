# @kraftverk/api-contract — the API's shapes, once

## What it is

The kraftverk API as types: what every route takes and answers, what the
live stream carries both ways, and the views of a device, an automation
and a run. Types only — nothing in it runs.

## What it does — and does not

- **Does:** declare each shape once, for the server that sends it and the
  app that reads it; re-export the contract's and the language's types the
  API speaks in. It will hold `KraftverkApi`, the one interface a home is
  reached through, whether in the process or over HTTP
  (docs/PLAN-SHARED-CORE.md, phase 5).
- **Does not:** implement anything — not the routes (the server's), not the
  calls (`@kraftverk/api-client`'s). The architecture check refuses a shape
  declared again beside it.

## Where it fits

Between the rules and the runtime (docs/PLAN-SHARED-CORE.md): it names the
types of what is under it — a gateway's answer, a rule — and the runtime,
the hub, the server and the app speak in its shapes.

## Why a package of its own

Because a shape declared on both sides drifts: a field added on one side
only fails at runtime, on a phone. Declared once and imported by both, it
fails to compile instead.
