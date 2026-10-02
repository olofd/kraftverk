# Plan: one core that runs anywhere — the server's logic into packages

Written 2026-10-02, at the owner's request, after a review of what the
server holds that is not the server's. It records the decision, what moves
where, what stands in the way, and the order to do it in. Each phase keeps
`npm run typecheck`, `npm test` and `npm run check:architecture` green on
every commit, and the e2e suite at the end of each phase.

## The decision (the owner, 2026-10-02)

**Whatever can run in the app is a package the app can load.** kraftverk's
logic — devices and their sessions, the gateway, automations and their
language, the configuration document, history, attention — is the
framework, not the server. It lives in packages that run in the server, in
a browser and on a phone alike. The server is what only an always-running
machine on the network can be: an HTTP API, accounts, the broker, a disk to
keep files on, the packages found on that disk.

What it is for, later: the app on its own — on an Android phone, an iPhone
or in a browser — connects to a device, keeps its own devices, history and
automations in its own SQLite database, and runs those automations itself.
The server stays the always-running holder; the app becomes a full one, not
a remote control with Bluetooth.

This is a first-class rule (ARCHITECTURE.md §9, decision 22; AGENTS.md). It
replaces what decision 15 said of local mode: that it cannot have history or
automations. It can — while the app runs.

## Where things stand

Already shared, and pure: `device-sdk` (contracts, and today the rule
language), `gateway`, `holder`, `api-contract`, `config`. The architecture
check holds them to no platform built-in (`SHARED_CORE` in
`scripts/architecture.mjs`).

The server holds about 12 000 lines, tests aside. Most of its business
logic depends on little that is the server's:

| Server today | What ties it to the server | Goes to |
|---|---|---|
| `automations/engine.ts`, `rehearse.ts`, `runlog.ts`, `library.ts` | only its store, and the `serverDevices` adapter | `@kraftverk/automation-engine` |
| `automations/plans.ts` | `hono/http-exception` for its errors | the engine, with errors of its own; the routes map them |
| `automations/store.ts` | `db()` (bun:sqlite), `node:crypto` for ids | `@kraftverk/store` |
| `device-sdk/src/automation.ts`, `recipes.ts`; `config/src/expr.ts`, `rules.ts` | nothing | `@kraftverk/automation` — the language |
| `devices/catalog`, `connections`, `links`, `events`, `clients`, `store`, `ledger`, `remote`; `history/policy`, `changes`, `transport-store`, `schema` | `db()`, `node:crypto` for ids | `@kraftverk/store` |
| `devices/sessions.ts` and the app's `client/src/runtime/sessions.ts` | two copies of one job | `@kraftverk/holder`: one session manager |
| `devices/registry.ts`, `setup/*`, `nearby.ts`, `history/sampler.ts`, `attention/*`, `assistant/world.ts` | the stores and the session manager | `@kraftverk/hub` |
| `config/export.ts`, `import.ts`, `restore.ts` | the stores; `node:crypto` | `@kraftverk/hub` |
| `config/seal.ts` | `node:crypto` scrypt | `@kraftverk/config`, on Web Crypto (decision below) |
| `runtime/protocols.ts`, `transports.ts` (the host) | handed what `packages.ts` finds | `@kraftverk/hub`, handed what is installed |
| `history/db.ts` | bun:sqlite, `node:fs`, the secret key from the environment | split: opening and setting aside a schema shared; the bun:sqlite file and the key the server's |
| `runtime/packages.ts` (discovery on disk), `config/snapshot.ts` (the file), `auth/*`, `admin/*`, `routes/*`, `app.ts`, `index.ts`, `log.ts`, `config.ts` | the disk, HTTP, accounts, the process | stay: the server |

And the app keeps a second, smaller model of its own for local mode —
`client/src/runtime/local.ts`, devices, connections and links in app
preferences — which the shared store replaces.

## The packages, at the end

Shared — no Node or Bun built-in, no platform API; they typecheck without
Node's or Bun's types and bundle for a browser:

```
device-sdk          contracts: values, meanings, capabilities, descriptions, DeviceType,
                    Transport, Protocol, DeviceSession. Loses the rule language.
automation          the language: Rule, triggers, steps, expressions; checking, describing,
                    evaluating; the text form (the DSL); the standard recipes. Its README is
                    the language's reference. Device packages import it to declare recipes
                    and functions, as they import the SDK.
config              the home as a document (devices, links, home, automations): YAML,
                    the JSON Schema, migrations, passphrase sealing. Speaks the language
                    through `automation`; knows no engine.
gateway             every physical action: rules, confirmation, verification, its memory
holder              a device held: open, watch, fail over, judge — and the one session
                    manager both sides run
store               the data model in SQLite, one schema, every store, over a small
                    SQL port (below); ids from Web Crypto
automation-engine   runs automations: triggers, steps, runs and their logs, rehearsal,
                    plans; reads devices through the hub's ports
hub                 a whole kraftverk: `createHub({ installed, database, secrets, ... })`
                    wires the stores, sessions, gateway, engine, sampler, attention,
                    setup and the configuration's import and export
api-contract        the HTTP API's shapes
```

