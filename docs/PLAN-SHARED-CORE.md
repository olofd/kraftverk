# Plan: one core that runs anywhere — the logic of the server and the app into packages

Written 2026-10-02, at the owner's request, after a review of the server and
the app for logic that is neither's own. It records the decision, the
principles that follow from it, what moves where, what stands in the way,
the guardrails that keep it so, and the order. Every commit keeps
`npm run typecheck`, `npm test` and `npm run check:architecture` green; the
e2e suite runs at the end of each phase.

## The decision (the owner, 2026-10-02)

**Whatever can run in the app is a package the app can load.** kraftverk's
logic — devices and their sessions, the gateway, automations and their
language, the configuration document, history, attention — is the
framework, not the server's and not the app's. It lives in packages that
run in the server, in a browser and on a phone alike.

- **The server** keeps only what an always-running machine on the network
  must be: an HTTP API, accounts, the MQTT broker, a disk to keep files on,
  the packages found on that disk.
- **The app** keeps only what is a screen, and what is the platform's: its
  storage, its secure storage, its radios.

What it is for, later: the app on its own — on an Android phone, an iPhone,
in a browser — connects to a device, keeps its devices, history and
automations in its own SQLite database, and runs those automations itself.
The server stays the always-running holder; the app becomes a full one.

ARCHITECTURE.md §9 records it as decision 22; AGENTS.md as a rule that never
relaxes. It replaces what decision 15 said of local mode: that it cannot
have history or automations. It can, while the app runs.

## Principles

1. **Shared unless it needs the machine.** Code goes in a shared package
   unless it needs HTTP serving, accounts, the broker, the disk or a
   platform API. "It is only used by the server today" is not a reason.
2. **No state at module level in shared code.** Every store, registry and
   engine is an object made from what it is given — never a global `db()`,
   `audit()` or `appState()`. Two hubs then run in one process (a test, an
   app holding two homes) and nothing reaches past what it was handed.
3. **Ports belong to the package that needs them.** A package says what it
   needs as a small interface (the engine: where its automations and runs
   are kept; the session manager: where its devices are). `store`
   implements them all in SQLite; the place it runs implements the rest.
   A package never reaches for the platform. The gateway already works so:
   it declares its memory (`GatewayLedger`), and the server's
   `devices/ledger.ts` keeps it in the database.
4. **One interface, two transports.** Everything the app does with a home
   is one typed interface, `KraftverkApi`, in `api-contract`. The hub
   implements it in the process; `api-client` implements it over HTTP and
   the WebSocket; the server's routes are an adapter from HTTP to the hub's.
   The app asks the same interface whether its home is on a server or on the
   phone, and never branches on which. Accounts, sign-in and the admin's
   reset are the server's, and not in it.
5. **Dependencies point down the layers** (below), and the architecture
   check says so.

## The layers, at the end

```
edges        server/         HTTP (hono) adapter, accounts, admin, logs, the broker,
             (Bun only)      finding packages on disk, the snapshot file, bun:sqlite,
                             the secret key from the environment
             client/         screens, React bindings, and the platform's ports:
             (the app)       expo-sqlite on a phone, SQLite's WebAssembly build in a
                             browser's worker; secure storage, preferences, radios
             api-client      KraftverkApi over HTTP and the WebSocket; pure — handed
                             the server's address, so a CLI or a test can use it too
             ui              the React kit
──────────────────────────────────────────────────────────────────────────────────────
the hub      hub             createHub({ installed, database, secrets, ... }): wires the
                             rest, and implements KraftverkApi in the process: views,
                             setup, history, attention, the configuration's import and
                             export, and the uplink of an app that holds connections
                             for a server
             store           the data model in SQLite: one schema and its set-aside,
                             every store — implementing the ports the packages
                             below declare
──────────────────────────────────────────────────────────────────────────────────────
runtime      automation-engine  runs automations: triggers, steps, runs, run logs,
                             rehearsal, plans; declares where its records are kept
             holder          a device held: open, watch, fail over, judge — and the one
                             session manager; declares where its devices are kept
──────────────────────────────────────────────────────────────────────────────────────
the API      api-contract    the API's shapes and KraftverkApi — types only; it names the
                             types of what is under it (a gateway's answer, a rule), and
                             the runtime above speaks in its shapes
             message-port    KraftverkApi and a Transport over a message port: served on
                             one side, the same interface on the other
──────────────────────────────────────────────────────────────────────────────────────
rules        automation      the language: rules, triggers, steps, expressions; checking,
                             describing, evaluating, editing; the text form; the standard
                             recipes. Its README is the language's reference
             home-file       a home, in one file: YAML, its JSON Schema, migrations,
                             passphrase sealing; speaks the language through automation
             gateway         every physical action: rules, confirmation, verification
──────────────────────────────────────────────────────────────────────────────────────
contracts    device-sdk      values, meanings, capabilities, descriptions and what follows
                             from them alone; DeviceType, Transport, Protocol, DeviceSession
```

Which package may import which is a table in `scripts/architecture.mjs`
(`MAY_IMPORT`), checked on every commit; this picture is that table.

Device types, protocols and transports stay as they are. A device type may
import `device-sdk` and `automation` (to declare recipes and functions), and
its protocols. A transport keeps one entry per place it runs.

Everything above the edges is shared: no Node or Bun built-in, no
`process`, no `Buffer`, no platform API. It typechecks without Node's or
Bun's types and bundles for a browser.

## What moves — the server

About 12 000 lines, tests aside. Most of it depends on little that is the
server's:

