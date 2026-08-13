# Modular code architecture: protocols, devices, adapters, server and APIs

## Purpose

This is the package-boundary companion to
[`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md). It answers a different
question: **where should code live so a new device, protocol or integration can
be added without modifying unrelated parts of the application?**

The central rule is:

```text
protocol = how bytes mean things
adapter  = how to discover, connect to and operate one kind of hardware
device   = a saved, user-owned instance of that hardware
server   = sessions, persistence, API, audit, policy and automation
client   = device catalog, commissioning UX and statically bundled device panels
```

These are intentionally not synonyms. An AFERIY P280 is a **device model**;
MODBUS/Sydpower is a **protocol**; BLE and MQTT are **transports**; “the P280 in
the living room” is a **saved device**; Tuya Local or Home Assistant can be an
**adapter/integration** for a relay.

---

## The dependency rule

Dependencies may point inward only:

```text
Expo client ─────────────┐
Hono server ─────────────┼──► application contracts / SDK
device adapters ─────────┤          ▲
device UI panels ────────┘          │
                                   protocol codecs
                                   transport interfaces
```

More concretely:

- A protocol package imports no Hono, Bun database, React, Expo, Tamagui, HTTP
  client, filesystem, MQTT broker or Bluetooth library.
- A device model/adapter imports contracts and protocol/transport interfaces;
  it does not import the application server or Expo app.
- The server imports adapters and supplies side effects (database, sockets,
  scheduler, secrets, HTTP, audit).
- The client imports contracts, generic UI and statically bundled device panels;
  it does not import server drivers or raw protocol transports.
- The generic API client imports API contracts only. It must not import Expo,
  React Native, device-specific protocol types or P280 settings.

This makes the dependency graph boring on purpose: a weather plugin cannot
accidentally reach MODBUS writes; a MODBUS test runs without a server; and adding a
new plug does not require editing the P280 client API.

---

## Recommended packages

The repository already has useful beginnings in `packages/protocol`,
`packages/devices/aferiy-p280`, `packages/plugin-sdk`, `packages/ui` and
`packages/api-client`. Evolve them into these responsibilities rather than moving
files merely for appearance.

```text
packages/
  contracts/                         shared, platform-neutral domain contracts
  modbus/                            generic frame/CRC primitives (optional split)
  protocol-sydpower/                 Sydpower's MODBUS profile and frame semantics
  transport-contracts/               RawLink and discovery/session interfaces only
  device-sdk/                        adapter + commissioning + device-session contracts
  devices/
    aferiy-p280/
      domain/                        descriptor, settings schema, mappings, model rules
      server/                        P280 adapter/session and Sydpower link assembly
      ui/                            P280 Dashboard, Settings, Advanced panels
      test/                          simulator, captures and model contract tests
  integrations/
    tuya-local-grid-relay/           per-device relay adapter
    home-assistant-grid-relay/       alternative relay adapter
    smhi-weather/                    service plugin; no physical-device session
  api-contracts/                     Zod DTO schemas + endpoint request/response types
  api-client/                        platform-neutral `createApiClient(fetch, baseUrl)`
  api-client-expo/                   Expo URL resolution/composition only
  ui/                                reusable React/Tamagui primitives and wizard components
```

`plugin-sdk` is currently carrying device descriptors, plugin manifests,
capabilities and schemas. That is workable during the refactor, but the name
suggests that every device is a plugin. Either rename it to `@kraftverk/contracts`
or split it gradually:

- `contracts`: IDs, measurements, controls, settings schema, health, device views.
- `device-sdk`: adapter discovery/commissioning/session contracts.
- `integration-sdk`: optional weather/price/home-automation extension contracts.
- `automation-sdk` only if recipes eventually need a separate stable contract.

Do not introduce all those packages in one mechanical commit. First create clear
exports and forbid inappropriate imports; split physical folders once code has a
stable owner.

---

## Protocol packages

### What exists and what is currently mixed

`@kraftverk/protocol` already correctly centralises important logic: MODBUS frame
handling, the unusual CRC byte order, Sydpower register decoding, BLE reassembly,
station types, diagnostics and tests. It is a major improvement over keeping that
logic in `server/src`.

However, it currently combines three layers:

1. generic-ish MODBUS mechanics;
2. Sydpower wire/protocol facts; and
3. P280 product semantics such as settings, watts and model-specific scaling.

The desired split is:

```text
@kraftverk/modbus                 generic binary tools
  CRC algorithm/profile, read/write request primitives, parser helpers

@kraftverk/protocol-sydpower      hardware-family wire protocol
  slave address/profile, non-standard response layout, functions 03/04/06,
  Sydpower frame codec, known register addresses, raw register snapshots,
  BLE notification reassembly rules and captured-wire tests

@kraftverk/device-aferiy-p280     verified product interpretation
  P280 descriptor, raw-register → P280 telemetry/settings mapping,
  writable-value policy, P280 AC-charge steps, dangerous settings,
  model-specific diagnostics labels, user-facing units and UI
```

The generic `modbus` split is optional. Do it only if a second non-Sydpower
MODBUS device is added. In the short term, rename/evolve `@kraftverk/protocol`
into `@kraftverk/protocol-sydpower`, keep its public wire codec stable, and move
P280-only settings/meaning into `packages/devices/aferiy-p280/domain`.

### A protocol package must expose data, not a live connection

Good protocol API shape:

```ts
// Pure functions; byte arrays in, values/errors out.
export function buildReadInput(start: number, count: number): Uint8Array;
export function buildReadHolding(start: number, count: number): Uint8Array;
export function buildWriteHolding(register: number, value: number): Uint8Array;
export function parseSydpowerFrame(bytes: Uint8Array): ParsedFrame | ParseError;
export function decodeRegisterBlock(frame: ParsedFrame): RegisterBlock;
```

The protocol package must **not** provide `connect()`, poll timers, an MQTT broker,
environment-variable parsing, binding files, database access or Hono routes. Those
are server concerns. A direct-client BLE experiment should use the same pure codec,
but it should not pull the server into the browser bundle.

### Keep safety at two layers

The P280 package owns the authoritative model policy:

```ts
interface DeviceModelPolicy {
  validateSettingWrite(key: string, value: unknown): ValidationResult;
  encodeSettingsPatch(patch: ConfigValues): PlannedRegisterWrite[];
  decodeSettings(registers: RegisterBlock): ConfigValues;
}
```

The server action/session layer enforces it again before bytes are sent. This gives
both a model-level rule (for every future session) and a final side-effect boundary.
Never move the `register 68 != 0` protection to a client-only schema or to generic
MODBUS code; it is P280/Sydpower model knowledge and must be enforced server-side.

---

## Transport and connection ownership

The current `server/src/transport/ble.ts`, `mqtt.ts`, `mqtt/broker.ts`, driver and
binding code needs a sharper split. “Bluetooth” is not one reusable implementation:
the server uses Noble/Bun, while Expo/browser direct BLE uses different libraries and
permissions. Share abstractions and codecs, not the platform binding.

```ts
// packages/transport-contracts
interface RawLink {
  send(bytes: Uint8Array): Promise<void>;
  request(bytes: Uint8Array, expectation: ResponseExpectation): Promise<Uint8Array>;
  onNotification(listener: (bytes: Uint8Array) => void): Unsubscribe;
  health(): LinkHealth;
  close(): Promise<void>;
}
```

- **Server implementations** stay in `server/src/connections/`: Noble BLE runtime,
  embedded MQTT broker, local sockets, reconnect, process lifecycle.
- **Client implementations** stay under `client/src` until a second consumer exists;
  then move their *interfaces/helpers*, not native dependencies, into a package.
- **Sydpower topic naming and GATT service probing** belong to the P280/Sydpower
  adapter, not a generic `transport` folder.
- **`binding.ts`** is legacy singleton state. Replace it with catalog-backed
  `DeviceConnection` records managed by the server `ConnectionManager`.

The `ConnectionManager` opens one `DeviceSession` per saved server-owned device,
starts/stops polling, updates health, and closes sessions on removal/reconfiguration.
It is the only component that knows live sessions. The registry asks it for views;
the API never reaches into a global `driver` or `transport` variable.

---

## Device packages and adapters

### The P280 should be a real device package

The existing `packages/devices/aferiy-p280/src` versus `ui` split is conceptually
correct:

- non-React model/domain code can run on server and in tests;
- React/Tamagui panels must only be bundled into the client.

Make the exports explicit instead of using a vague `src` bucket:

```text
packages/devices/aferiy-p280/
  domain/     P280 model, register interpretation, settings policy, descriptors
  server/     `AferiyP280Adapter`, commissioner, `P280Session`
  ui/         `P280DashboardPanel`, `P280SettingsPanel`, `P280AdvancedPanel`
  index.ts    safe domain-only public exports
```

The current `server/src/drivers/device.ts` is P280-specific: it polls Sydpower
registers, applies P280 settings and maps P280 status. Move it gradually to the
P280 package as `server/session.ts`. The current simulator belongs beside it as a
test/dev adapter, because it simulates the P280 contract rather than the whole
application.

The package should not start itself or read environment variables. It accepts an
already created raw link/session dependency from the server.

### Smart plug adapters are per saved device

`tuya-local-grid-relay` is currently an extension with plugin-wide configuration.
That is insufficient: one installed adapter should create many independent plug
sessions, each with an IP, device ID and local key. Use the same adapter/session
contract as P280. The P280 is not “core special”; it is a built-in adapter registered
by default.

Service integrations differ:

- SMHI weather is an integration/service with one location-scoped configuration and
  a forecast capability. It does not need to masquerade as a hardware device.
- Home Assistant may be both: a service/integration that discovers and creates many
  relay device sessions.

---

## Server responsibilities

Keep these in `server/`; do not move them to packages merely because they are
reusable in theory:

- Hono composition, route registration, authentication/CORS and HTTP error mapping.
- SQLite migrations, encrypted device secrets, catalog, history and audit log.
- Adapter discovery/loading and `ConnectionManager` lifecycle.
- Background sampling, caching, scheduling and aggregation.
- The only physical-action gateway, which rechecks capability grants, device
  freshness, reserve-policy constraints, dwell times, user confirmation and readback.
- Automation/recipe orchestration, which composes saved devices by capabilities.

The server should be thin orchestration. It should not contain P280 register tables,
P280 UI labels, Tuya protocol packets, or `if (device.driver === 'core.station')`
branches in every route.

Target server shape:

```text
server/src/
  bootstrap.ts              environment and composition root
  http/                     generic route modules + auth/error middleware
  catalog/                  SQLite saved devices/connections/automations
  connections/              live DeviceSession ownership
  adapters/                 installed adapter registry
  history/                  sampling/queries
  actions/                  gateway
  automation/               recipes/policy
```

---

## APIs and API client

### Problem with the current API client

`@kraftverk/api-client` is currently a single broad barrel that includes:

- Expo host discovery (`expo-constants`, `react-native`);
- Axios instance creation;
- global legacy P280 `/status`, `/settings`, `/ports` routes;
- discovery/link routes;
- plugin host management;
- grid relay actions;
- generic device CRUD/settings/history/control;
- diagnostics.

This makes it unsuitable as a generic library and encourages a device panel to
import the whole application surface. It also hides the distinction between a
device-owned setting and app infrastructure.

### API contracts first

Create `@kraftverk/api-contracts` with Zod schemas and inferred types. It defines
request/response DTOs, error envelopes and route namespaces—not Axios or Expo.

```text
api-contracts/
  devices.ts          SavedDeviceView, create/update/remove, connection summary
  commissioning.ts    adapter catalog, wizard draft/candidate/verification DTOs
  automations.ts      recipe DTOs and role bindings
  app.ts              host/plugin installation and health (advanced only)
  p280.ts             P280 advanced diagnostics DTOs only
```

The generic device surface should be the normal path:

```text
GET    /api/devices
POST   /api/commissioning/drafts
POST   /api/commissioning/drafts/:id/discover
POST   /api/commissioning/drafts/:id/verify
POST   /api/commissioning/drafts/:id/complete
GET    /api/devices/:deviceId
PATCH  /api/devices/:deviceId
DELETE /api/devices/:deviceId
GET    /api/devices/:deviceId/dashboard
GET    /api/devices/:deviceId/settings
PATCH  /api/devices/:deviceId/settings
POST   /api/devices/:deviceId/controls/:controlId
GET    /api/devices/:deviceId/history
```

P280-only advanced capabilities sit under a device namespace, never at global
`/status` or `/settings`:

```text
GET  /api/devices/:deviceId/advanced/p280/registers
POST /api/devices/:deviceId/advanced/p280/snapshots
GET  /api/devices/:deviceId/advanced/p280/traffic
```

The server verifies that `deviceId` belongs to the P280 adapter before routing to
the advanced handler. A plug cannot call it, and a P280 panel cannot accidentally
operate the currently global station.

Keep global legacy routes temporarily as a compatibility layer only; mark them
deprecated and remove them after device-scoped routes are adopted.

### Split the client by feature, not vendor

```ts
// @kraftverk/api-client: standard TypeScript, fetch injected by caller
export function createApiClient(options: { baseUrl: string; fetch: typeof fetch }) {
  return {
    devices: { list, get, update, remove, dashboard, settings, control, history },
    commissioning: { adapters, createDraft, discover, verify, complete, cancel },
    automations: { list, create, update, remove, arm },
    app: { integrations, health },
  };
}

// Optional typed P280 feature module, used by a statically bundled P280 panel.
export function p280AdvancedApi(client: ApiClient, deviceId: SavedDeviceId) { /* ... */ }
```

`@kraftverk/api-client-expo` should contain only `resolveExpoApiBaseUrl()` and a
factory that supplies Expo/browser `fetch`. It must not be a dependency of device
packages. Device UI panels receive an injected, device-scoped `DeviceScreenContext`
with the generic device API and optional registered advanced feature APIs.

Avoid making a separate standalone “P280 HTTP client” that reimplements generic
settings/history/controls. The correct split is:

- generic API client handles universal device operations;
- a small P280 advanced feature client handles only P280-only diagnostics;
- the P280 package owns the P280 settings schema/mapping and UI, not transport HTTP.

This keeps the client narrow without duplicating infrastructure per vendor.

---

## Migration order

1. Freeze public contracts and give identifiers distinct names: `savedDeviceId`,
   `candidateId`, `providerDeviceId`, `connectionId`. Stop overloading `id`.
2. Introduce `api-contracts` and a fetch-injected API client beside the existing
   Axios client. Migrate the Devices screen first; retain compatibility wrappers.
3. Extract/evolve `protocol` to Sydpower wire code, move P280 model interpretation
   and server session into `devices/aferiy-p280` without changing test vectors.
4. Add `DeviceAdapter`/`DeviceSession` plus server `ConnectionManager`; migrate the
   one P280 global driver through it.
5. Convert Tuya from plugin-singleton configuration to per-device session instances.
6. Replace global routes and global tabs with commissioning/device-scoped routes.
7. Remove legacy global station routes and the broad client barrel only after all
   device panels use the new client.

At every stage run the existing captured-frame protocol tests plus new adapter/session
contract tests. Moving code is not validation; the P280 write guards, big-endian CRC,
serialized exchanges and verified readback semantics must remain provably intact.

## Definition of done

The package architecture is complete when adding a second device model or relay
adapter requires:

1. one adapter/device package (plus tests and optional statically registered UI);
2. zero changes to core device catalog, generic device Dashboard/Settings shell,
   action gateway and generic API-client operations;
3. no P280-specific condition in server routing; and
4. no import of React/Expo/Bun/Hono into a protocol package.