Server only — `server/`: the HTTP API (hono), accounts and sessions,
admin, logs, finding packages on disk, the snapshot file, the bun:sqlite
adapter and the secret key from the environment, the process. Its
`index.ts` becomes `createHub(...)` plus the API.

The app: `createHub(...)` in local mode, on expo-sqlite on a phone; in
server mode, as today, a holder of the connections it has plus the API.

## The ports — what the hub asks of where it runs

Each a small interface in the shared packages, one implementation per
place. Nothing else differs between the server and the app.

- **`SqlDatabase`** — `exec`, `all`, `get`, `run`, `transaction`;
  synchronous, as bun:sqlite and expo-sqlite's sync API are. The schema,
  its fingerprint and the set-aside rule (strict v1) are shared; opening a
  file is the place's.
- **`Installed`** — the device types, protocols and transports there are:
  found on disk by the server, the generated registry in the app.
- **`SecretsAtRest`** — sealing a connection's secrets in the database: the
  server's key from its environment; the phone's secure storage (the app's
  vault, `client/src/runtime/vault.ts`).
- **Random ids** — `crypto.getRandomValues`, which Bun and browsers have and
  a phone gets from a polyfill.
- **Files** — only the server writes the snapshot; the hub hands it the
  document.

## Decisions for the owner

1. **The language and the engine are two packages** (recommended), not one.
   A device package declares recipes and functions in the language; it must
   not pull in the engine. The configuration stays its own package too: it is
   the whole home as a document, of which automations are one part.
2. **The SQL port is synchronous** (recommended). The stores and the engine
   stay as they are; bun:sqlite and expo-sqlite fit it. A browser's
   persistent SQLite is asynchronous (wa-sqlite on OPFS): the browser gets
   sql.js in memory, saved to OPFS — or the port becomes asynchronous
   everywhere, which touches every store and the engine. Decide when the
   browser's turn comes; nothing before needs it.
3. **Passphrase sealing moves to Web Crypto** (PBKDF2 and AES-GCM), so the
   app can open a sealed export. A new `sealed:v2:`; `v1` (scrypt) stays
   readable on the server — the document is versioned on purpose — unless
   no sealed export exists to keep.
4. **An automation held by the app runs while the app runs.** In a browser,
   while the tab is open; on a phone, in the foreground, and in the background
   only as the platform allows (a foreground service on Android). Said where
   an automation is held, as a connection's holder is.

## The order

Each phase green and pushed; the server's behaviour unchanged until phase 5.

0. **The rule, written and enforced.**
   - This plan; ARCHITECTURE.md §3 and §9 (decision 22, and 15 amended);
     AGENTS.md.
   - Each shared package typechecks without Node's or Bun's types, and one
     CI step bundles them for a browser: a built-in, `process` or `Buffer`
     fails the build where it is written.
   - `server/src` gets an allowlist of its folders (routes, auth, admin,
     storage, discovery, log): a new folder there fails the check until
     someone has asked whether it could run in the app.
1. **The language: `@kraftverk/automation`.** Out of `device-sdk`
   (`automation.ts`, `recipes.ts`) and `config` (`expr.ts`, `rules.ts`).
   Every import changes at once (strict v1). Its README becomes the
   reference (docs/AUTOMATIONS.md and CONFIG.md point to it).
2. **The store: `@kraftverk/store`.** The SQL port; the schema and its
   set-aside; every store moved, given the database rather than calling
   `db()`; ids from Web Crypto. The server's bun:sqlite adapter stays in
   `server/`. Store tests run against both bun:sqlite and sql.js, so the
   port is proven where the app will use it.
3. **The engine: `@kraftverk/automation-engine`.** The engine, plans (with
   errors of its own), rehearsal, run logs, the library. `serverDevices`
   becomes the hub's adapter.
4. **The hub: `@kraftverk/hub`, and one session manager.**
   - The server's and the app's session managers become one, in `holder`.
   - Registry, setup, nearby, sampler and changes, attention, the
     assistant's world, and the configuration's import and export move into
     `hub`; `createHub(...)` wires them.
   - The server's `index.ts` becomes the hub plus the API.
5. **The app on the hub.**
   - Local mode runs `createHub` on expo-sqlite (a phone) and sql.js (the
     web build). `local.ts` and its preferences go; a local install starts
     afresh (strict v1).
   - Automations and history in local mode; the editor and the run log
     against the local hub.
   - An e2e test: the app with no server adds a simulated plug, makes an
     automation, and runs it.
6. **The docs.** ARCHITECTURE.md §3, §4.7 and §6; DATA-MODEL.md; HANDOFF.md.

## Verification

- Every phase: typecheck, tests, the architecture check, the e2e suite.
- From phase 0: the shared packages typecheck without Node's or Bun's types,
  and bundle for a browser.
- Phase 2: every store's tests pass on bun:sqlite and on sql.js.
- Phase 4: the server on the NAS runs as before — the owner's devices,
  automations and the charging chain — with `createHub` underneath.
- Phase 5: the app with no server runs an automation against a simulated
  plug (e2e), and on a phone against a real one over Bluetooth.
