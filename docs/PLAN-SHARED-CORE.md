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
6. **An app with a server stays a holder of connections**, not a second home
   to keep in step. Syncing two homes is not part of this plan.

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
`withTransactionSync`) the store's port already is, and SQLCipher on iOS
and Android for a database encrypted at rest, its key in the phone's
secure storage. op-sqlite is faster in benchmarks, but a home's data is
small, and expo-sqlite is the toolchain the app already builds with. It
needs a development build — as the phone's Bluetooth already does.

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
  chosen by Metro's platform extension (`.native.ts`, `.web.ts`), so one's
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
- **With a server, the app holds connections, not a home** (decision 6):
  `createHolding` wraps the server's `KraftverkApi` — the app's own
  sessions and gateway for the connections it holds, their readings sent
  up — in the process on a phone and on the page in a browser, where the
  radio is. No worker, and no database: a holding keeps little, in the
  platform's storage.

The steps, each green and pushed:

6a. **The parts a place puts together.** The generated registry in two:
    `installed.ts` (device types with their contributions, protocols,
    transport definitions — no React) and `registry.ts` (screens,
    pictures, each transport's web and native entries). `installedFrom`
    in the hub: the three registries from lists, for the server's
    discovery and the app's registry alike. `SqlDatabase` over SQLite's
    WebAssembly build and over expo-sqlite in the store, described rather
    than imported, as sql.js was — which goes: nothing runs it now. The
    store's tests run on bun:sqlite and on the WebAssembly build.
6b. **Over a message port.** `@kraftverk/message-port`: `serveApi` and
    `apiOver`, `serveTransport` and `transportOver` — calls, refusals as
    `ApiError`, the live stream, a step's abort, a transport's channels and
    its chooser. `server/src/api.test.ts` asks the home a third way and
    gets the same answers.
6c. **A phone's own home.** expo-sqlite and expo-secure-store; the
    database encrypted at rest (SQLCipher), its key in the secure store;
    `own.native.ts` makes the app's hub in the process. Typechecked and
    tested where it can be: a phone has not run it until one does.
6d. **A browser's own home.** The worker bundle; `opfs-sahpool` opened
    only under the tab's Web Lock, handed over to another tab on asking —
    never stolen, so a pool is never opened twice; the transports served
    from the page; a chooser as a setup step the hub runs
    (`setup.choose(id, { chooser })`), the person's tap carried with it;
    `'wasm-unsafe-eval'` in the site's policy.
6e. **The screens on the interface.** A `HomeProvider` gives a
    `KraftverkApi` — a server's, or the app's own — and every screen asks
    it: the devices, adding one, automations, history, the timeline, the
    configuration. `local.ts`, `describeLocal`, `AppFlow`'s own half and
    the mode branches go; a home of the app's own gains history,
    automations and its configuration. An e2e test runs an automation with
    no server.
6f. **With a server: what the app holds.** `createHolding` in the hub;
    the app's runtime, its uplink and api-client's older calls go; finding
    the server's address moves to the app's platform.
6g. **The rest of the app's logic to packages**, as listed under "What
    moves — the app": the live updates and views to api-client,
    `togglesOf` and `settingsForms` to device-sdk, `deviceYaml` to
    home-file. The baseline of logic in the app reaches nothing.

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
