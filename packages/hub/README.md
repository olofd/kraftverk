# @kraftverk/hub — a home, running

## What it is

One kraftverk home, running wherever it is kept: its devices held and
watched, every action through the gateway, its automations running, its
history recorded, its configuration read and written — and the one
interface everything that uses a home speaks, `KraftverkApi`, answered in
the process.

`createHub(...)` is handed what only the place it runs can give — a SQLite
database, how secrets are sealed at rest, what is installed, the platform's
transports — and gives back a home. The server runs one behind its HTTP
API; the app runs one on a phone or in a browser when it has no server; a
test runs one in memory.

## What it does — and does not

- **Does:** wire the shared packages into one home — the stores
  (`@kraftverk/store`) over the database it is given, the session manager
  (`@kraftverk/holder`), the gateway (`@kraftverk/gateway`), the engine
  (`@kraftverk/automation-engine`) — and what only a whole home does:
  - what is installed: device types, protocols, transports, and what
    packages bring to automations, installed by whoever found them;
  - a device's view: what it is, its readings and health, its connections
    and links — wherever it is held;
  - adding a device: setup drafts, sightings, the check, the save;
  - what is near: what the transports see that nothing you have claims;
  - history: sampling, roll-ups, the change log, readings an app sends in;
  - attention: what people are looking at, and the devices kept fresh for
    them;
  - the assistant's world and vocabulary;
  - the configuration: planning and applying an import, an export, a
    restore after a reset;
  - the live stream: what changed, coalesced for each listener;
  - `KraftverkApi`, answered for one caller at a time (`hub.as(caller)`),
    with each refusal as an `ApiError` in words.
- **Does not:** serve HTTP, keep accounts or sessions, decide who may sign
  in, run the MQTT broker, open a file, read the environment, or find
  packages on a disk — those are the server's, or the app's platform. It
  names no product, no protocol and no transport, and keeps nothing at
  module level: two hubs run side by side in one process.

## Where it fits

The top of the shared core (docs/PLAN-SHARED-CORE.md): it may import
everything under it — the contract, the language, the gateway, the home
file, the API's shapes, the holder, the engine, the store — and nothing
imports it but the edges:

```
server/   HTTP → hub.as(caller)          client/   screens → KraftverkApi
            │                                        │
            ▼                                        ├── no server: createHub (expo-sqlite, sql.js)
          createHub (bun:sqlite)                     └── a server: api-client, and the
                                                         connections this app holds
```

The server's routes are an adapter from HTTP to `KraftverkApi`;
`@kraftverk/api-client` implements the same interface over HTTP and the
WebSocket. The app asks one interface whether its home is on a server or
in its own SQLite, and never branches on which (decision 22).

## Why a package of its own

Because a home is the same thing wherever it is kept. What a server does
with its devices — hold them, judge a setup's check, sample their history,
run automations, keep its configuration — is what an app with no server
must do too, and written twice it drifts (it did: the app's local mode was
a second, smaller model of devices with no history and no automations).
One package, handed its platform as ports, is one behaviour on a server, a
phone, a browser and in a test — and the server is left as what only an
always-running machine must be.

## In detail

**Being built** (docs/PLAN-SHARED-CORE.md, "Phase 5, in detail"): what is
below is the design, and the plan says which part is in. In now: what is
installed (`DeviceTypeRegistry`, `ProtocolRegistry`, `TransportHost` for
any platform), devices' views (`DeviceRegistry`), `Nearby`,
`RemoteReadings`, `SetupService`, history (`Sampler`, `ChangeLog`, `series`,
`changesOf`), `Attention` and `keepWatchedFresh`, the assistant's world,
`homeDevices` for the engine, the planner (`plans`), and the home's
configuration (`Configuration`: vocabulary, schema, export, an import's
plan and apply, the restore, the copy kept beside the database) — each
handed its database and timeline. Sealing a secret with a passphrase is a
port (`PassphraseSealing`): the place's cipher, not the hub's.
`@kraftverk/hub/testing` is a lamp on a pretend bus, for tests.

### Made from ports

```ts
const hub = createHub({
  database,      // SqlDatabase: bun:sqlite, expo-sqlite or sql.js, its schema prepared
  secrets,       // SecretsAtRest: the server's key, a phone's secure storage
  installed,     // Installed: device types, protocols, transports — found by the place
  platform,      // 'server' | 'web' | 'native': which transports' entries run here
  readOnly,      // () => boolean: every hardware write refused
  http,          // ScopedHttp: a setup helper's one call to a vendor
  log,           // where it says what happened
  now,           // the clock; a test's own
});
await hub.start();         // transports, sessions, the engine, sampling
const api = hub.as(caller); // KraftverkApi, for one person, agent or app
await hub.stop();
```

- **Nothing at module level.** Every store, registry and timer belongs to
  one hub; stopping it stops all of them.
- **A connection the hub holds** is one no app holds (`held_by` null): the
  server's on a server, the phone's in local mode. An app holding
  connections for a server's home is not a second hub: it holds them
  through `@kraftverk/holder` and sends what they say up (decision 6).
- **Who is asking** is part of every call: the gateway binds a
  confirmation to a person, refuses an agent what needs one, and the
  timeline names the account, the automation, the app.