| Today | What ties it to the server | Goes to |
|---|---|---|
| `automations/engine.ts`, `rehearse.ts`, `runlog.ts`, `library.ts` | its store only; `serverDevices` | `automation-engine`; the adapter to `hub` |
| `automations/plans.ts` | `hono/http-exception` for errors; the catalog, the session manager, the database | `hub`, with errors of its own; the routes map them to HTTP |
| `automations/store.ts` | `db()`, `node:crypto` | `store`, implementing the engine's port |
| `devices/catalog`, `connections`, `links`, `events`, `clients`, `store`, `ledger`, `remote`; `history/schema`, `changes`, `policy`, `transport-store` | `db()`, `node:crypto` | `store` |
| `audit()`, `onAudit()`, `appState()`, `startedFresh()` in `history/db.ts` | module-level state over `db()` | `store`, as objects |
| `history/db.ts` opening a file | bun:sqlite, `node:fs`, the key from the environment | the server's port implementations; the schema's fingerprint and set-aside to `store` |
| `devices/sessions.ts` | `db()` | `holder`: the one session manager |
| `devices/registry.ts`, `setup/*`, `nearby.ts`, `types.ts`; `history/sampler.ts`; `attention/*`; `assistant/world.ts` | the stores, the sessions | `hub` |
| `runtime/protocols.ts`, `transports.ts` | handed what `packages.ts` finds | `hub`, handed `installed` |
| `config/export.ts`, `import.ts`, `restore.ts` | the stores; `node:crypto` | `hub` |
| `config/seal.ts` | scrypt from `node:crypto` | `home-file`, on Web Crypto (decision 3) |
| `routes/live.ts`'s outbox (coalescing what goes out) | nothing | `hub`: the live updates a client is sent, in the process or over the socket |
| `runtime/packages.ts`, `config/snapshot.ts`'s file, `auth/*`, `admin/*`, `routes/*`, `app.ts`, `index.ts`, `log.ts`, `config.ts` | the disk, HTTP, accounts, the process | stay |

`index.ts` becomes `createHub(...)` and the HTTP adapter. The routes become
thin: validate, authorise, call the hub, answer.

## What moves — the app

About 14 500 lines, tests aside. Most is screens, which stay. What is not:

| Today | What it is | Goes to |
|---|---|---|
| `runtime/local.ts` | a second, smaller model of devices, connections and links, in preferences | gone: `store` |
| `runtime/sessions.ts` | a second session manager | gone: `holder`'s |
| `runtime/registry.ts` | what is installed, and starting transports | `hub` (`installed`); the generated registry stays the app's |
| `runtime/runtime.ts` | wiring the app's holder | gone: `createHub` |
| `runtime/uplink.ts` | sending a held connection's readings and audit to the server, queued | `hub`, queued in its own store |
| `runtime/vault.ts`, `lib/preferences.ts` | secure storage, preferences | `client/src/platform/`: port implementations |
| `state/DevicesProvider.tsx`: `describeLocal` and the local branch of every mutation | the server's device view and API again, for local mode | gone: `KraftverkApi` from the hub |
| `features/add/flows.ts`: `AppFlow` | setup run in the app — the server's setup again | gone: `hub`'s setup, through `KraftverkApi` |
| `features/automations/editor/draft.ts`: `listAt`, `withList`, `withStep` | edits to a rule, as data | `automation` (the draft's name and role fills stay the editor's) |
| `features/automations/runlog/series.ts` | a run log made into series and marks | `automation-engine`, beside the run log's CSV |
| `features/devices/model.ts`: `togglesOf`, `settingsForms` | what follows from a description alone | `device-sdk` |
| `features/config/entries.ts`: `deviceYaml` | a device as a configuration entry — the server's export again | `home-file`, one function both use (as `automationEntryFrom` already is) |
| `state/live.ts`, `state/views.ts` | applying live updates; saying what the screen shows | `api-client`, beside the stream they belong to |
| `api-client`'s `react-native` and `expo-constants` | finding the server's address | `client/src/platform/`; `api-client` is handed it |

About 60 places in the app branch on local or server mode; principle 4
removes them. Words, icons and colours for screens — `looks.ts`,
`modes.ts` — stay the app's: they are how it looks, not what it does.

## The ports

Each declared by the package that needs it; one implementation per place.

| Port | Declared by | Server | App |
|---|---|---|---|
| `SqlDatabase` (`exec`, `all`, `get`, `run`, `transaction`; synchronous) | `store` | bun:sqlite on a file | expo-sqlite on a phone; SQLite's WebAssembly build, on OPFS, in a browser's worker |
| where automations and runs are kept | `automation-engine` | `store` | `store` |
| where devices, connections and secrets are kept | `holder` | `store` | `store` |
| the gateway's memory (`GatewayLedger`) | `gateway` | `store` | `store` |
| what a device keeps for itself (`DeviceStore`), what a transport keeps (`TransportStore`) | `device-sdk` | `store` | `store` |
| `SecretsAtRest` (seal, open) | `store` | the key in `KRAFTVERK_SECRET_KEY` | a key kept in the phone's secure storage |
| `Installed` (device types, protocols, transports) | `hub` | found on disk | the generated registry |
| random ids | — | `crypto.getRandomValues` | the same, with a polyfill on a phone |
| the snapshot file | — | the server writes what the hub hands it | none |

## Decisions for the owner

1. **The language and the engine are two packages** (recommended). A device
   package declares recipes and functions in the language; it must not pull
   in the engine. The configuration stays its own package as well: it is the
   whole home as a document, of which automations are one part.
2. **The SQL port is synchronous** (recommended). bun:sqlite and expo-sqlite
   fit it, and the stores and engine stay as they are. How a browser keeps
   one was researched when its turn came (2026-10-02; "SQLite in the app",
   below): not sql.js in memory, but the hub in a Web Worker on the SQLite
   project's own WebAssembly build, where a file in the browser's private
   storage is synchronous.
3. **Passphrase sealing moves to Web Crypto** (PBKDF2 and AES-GCM), so the
   app opens a sealed export too. A new `sealed:v2:`; `v1` (scrypt) stays
   readable on the server — the document is versioned on purpose — unless
   no sealed export exists worth keeping.
4. **An automation held by the app runs while the app runs.** In a browser,
   while the tab is open; on a phone, in the foreground, and in the
   background only as the platform allows. Said where it is held, as a
   connection's holder is.
5. **One interface for both modes** (recommended, principle 4). The
   alternative keeps the app's two paths, and every feature is written
   twice.
6. **One home, one master at a time; the app always keeps it** (the owner,
   2026-10-02, after 6e; refining "an app with a server stays a holder of
   connections"). Without a server the app's own database is the home's
   master. A server added beside it becomes the master — it never sleeps —
   and the app keeps a copy of the home, and holds what it reaches itself
   (its own radio) for the server. Lose the server, and the app's copy is
   the master again. Never two writers: syncing two masters is not part of
   this plan. "Phase 6, from 6f", below.
7. **Every place is a kraftverk node** (the owner, 2026-10-02, after 6h:
   the goal the overhaul ends at). No server and no client: nodes, each
   declaring the ways it communicates and what it is — always on,
   reachable by others, trusted with what must stay put — one of them the
   home's master by those properties. "Phase 6, the goal", below; step 6j.

## Guardrails — the rule enforced, not hoped for

- **Shared means shared.** Each shared package typechecks with no Node or
  Bun types (its tests apart), and a CI step bundles each one's entry for a
  browser: a built-in, `process` or `Buffer` fails the build where it is
  written.
- **The layers.** `scripts/architecture.mjs` holds a table of which package
  may import which; an import up the layers, or across them where the table
  says not, fails.
- **The server stays small.** `server/src` has an allowlist of folders —
  routes, auth, admin, platform, discovery, log. A new one fails the check
  until someone has asked whether the app could run it.
- **The app stays screens.** A `.ts` file under `client/src` outside
  `platform/` and `generated/` that imports neither React nor the UI kit
  fails: logic with no screen in it belongs in a package, with its tests.
  What is the app's own and not a screen — the list of servers it knows —
  lives in `platform/`.
- **The language is documented whole.** A test fails when a trigger, a step
  kind or an operator of the language is missing from its README.

## The order

**Done:** phase 0 (2026-10-02), the guardrails — with 60 files of logic
recorded in the server and the app; phase 1 (2026-10-02), the language —
`@kraftverk/automation`, with what a package contributes as its own entry
(`kraftverk.automation`), so the device contract knows nothing of
automations. What the editor's draft still holds — the draft itself, its
role filling, recipes copied into it — waits for phase 6. Phase 2
(2026-10-02), the engine — `@kraftverk/automation-engine`: the engine,
rehearsal, run logs with the app's series, the library; its store a port
(`AutomationStorage`) the server's SQLite store implements. The server's
adapter to it (`serverDevices`, now the hub's `homeDevices`) waited in `server/src/automations/devices.ts`
for the hub. The planner (`plans.ts`) is built on the catalog, the session
manager and the database, not the engine alone: it moves with them, in
phase 5. The engine's own tests run against the SQLite store, and move
with the hub in phase 5, where both are.
Phase 3 (2026-10-02), the store — `@kraftverk/store`: the schema and every
store that keeps only data (catalog, connections, links, events, apps,
automations, the device and transport stores, the gateway's ledger,
policy, app state, the timeline), each made from a `SqlDatabase`, ids from
random values, secrets behind `SecretsAtRest`, and an adapter for sql.js.
Its tests run on bun:sqlite and sql.js. The server's half is
`server/src/platform/` — the file, setting an old schema aside, the one
handle, its bindings of the stores to it, and sealing with its key. What
mixes storage with logic — the sampler, the change log, remote readings —
moves with the hub. 44 files of logic left.
Phase 4 (2026-10-02), one session manager — `SessionManager` in
`@kraftverk/holder`, the server's moved there and made the app's too: told
which connections are its holder's (`holds`), every device's ways in, its
secrets and stores through small ports (`holding()` in the store gives a
home's connections as one holder holds them). The app gains the server's
retry, failover over every connection it holds and identity learning; the
server gains the app's check of a device's identity at its first answer,
and reopening when a secret or read-only changes. 42 files of logic left.
Also (2026-10-02, the owner): the configuration package is
`@kraftverk/home-file`, and every package has a README that says what it
is, what it does and does not, where it fits, and why it is a package of
its own — four headings the architecture check asks for.
Phase 5a (2026-10-02), the hub begun — `@kraftverk/hub`, its README the
design below: what is installed (the registries, any platform's
transports; the server finds packages on its disk and installs them),
devices' views, what is near, readings an app sends in, setup, history,
attention, the assistant's world and the engine's devices — each handed
its database and its timeline. Its tests run on SQLite in memory.
23 files of logic left.
Phase 5b (2026-10-02), planning and the home file — the planner, and the
configuration as one `Configuration` per home: its vocabulary and schema,
export, an import's plan and apply (its yes, its timeline entry, its live
messages: what the route did), the restore, and the copy kept beside the
database as text. An import's pending plans are the home's, not a
module's. Refusals are `ApiError` (`api-contract`). Passphrase sealing is
a port, `PassphraseSealing`, asynchronous: Web Crypto is not on a phone
(`everywhere.d.ts`), so decision 3 is met by the place — the server keeps
its scrypt `v1`, the app brings its own in phase 6 — rather than by the
hub choosing a cipher every place must have. The snapshot's file, its
copies and the copy a restore is made from are the server's
(`platform/snapshot.ts`). The server has no file of logic left outside
its places: 17 left, all the app's.
Phase 5c (2026-10-02), `createHub` — one `Hub` wires a home: its stores,
the session manager, the gateway, the library and the engine, the
planner, views, setup, what is near, history, attention and its
configuration, with `start()` and `stop()`. The server's `index.ts` is
finding packages, opening its file, `createHub`, the snapshot, HTTP; the
routes' test kit builds a hub as the server does. The engine's tests moved
to the hub, on SQLite in memory — and found that a run could take a
reading heard in the same millisecond as its own switch for one heard
after it: what a run hears and does is now ordered by a count, not by the
clock.
Phase 5d (2026-10-02), `KraftverkApi` — in `api-contract`, with `Caller`
(a person, with their account on a server, or an agent acting for one),
`ApiError` and `LiveStream`: device types, devices (views, keys, pictures,
removing, history, changes, events, commands, settings, tools, queries),
problems, connections, links, setup, what is near, transports,
automations, the configuration, the home's values, the timeline, the
world and its words, apps and what they send for connections they hold,
and the live stream. `hub.as(caller)` answers all of it: every check, the
timeline, a yes's token (on the hub, as each caller's API is made per
request), and what a screen's list shows changing — said by the hub as it
changes it, so the server's middleware that guessed it from paths is
gone. Every route is an adapter — validate, `hub.as(callerOf(c))`, answer
— and `AppDeps` is the hub and what is the server's own. The assistant's
MCP tools ask the home as an agent. Emptying the database is
`hub.reset()`; who may is the server's.
Phase 5e (2026-10-02), over HTTP — `httpApi({ baseUrl, fetch })` in
`@kraftverk/api-client/http` is `KraftverkApi` through the routes and the
live socket, on `fetch`, handed its address, a refusal read back into the
hub's `ApiError`. One suite asks the same questions of the home in the
process and over HTTP, and both answer alike (`server/src/api.test.ts`).
The app's older calls stay until phase 6 moves it onto the interface.
**Phase 5 is done**: the server is the HTTP adapter, accounts, the
broker's start and the disk; the home is the hub's.

### Phase 5, in detail

Researched 2026-10-02 from every route, every server file and every place
the app branches on where its home is. The hub's README holds the design;
this is the order it is built in, each step green and pushed.

**What the hub is made from.** `createHub({ database, secrets, installed,
platform, readOnly, http, log, now })`: a prepared `SqlDatabase`, how
secrets are sealed at rest, what is installed (registries the place fills
— the server from its disk, the app from its generated registry), the
platform whose transport entries run here, read-only as a function, a
scoped HTTP client for a setup helper, and a clock. Nothing else reaches
in: no environment, no file, no `process`.

**Who is asking.** Every call carries a caller — `{ kind: 'person', name }`,
`{ kind: 'agent', for }`, `{ kind: 'app', id, person }` — because the
gateway binds a confirmation to a person and refuses an agent what needs
one, setup drafts and import plans belong to whoever started them, and the
timeline names who. `hub.as(caller)` is a `KraftverkApi` for one caller;
the server makes one per request from its session, an app with no server
one for its owner. Accounts, sign-in and the reset stay the server's: the
hub never sees a password.

**Refusals in words, not in HTTP.** The hub throws `ApiError` — declared
with `KraftverkApi` in `api-contract`, the one thing there that runs —
with a kind (`invalid`, `not-found`, `conflict`, `locked`, `needs-yes`,
`unavailable`), the sentence, and where it applies the confirmation token
or the problems. The server's adapter maps each kind to its status;
`api-client` maps a status back to the same error, so a screen handles one
refusal whichever way its home is reached. `SetupError`, `ImportError`,
`RunRefusal`, `ToolRefused` and the planner's `HTTPException` become it.

**Where each connection is held.** A connection the hub holds has
`held_by` null — the server's on a server, the phone's in local mode; one
an app holds for a server's home names that app. An app with a server is
not a second hub (decision 6): it holds its own connections through the
holder, as `createHolding` in the hub — its sessions, its gateway, its
uplink — and wraps the server's `KraftverkApi` so a command to a device it
holds goes to its own gateway and a view carries its own readings. The app
then has one interface in both modes, and never branches on which.

5a. **The hub begun** — done, above.
5b. **Planning and the home file** — done, above. A device's entry
    (`deviceYaml`, the app's) moves to `home-file` with phase 6, when the
    app's editor and the export become one function.
5c. **`createHub`** — done, above. The routes still take the hub's parts
    (`homeOf(hub)`); they take `hub.as(caller)` in 5d.
5d. **`KraftverkApi`** — done, above. As planned: in `api-contract`, grouped as the routes are:
    `deviceTypes`, `devices` (views, renaming and keys, pictures, removing,
    history, changes, events, problems, commands, settings, tools,
    connections and their secrets), `links`, `setup`, `nearby`,
    `transports`, `automations` (kit, drafts, runs, logs, rehearsal,
    start and stop), `configuration` (vocabulary, export, plan, apply,
    snapshot), `policy`, `timeline`, `world`, `held` (what an app sends
    for a connection it holds, and its apps), and `live` (what changed, as
    it changes — the outbox moves into the hub — and what a screen shows).
    The hub implements it for a caller; each route becomes: validate,
    `hub.as(caller)`, answer — the logic left in the routes moves into the
    hub with it. MCP's tools call the same interface as an agent.
5e. **Over HTTP** — done, above. Finding the server's address moves to the
    app's platform with phase 6.

### SQLite in the app (researched 2026-10-02, the owner asking for the best, not the simplest)

**On a phone: expo-sqlite.** Expo's own, real SQLite in native code over
JSI, with the synchronous API (`openDatabaseSync`, `runSync`, `getAllSync`,
`withTransactionSync`) the store's port already is. op-sqlite is faster in
benchmarks, but a home's data is small, and expo-sqlite is the toolchain
the app already builds with. A connection's secrets are sealed in it with
a key kept in the phone's secure storage (below, 6c) — which runs in Expo
Go as well; the whole file encrypted (expo-sqlite's SQLCipher) can follow
if history itself should be, at the cost of a development build.

**In a browser: the hub in a dedicated Web Worker, on
`@sqlite.org/sqlite-wasm` with its `opfs-sahpool` storage.** Every way to
keep SQLite in a file in a browser needs a worker: the origin private file
system's synchronous access handles exist only there, and nothing
persistent is synchronous on the main thread (sqlite.org's own persistence
notes). So the whole hub runs in the worker, as synchronous as on the
server, and the screens reach it through `KraftverkApi` over messages — a
third way to the one interface, beside the process and HTTP — so the
screen thread never waits on SQL or an automation. Chosen over the rest:

- the SQLite project's own build, released with SQLite (3.53.4, September
  2026), against `wa-sqlite`, whose npm package has not been published
  since January 2024 (its newer storage modes only from GitHub or a
  company's fork);
- `opfs-sahpool`: the fastest of its OPFS stores, and the one that needs no
  cross-origin isolation headers; one connection at a time, which a home
  wants anyway — its automations must run once, not once per tab;
- against expo-sqlite on the web (alpha, needs the cross-origin isolation
  headers, one tab) and sql.js in memory (not a file; the whole database
  written out again on every save).

What it asks of the rest:

- **One tab holds the home**, chosen with a Web Lock; another tab says so,
  and takes over when that one closes.
- **The transports stay on the page.** Web Bluetooth exists only in a
  window (MDN; the spec's worker issue #571 is open), and choosing a device
  needs a person's tap; WebUSB, Web Serial and every chooser after them are
  the same. So in a browser every transport runs on the page, and the
  worker's hub reaches each over a message port — the same `Transport`,
  its channels carried both ways — and never learns it is in a worker.
- **The site's policy allows WebAssembly** (`'wasm-unsafe-eval'` in
  `script-src`) — and nothing else changes in it.
- **A failed start never wipes the home.** `opfs-sahpool` deletes its
  pool when it fails to start unless asked not to (`preserveOnInitFailure`,
  documented, not yet in the published package): the worker starts it
  only once it holds the tab's lock, and takes the option when it ships.
- **The worker is a bundle of its own**, without the screens and without
  a transport: the generated registry is split, so the hub's part — device
  types, their contributions, protocols, transport definitions — imports no
  React. It is bundled apart from Metro (whose worker support is alpha,
  and which cannot load the WebAssembly's own file), and served beside
  `sqlite3.wasm`.

### Phase 6, in detail

Planned 2026-10-02, the owner asking that a phone not carry what only a
browser needs, and that it hold for every place a home runs: a server, a
phone, a browser, and whatever comes next.

**Where a home runs, and how it is reached, are two things.** The hub is
one, everywhere, made from ports (phase 5). Where it runs is the place's
arrangement of those ports; how the screens reach it is always
`KraftverkApi`. The screens ask one interface and never which place:

| The home | Where the hub runs | Its database | How the screens reach it |
|---|---|---|---|
| on a server | the server's process | bun:sqlite, a file | over HTTP (`httpApi`) |
| a phone's own | the app's own process, beside the screens | expo-sqlite | in the process (`hub.as(owner)`) |
| a browser's own | a dedicated worker | sqlite-wasm on OPFS | over a message port |

- **A phone pays for nothing a browser needs.** No worker, no messages,
  no WebAssembly: the hub is a plain object in the app's process, as on
  the server. Each place is a file of its own under `client/src/platform/`,
  chosen by Metro's platform extension (`open.ts` a phone's, `open.web.ts`
  beside it a browser's, as the app's other web-only files are), so one's
  code is never in the other's bundle.
- **A browser pays only for what it must.** The worker exists because a
  persistent SQLite needs one; the transports stay on the page because the
  platform keeps them there.
- **Nothing in the hub knows either.** The message port is a package of
  its own (`@kraftverk/message-port`): `KraftverkApi` and `Transport`
  carried over any `MessagePort`-like end, served on one side and the same
  interface on the other. A worker today; a phone's background runtime, a
  shared worker or a desktop shell's process later, with no screen
  changing. The API's agreement suite asks it as a third way.
- **With a server, the server is the master, and the app keeps a copy**
  (decision 6): the app holds what it reaches itself for the server, and
  shows the server's home from its own database when the server is away —
  "Phase 6, from 6f", below.

The steps, each green and pushed:

6a. **The parts a place puts together** — done, 2026-10-02. The
    generated registry in parts: `installed.ts` (device types with their
    contributions, protocols, transport definitions — no React),
    `transports.ts` and `transports.web.ts` (each transport's entry for a
    phone and for a page, so neither bundles the other's), and
    `registry.ts` (screens, pictures). `installedFrom`
    in the hub: the three registries from lists, as a place with no disk
    to search — the app — installs them. `SqlDatabase` over SQLite's
    WebAssembly build and over expo-sqlite in the store, described rather
    than imported, as sql.js was — which goes: nothing runs it now. The
    store's tests run on bun:sqlite and on the WebAssembly build, and a
    home made from lists on it adds and switches a lamp (the hub's
    `installed.test.ts`). The expo-sqlite adapter comes with 6c, against
    the package's own types.
6b. **Over a message port** — done, 2026-10-02. `@kraftverk/message-port`:
    `serveApi` and `apiOver`, `serveTransport` and `transportOver` —
    calls by their path (one the interface lacks refused where it is
    served), refusals as `ApiError`, the live stream, a step's abort, a
    transport's state, its live list and chooser, and its channels' bytes,
    broker messages and HTTP answers. `server/src/api.test.ts` asks the
    home a third way and gets the same answers.
6c. **A phone's own home** — done, 2026-10-02, but not yet run on a
    phone. `client/src/platform/home/`: `hub.ts`, the app's hub as both
    places make it (the generated registry, `installedFrom`, its timeline,
    `OWNER`); `own.ts`, a phone's — expo-sqlite through the store's
    `fromExpoSqlite` (its every path run by the store's suite, over
    bun:sqlite shaped as expo-sqlite answers), a file per schema so a new
    one never writes over the last, expo-crypto's random values where the
    phone has none. `cipher.ts`, the app's cipher in plain JavaScript
    (@noble/ciphers and @noble/hashes, audited, no dependencies): secrets
    sealed at rest with a key from the phone's secure storage, and
    passphrase sealing in the server's own `sealed:v1` — an export sealed
    by a server opens in the app (tested against one). The app's hub runs
    in a test with every installed package: a simulated plug added,
    switched, an automation run, all on its owner's timeline.
6d. **A browser's own home** — done, 2026-10-02. `worker.ts`, bundled
    apart by esbuild (`client/scripts/build-home-worker.mjs`, in
    `build:web` and, watching, in `web`) beside `sqlite3.wasm` in
    `public/home/` — no React, no screens, no transport entry in it.
    `opfs-sahpool` is opened only under the tab's Web Lock, and only once
    every file of its pool is found free: it deletes a pool it fails to
    open, so it is never asked to while another may hold one. Another tab
    asks the holder to let go (a BroadcastChannel); the holder stops
    serving, stops its hub, closes the database and releases the pool's
    files before it lets go of the lock — never stolen. The page serves
    every transport it runs to the worker (`own.web.ts`); the key sealing
    secrets is kept sealed by a key the browser will not let out, in
    IndexedDB. The hub runs a chooser as a setup step
    (`setup.choose(id, { chooser })`), so a person's tap reaches the page's
    picker across the worker. `'wasm-unsafe-eval'` in the site's policy.
    Run in a browser: every installed type offered, a simulated plug added
    and switched through the gateway, a second worker refused while the
    first holds the home and handed it on asking, the plug still there
    after the hand-over and after a reload. It needs a secure page — HTTPS,
    or the computer itself — as OPFS does; on plain HTTP the app says so.
6e. **The screens on the interface** — done, 2026-10-02.
    `HomeProvider` gives a `KraftverkApi` — a server's (`httpApi`), or the
    app's own (`openOwnHome`), shown once it is open, or why not: another
    tab holds it, with "Use it here" — and every screen asks it: the
    devices, adding one (`HomeFlow`, every step in the home), automations,
    history, problems, what is near, connectivity, the configuration.
    `local.ts`, `describeLocal`, `AppFlow`'s own half and the mode branches
    go; a home of the app's own has history, automations, removed devices
    and its configuration, as a server's does. The contract follows: a
    method's availability is the home's (`availability[method]`), a
    connection the home holds is `heldBy: { kind: 'home' }`, a way kept to
    a server (`serverOnly`) is refused by a home in an app, and a live
    stream says whether it is up (`onState`). A refusal that only wants a
    yes is an answer to a screen (`askingYes`, `changeAutomation`,
    `applyPlan` in api-client). `e2e/local.e2e.ts`: with no server, a plug
    added and switched, an automation written as YAML and run — once the
    gateway's dwell allows — and all of it there again after a reload. 16
    files of logic left in the app.
6f–6i: below, "Phase 6, from 6f".

### Phase 6, from 6f: the app always keeps the home

Settled with the owner, 2026-10-02, after 6e, from how a person comes to
kraftverk: they start with the app alone, and its database is their home.
Later they may add a server, which extends what the home can do — running
while the app is closed, reaching what only a server reaches — and the app
still shows the home when the server is away. None of it is a choice put
to them: the ways a device can be reached, and what an automation needs,
decide where things run.

**One master at a time** (decision 6). Without a server, the app's own
database is the home's master — 6c to 6e, done. With a server, the server
is: it runs while the app is closed, and every app a person uses follows
it. Never two writers, so nothing is ever merged.

- **Adding a device.** Without a server, the app's own ways only — a type
  no way of which the app can use is not offered. With a server, the
  server's ways, and this app's own radio for the server ("Bluetooth, from
  this phone"); the device is the server's either way.
- **What can be added is what is installed where** (the owner, the same
  day). A server finds its packages on its own disk, so it may know types
  the app has never heard of — a package someone adds to their server —
  and the types offered are the home's: the server's with one, the app's
  own without. The app's own radio is offered for a server's device only
  for a type the app has installed too: it runs the type's code. Each type
  says plainly where it can run — on this phone, only with a server, or
  either — from what is declared (a transport's platforms, a method kept
  to a server), and every way says whether it can be used now, or why not.
  A type only a server knows is drawn by the generic pages.
- **One device, reached two ways** (decision 2, §10): a server's device
  may have a connection this app holds — the P280 over Wi-Fi through the
  server, and over Bluetooth from the phone — one device, one history,
  each tried in its order. The app runs that connection's session and the
  gateway's rules for it, and sends what it reads, its events and its
  timeline to the server, queued while the server is away.
- **The app's copy.** With a server, the app keeps the server's home in
  its own database: what it has (devices, connections, links,
  automations, the home's values — what the configuration describes,
  without the secrets of connections only a server holds), and what each
  device last said; recent history later. When the server is away the
  home is shown from it, as it was last heard and saying so, read only;
  what the app reaches itself goes on.
- **The hand-over.** A server added to an app that has a home of its own
  takes it over: devices, automations, links and values go to the server,
  and a connection the app held becomes one it holds for the server. A
  server lost or let go of, the app's copy becomes the master again: its
  devices, automations and history stay, and ways only a server can hold
  wait for one.
- **Where it runs.** In a browser, the app's database is in its worker, so
  what the app holds for a server is held there too: one owner of the
  radio. On a phone, in the app's process, as its home is.
- **The screens** ask one `KraftverkApi` throughout: the app's own home,
  or the server's with what the app holds wrapped in — never which.

The steps, each green and pushed:

6f. **What the app holds for a server** — done, 2026-10-02, in four
    parts. What can be added is what is installed where: a type lists its
    `ways` — method, holder (`home`, or `this-app` holding it for a
    server), whether it can be used now — and `runsOn`, from what is
    declared (`placesOf`, `runsOn` in the SDK); a home offers only the ways
    it can hold where it runs, and with no server a type that needs one
    says so, only its simulator offered. `createHolding` in the hub: the
    app's own sessions and gateway for the ways it holds, held while
    nothing above them reaches the device (`toHold`), wrapping the
    server's `KraftverkApi` — this app's ways for a type it has installed
    too, set up through `setup` (read here, judged and kept by the server,
    the secrets kept here), views and the live stream with its own
    readings, a command, a setting, a query or a tool to a device it holds
    through its own gateway, its own transports. What it keeps is in the
    app's own database — the server's device and the way it holds by the
    server's ids (`mirror`), the secrets, stores, the gateway's memory and
    what is owed (`SendQueue`, a new table) — so a restart loses none of
    it, and with the server away it still reaches what it holds. The app
    opens it where it runs (`openHome`: a phone's in its process, a
    browser's in the same worker as its own home, the page serving it the
    server's interface), and no screen knows it exists. The app's runtime
    (registry, sessions, uplink, vault) and `AppFlow` are gone;
    api-client's older calls too — a server's own (`ServerApi` in the
    contract: whether one answers, signing in, accounts, its version, its
    log, its reset, its snapshot) are `serverApi` on `fetch`, and
    api-client needs no axios, React Native or Expo; where a server would
    be beside the app, and the servers it knows, are the app's platform's;
    a phone keeps its preferences, in expo-sqlite's key-value store. 10
    files of logic left in the app.
6g. **The app's copy of the server's home** — done, 2026-10-02. What the
    screens read of the server — its devices, removed ones, automations,
    the home's values, problems, what can be added, its transports — is
    kept as it answers, in the app's own database (`last_heard`, by what
    was asked, with when; a change the server answers with its new state
    kept too), and refreshed every five minutes by the holding whether or
    not a screen asks. While the server cannot be reached, the same
    interface answers from it: the server's devices offline, "this is what
    it last said", with what they said; what this app holds, live; a
    change through the server refused by its absence. The screens learn
    it from the server's own answers: `httpApi` says after each request
    whether the server answered at all (`onReach`), the home says it is
    `away`, the list is read again at once, and the banner says what is
    shown. Seen in a browser: the server stopped, the app reloaded with it
    gone, the home shown from the copy; the server back, live again.
    What it does not keep yet: history, the timeline, a run's log — those
    are the server's while it is away.
6h. **The hand-over** — done, 2026-10-02, both ways, as an import: one
    the person sees planned before anything moves, and says yes to where
    it sets something acting. A home this app kept is the home it shows,
    brought in from another database it keeps beside it
    (`configuration.plan({ from })`, `configuration.elsewhere()`):
    - **This app's home to its server** (`from: 'this-app'`, the holding's,
      `handover/move.ts`): the home as one file, sealed with a passphrase
      made for it and never shown, imported by the server. A way over a
      radio (`nearby` in a transport's definition: Bluetooth) stays with
      the phone near the device, and so does one the server cannot hold:
      left out of the file, then added as this app's way for the server —
      read by this app, judged there as the device it now has, its key
      kept here. Every other way moves, and the server holds it while the
      app is closed. What the app recorded stays with it.
    - **A server's home to this app** (`from: 'copy'`, the app's own
      home's, `handover/keep.ts`): the server's configuration, which the
      holding keeps in its copy (`last_heard`) at every refresh, planned and
      applied as a restore is — a secret only the server had is left out
      and said, a way only a server can hold comes and waits for one — and
      the ways this app held come with their keys. The server's history
      stays with it. The server this app used last is remembered when it
      stops using one.
    Offered on the home page when there is something to bring, and not
    again once brought — or once the plan finds it all there already. Seen
    in a browser: a server's home kept by the app (four devices, five
    automations, running in the browser), then offered back to the server,
    which had it all.
6i. **The rest of the app's logic to packages**, as listed under "What
    moves — the app": the live updates and views to api-client,
    `togglesOf` and `settingsForms` to device-sdk, `deviceYaml` to
    home-file, the editor's draft to the language. The baseline of logic in
    the app reaches nothing.

### Phase 6, the goal: every place is a kraftverk node

Set by the owner, 2026-10-02, after 6h, as where the whole overhaul ends:
**there is no server and no client — only kraftverk nodes.** A node is the
hub running somewhere — a machine on the network, a phone, a browser —
with the ways it can communicate where it runs, and the database of one
home. Several nodes of one home are one master and the nodes that follow
it; which is which is a role, not a kind of machine. Phase 6 built most of
this already — one `createHub` everywhere, one `KraftverkApi` in the
process, over HTTP and over a message port; the master's role moving
between nodes (6h); a node lending its radio to the master (6f) — and
"server" and "client" are left in names, not in what the code does.

**What tells nodes apart is what each declares it is**, never which it is:

- **The ways it communicates** — the transports it has an entry for where
  it runs, as now (`Platform` names the runtime a transport's entry is
  for: a process, a browser's page, a phone; not a role).
- **Always on, or only while open** — a node that runs while nobody looks
  keeps history and runs automations at night.
- **Reachable by others, or only reaching out** — a phone reaches a machine
  on the network; the machine does not reach a phone asleep or on a mobile
  network. A node others reach serves the interface (HTTP today) and says
  who may (accounts).
- **Trusted with what must stay put** — a vendor account's password belongs
  on a node that is always on and kept at home, not in a browser: what a
  method's `serverOnly` says today, as a requirement a method puts on a
  node.

**The master is chosen from those**: the node that is always on and that
the others can reach — the machine on the network, when there is one; a
phone alone, when it is alone. Every other node of the home follows it
(a copy, 6g), lends it what it reaches itself (6f), and can take the
master's role over when it is gone (6h). Never two writers (decision 6).
Two always-on nodes, or a phone as master for a tablet, fall out of the
same rule rather than needing a mode each.

**6j. One kind of node** — after 6i, everywhere at once (strict version 1):

- The words: ARCHITECTURE.md's vocabulary gains **node** and **master**;
  "holder" is a node, "client" goes. The decisions that say server and
  client (2, 6, 15, 22, 23) are said again in nodes.
- The contract: a node's properties above, declared by each node and said
  in `KraftverkApi` (what is this node, and what are the nodes of this
  home); `apps` and `held` become the nodes of a home and what a node
  sends the master for the ways it holds; `owner: 'server' | 'client'` in a
  device's health names the node; `serverOnly` becomes what a method needs
  of a node.
- The store: `client` and `held_by → client` become nodes, and a node of
  its own home knows its own id (a node's id is the id the others know it
  by — what 6f's app id already is).
- The hub: `createHub` and `createHolding` read as one node's two roles —
  the master's, and a follower's — over one set of parts, rather than two
  things; the master chosen by the rule above, not by which place opens it.
- The server and the app: the server is a node's process with an HTTP
  entrance and accounts; the app a node's screens and platform. Neither
  names the other's kind.
- **On screen** — the owner's to say when 6j starts. Recommended: people's
  words stay ("through your server", "from this phone"): "server" for the
  always-on node most people have one of, "this phone" or "this browser"
  for the node in their hand, as the app already avoids the words a
  person does not use (transport, protocol).

Done when no code, type, table or route names a server or a client as a
kind of thing, and every difference between nodes that matters is a
property a node declares.

**6j, part 1 — the data model, and up from it** (done, 2026-10-02; started
before 6i, the owner asking for it, from the data model up):

- The store: `node` (every node of the home: this database's own, `self`,
  and the nodes that joined it, each with its traits — `always_on`,
  `reachable`, `trusted` — its transports and its place), `home` (one per
  database, `master_id` naming its master node: a column, not a flag, so
  more than one machine node is a door left open), and `place` (where
  nodes and devices stand, with a time zone; `device.place_id`).
  `device_connection.held_by` is a node, never null: the master's own ways
  say so. `sessions` lost its app id.
- The node's id is its own: `newNodeId()`, kept where it runs — beside the
  server's database (`node-id`), in the app's preferences — the same in
  every database that knows it, and kept when a database is set aside.
- The contract: `NodeView`, `NodeJoin`, `HomeView`; `home()`, `nodes.join`
  by the node's own id; a way's holder `master` or `this-node`; who holds
  a connection `{ kind: 'master' | 'this-node' | 'node', id, name }`; a
  device's health names the node holding it. `Platform` names the runtime:
  `system`, `web`, `native` (transports' `system.ts`).
- The hub: `createHub` and `createHolding` are each handed the node they
  are (`node`), and declare it to their database; the holding joins the
  master by it. The server: `GET /home`, `/nodes`, `/nodes/:id/audit`.

Next in 6j: `serverOnly` as what a method needs of a node (`trusted`); the
master chosen by the traits, and `Holding` named as a follower; places up
through the API, `DeviceContext` and the weather; the configuration
document's places (a new `kraftverk:` version, with its migration); the
screens in nodes; the docs' vocabulary and decisions.

**A structure pass** (the owner, 2026-10-02), once the hub is done and the
packages are as they should be: the server and the app looked at again,
critically, after so much has left them — their folders, modules and
names, what each file is for now and whether a person new to them finds
their way — and changed where the shape no longer fits what is left: an
understandable, simple, but powerful layout, not the one the moves left
behind.

Each phase green and pushed. Files move first as they are (with git's
history), then change. The server behaves as before throughout — the one
visible change is a sealed export's new format (phase 5) — and the owner's
server is checked after each phase.

0. **The rule, written and enforced.** This plan; ARCHITECTURE.md §3 and §9;
   AGENTS.md. The guardrails above for what exists — the shared packages
   there are, the layer table, the server's and the app's allowlists — with
   today's exceptions recorded in the baseline so it can only shrink. Each
   new package comes under them as it is made.
1. **The language: `automation`.** From `device-sdk` (`automation.ts`,
   `recipes.ts`), the configuration package (`expr.ts`, `rules.ts`) and the editor's rule
   edits. Every import changes at once (strict v1), and the dependency rule
   lets a device type import `automation` beside the SDK. Its README becomes the
   reference — the JSON form and the text form side by side, every trigger,
   step and expression, what each means and when it judges; AUTOMATIONS.md
   and CONFIG.md point to it. The test that the reference is whole comes
   with it.
2. **The engine: `automation-engine`.** The engine, rehearsal, the
   library, run logs with the app's series. It declares its storage port;
   the server's store implements it until phase 3.
3. **The store: `store`.** The SQL port; the schema, its fingerprint and
   set-aside; every store, made from a database, with nothing at module
   level; audit and app state as objects; ids from Web Crypto; secrets at
   rest behind their port. bun:sqlite stays in `server/`. Every store's
   tests run on bun:sqlite and on sql.js, so the port is proven where the
   app will use it.
4. **One session manager, in `holder`.** The server's and the app's become
   one, declaring where its devices are kept.
5. **The hub, and one interface.** `KraftverkApi` in `api-contract`;
   `createHub(...)` implements it, with registry and views, setup, nearby,
   the sampler, attention, the assistant's world, the configuration's import
   and export, the live outbox and the uplink. The server's routes become
   the adapter; `api-client` implements the interface over HTTP and the
   WebSocket, handed the server's address. Passphrase sealing moves to Web
   Crypto here, with the import and export (decision 3).
6. **The app on the interface.**
   - Its providers take a `KraftverkApi`: from `api-client` with a server,
     from `createHub` without one — on expo-sqlite on a phone, in a Web
     Worker on the web ("SQLite in the app", below). `local.ts`, `describeLocal`, `AppFlow`, the app's sessions and
     runtime go; a local install starts afresh (strict v1).
   - The app's pure helpers move as listed above.
   - Local mode gains history and automations: the editor, the run log and
     the timeline against the hub in the app.
7. **The docs.** ARCHITECTURE.md §3, §4.7 and §6; DATA-MODEL.md; DEVELOPING.md
   (where code goes); HANDOFF.md; a README for every new package.

## Risks, and how each is met

- **A phone's clock.** The engine reads a home's time zone with `Intl`;
  Hermes's support is checked on a phone in phase 6, with a small time-zone
  library as the fallback.
- **A phone's background.** The platform suspends a backgrounded app; the
  engine already catches up on what was due (its grace hour). What runs in
  the background is decision 4's.
- **New dependencies** — SQLite's WebAssembly build (`@sqlite.org/sqlite-wasm`,
  about a megabyte, in a browser's worker only), expo-sqlite and
  expo-secure-store (a phone only), a random-values polyfill — each reviewed,
  as ARCHITECTURE.md §3 asks, and loaded only where it runs.
- **The size of the move.** Files move unchanged first and change after, so
  each diff is either a move or a change; the e2e suite and the server's own
  tests guard every phase.

## Not in this plan

- Syncing an app's home with a server's (decision 6).
- Running automations in a phone's background beyond what the platform
  allows.
- Screens in packages: the app's screens stay the app's. A package for them
  waits for a second app to share them with.

## Verification

- Every phase: typecheck, tests, the architecture check, the e2e suite; the
  owner's server checked after it deploys — devices connected, the charging
  chain runs.
- From phase 0: the shared packages typecheck without Node's or Bun's types,
  and each bundles for a browser — `hub`, with everything under it, from
  phase 5.
- Phase 3: every store's tests pass on bun:sqlite and on sql.js.
- Phase 5: the API's tests run twice — against the server over HTTP, and
  against `createHub` in the process — and agree.
- Phase 6: an e2e test runs the app with no server: a simulated plug added,
  an automation made, run, and its log read; on a phone, against a real plug
  over Bluetooth.
