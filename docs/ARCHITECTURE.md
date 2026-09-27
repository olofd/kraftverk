# Architecture: everything is a device

**Status:** the authority for how devices, protocols, capabilities, services
and automations are modelled, in code and in the database. Adopted September
2026 from the architecture review, with the changes recorded in §9.

**Replaces** the device-model parts of
[`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md),
[`MODULAR-CODE-ARCHITECTURE.md`](MODULAR-CODE-ARCHITECTURE.md),
[`PLUGIN-ARCHITECTURE.md`](PLUGIN-ARCHITECTURE.md),
[`DEVICES-AND-AUTOMATION.md`](DEVICES-AND-AUTOMATION.md) and the vocabulary in
[`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) and [`HANDOFF.md`](HANDOFF.md). Those
remain useful for research and history — the Tuya protocol notes, the P280
findings, the UX sketches — but where they disagree with this document, this
document is right.

Progress is tracked in §8; every step says what "done" means, and CI enforces
the parts a machine can check (§7).

---

## 1. The goal

1. **Everything you add is a device.** A power station, a smart plug, a
   microwave, a weather service. There is no second concept for the user to
   learn.
2. **A device type is a package.** Each supported product or product family is
   one self-contained package that a contributor adds without touching the
   core. The server and the app find the installed types; nothing lists them by
   hand.
3. **Protocols are shared packages.** Sydpower MODBUS, Tuya local and so on each
   live in one package that any number of device types use.
4. **Every device exposes the same three things:** telemetry (typed metrics over
   time), capabilities (typed things it can do or report), and settings (its
   own configuration).
5. **Each device type owns its setup guide,** in code.
6. **Services are devices without hardware.** Weather is added the same way and
   exposes telemetry and capabilities the same way.
7. **Automations connect capabilities,** never products: "when the forecast
   says sun, turn on this switch".

The end state, each step one package and no edits to the core:

> Add my AFERIY P280 → add my ATORCH S1W plug → add my other smart plug → add a
> weather service → create an automation: "if tomorrow is sunny, turn the plug
> on."

---

## 2. Vocabulary

One word for each thing, in code, in docs and on screen.

| Term | Meaning | Example |
|---|---|---|
| **Device type** | A package that knows one product or product family. What contributors write. | `@kraftverk/device-aferiy-p280` |
| **Protocol** | A package that knows a wire format, shared by device types. No product meaning. | `@kraftverk/protocol-tuya-local` |
| **Device** | One thing the user added: an instance of a device type, with its own name, config and secrets. | "Garage P280", "Heater plug" |
| **Service** | A device type with `kind: 'service'`: no hardware. Added and shown the same way, in its own section. | "Weather (Open-Meteo)" |
| **Telemetry** | Named, typed metrics a device reports over time. | `battery.soc`, `power.draw` |
| **Capability** | A typed interface a device offers: things you can command or read. | `switch`, `battery`, `weather.forecast` |
| **Setting** | Something the device itself remembers across a power cycle. | A charge limit, a standby timer |
| **Config** | How the server reaches a device: address, keys. Never leaves the server as secrets. | A plug's IP and local key |
| **Setup guide** | The steps a device type uses to create a device: find, authenticate, verify. | Scan the LAN, fetch the key, read once |
| **Link** | A physical fact connecting two devices, recorded by the user. | "This plug feeds that station's AC input" |
| **Automation** | A rule that connects telemetry and capabilities across devices, through the gateway. | "Sunny tomorrow → switch on the heater plug" |
| **Session** | A running connection to one device, owned by the server. | — (internal) |

Retired: **extension**, **adapter**, **driver** and **provider** as names for
anything, and **plugin** on screen. "Plugin" survives only in prose, for "an
installable package". The app never says extension, plugin, driver, adapter,
bind or transport.

---

## 3. Packages and the dependency rule

```
packages/
  device-sdk/            contracts only: DeviceType, DeviceSession, capabilities, metrics, schema
  protocols/sydpower/    @kraftverk/protocol-sydpower   MODBUS framing, CRC, register blocks, BLE, MQTT topics
  protocols/tuya-local/  @kraftverk/protocol-tuya-local frames, session, crypto, discovery, cloud key fetch
  devices/aferiy-p280/   @kraftverk/device-aferiy-p280  a device type
  devices/atorch-s1w/    @kraftverk/device-atorch-s1w
  devices/tuya-plug/     @kraftverk/device-tuya-plug    the generic Tuya energy socket
  services/open-meteo/   @kraftverk/service-open-meteo  a service
  api-client/  ui/       shared by the app; know no device type
server/  client/         the core; know no device type
```

The rule, checked in CI by `npm run check:architecture` (§7):

- **The core** — `server/src`, `client/src`, `client/app`,
  `packages/api-client`, `packages/ui`, the SDK — never imports a device type,
  a service or a protocol package. The exceptions are one generated registry
  file per side (`server/src/generated/`, `client/src/generated/`), written by
  `npm run gen:devices` from the installed packages.
- **A device type** imports the SDK, protocols, and — in its `ui/` folder only —
  `@kraftverk/ui`, `@kraftverk/api-client`, React and Tamagui (peer
  dependencies). Never the server or the app.
- **A protocol** imports nothing from kraftverk but other protocols. It has no
  idea what a P280 is.

### A device type package

```
packages/devices/atorch-s1w/
  package.json          "kraftverk": { "deviceType": "./src/index.ts", "ui": "./ui/index.ts" }
  src/index.ts          export default defineDeviceType({...})   server-safe, no React
  src/session.ts        talks to the device through its protocol package
  src/setup.ts          the setup guide
  src/simulator.ts      a fake device: tests, and "try without hardware"
  ui/index.ts           optional custom panels; the generic view is used otherwise
  assets/               icon.svg, product.webp
  test/contract.test.ts the shared contract suite, run against this type
```

---

## 4. The contract: `@kraftverk/device-sdk`

```ts
export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  id: string;                        // 'atorch.s1w' — stable forever, namespaced
  apiVersion: '2';
  kind: 'hardware' | 'service';
  meta: {
    name: string; brand?: string; models?: string[];
    category: string;                // free text for display: 'power-station', 'smart-plug', 'weather'
    support: 'verified' | 'community' | 'experimental';
    icon: string; image?: string; docsUrl?: string;
  };
  protocols: string[];               // ['tuya-local'], for display and dependency checks
  capabilities: CapabilityName[];    // what every device of this type offers
  telemetry: MetricSpec[];           // standard metric ids where they exist (§4.2)
  controls?: ControlSpec[];          // how capability commands are presented
  settings?: SettingsSpec;           // what the device remembers, read and written live
  config: ConfigSchema;              // per-device connection config; secrets marked
  setup: SetupGuide<Config>;         // §4.3
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
}

export interface DeviceSession {
  health(): ConnectionHealth;
  readings(): Reading[];                                   // latest telemetry, from cache
  capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null;
  readSettings?(): ConfigValues | null;                    // null until read — never defaults
  writeSettings?(patch: ConfigValues): Promise<ConfigValues | null>;
  close(): Promise<void>;
}

export interface DeviceContext<Config> {
  deviceId: SavedDeviceId;
  config: Config;                    // this device's own, validated
  secrets: { get(field: keyof Config & string): string | null };
  store: KeyValueStore;              // this device's own
  log: Logger;
  http: ScopedHttp;
  transports: TransportRuntime;      // BLE radio, MQTT broker, UDP — owned by the server
  schedule(everyMs: number, task: () => Promise<void>): void;  // cancelled on close
  readOnly: boolean;                 // the server refuses every hardware write
}
```

Two properties carry the design: config is **per device**, and a session
exposes **capabilities**, never product methods.

### 4.1 Capabilities: a small standard library

Each capability has a typed interface, a safety level the gateway enforces, and
the standard telemetry it implies. The set grows deliberately, one reviewed
addition at a time.

| Capability | Interface (sketch) | Safety | Standard telemetry |
|---|---|---|---|
| `switch` | `state()`, `set(on)`, `bootBehaviour()` | confirm turning off when critical | `switch.on` |
| `powerMeter` | `read(): { watts, volts?, amps?, kwh? }` | read-only | `power.draw` |
| `battery` | `read(): { socPercent, capacityWh }` | read-only | `battery.soc` |
| `outlets` | `read()`, `set(outletId, on)` | confirm turning off when critical | `outlet.<id>.on`, `outlet.<id>.power` |
| `acInput` | `read(): { present, watts }` | read-only | `grid.present` |
| `weather.forecast` | `hourly(hours): WeatherHour[]` | read-only | — |

"Critical" is decided by the gateway at the time: a switch whose device feeds
another through a link, or an outlet carrying a load. Every read is stamped
with when the device produced it, and null is unknown — never off, never zero.
The library lives in `packages/device-sdk/src/capabilities.ts`.

A P280 offers `battery`, `outlets` and `acInput`. Not `powerMeter`: that is a
meter on what flows *through* a device, a plug's; a station's own input and
output are its `power.in` and `power.out` telemetry. An ATORCH S1W offers
`switch` and `powerMeter`. A weather service offers `weather.forecast`.
Nothing in the core knows any of those products.

### 4.2 Telemetry: standard names, local keys

A `MetricSpec` is a measurement (`key`, label, unit, kind, precision) plus an
optional `metric`: the standard id it means, when one applies.

- **`key` is what is stored.** History is keyed by `(device, key)`, and a key
  never changes once a type has shipped — renaming one would orphan its
  history. Keys are local to a type: the P280's `soc`, a plug's `watts`.
- **`metric` is what it means.** `battery.soc`, `power.draw`, `power.in.solar`.
  The generic dashboard, charts across devices and automations use it. A metric
  with no standard id is namespaced by its type (`p280.inverterHz`) or has none.

Standard ids start small and grow only when something needs them:
`battery.soc`, `battery.capacity`, `power.in`, `power.in.ac`, `power.in.solar`,
`power.out`, `power.draw`, `energy.total`, `voltage.ac`, `grid.present`,
`switch.on`, `weather.temp`, `weather.cloud`, and `outlet.<id>.on` and
`outlet.<id>.power` for each outlet. `weather.irradiance` arrives with step 8,
with the measurement kind it needs. A standard id has one unit and kind, and a
type that claims it must use them, so two devices share an axis without
conversion; `validateDeviceType` checks it.

### 4.3 Setup guides

```ts
setup: {
  steps: [
    { kind: 'instructions', title: 'Put the plug in pairing mode', body: '…', image: 'assets/pairing.webp' },
    { kind: 'discover', title: 'Find it on your network', run: scanLan },        // returns choices
    { kind: 'form', title: 'Local key', fields: ['localKey'],
      actions: [{ id: 'fetchKey', label: 'Fetch from Tuya cloud', run: fetchKey }] },
    { kind: 'verify', title: 'Read it once', run: readOnce },                    // must pass
  ],
}
```

The app renders every guide with one wizard. The server runs the steps against
a **draft** — config not yet saved — and creates the device only when `verify`
passes. A guide may offer **save anyway** after a failed verify when failure is
expected, as it is for a station that is asleep; the device then says "not
answering yet" until it wakes. Secrets a step finds stay on the server; the app
sees a short-lived placeholder (see [SECURITY.md](SECURITY.md)).

### 4.4 Links between devices

Some facts are about the house, not about any one device: *this plug's output
feeds that station's AC input*. They are recorded as **links**, not as part of
either device and not inside an automation, because several things need them:

- the gateway, whose second proof after switching a feeding plug is the linked
  station's `grid.present` (§4.6);
- the energy-flow view;
- any number of automations.

A link has a kind, and the kind says which capabilities each end needs:

| Kind | From | To | Means |
|---|---|---|---|
| `feeds` | a device with `switch` | a device with `acInput` | switching the source switches the target's mains |

One source feeds at most one target. Forgetting either device removes the
link. Links replace the global "which station does the relay feed" key.

### 4.5 The data model

The catalog is the backbone. A device exists because the user added it, and it
keeps its history while it is unplugged.

```sql
device        (id PK, type_id, name, config JSON, added_at)
device_secret (device_id → device ON DELETE CASCADE, field, value, encrypted,  PK (device_id, field))
device_kv     (device_id → device ON DELETE CASCADE, key, value,               PK (device_id, key))
device_link   (id PK, kind, source_id → device, target_id → device, created_at, UNIQUE (kind, source_id))
sample        (device_id, key, at, value,                                       PK (device_id, key, at))
automation    (id PK, name, recipe, params JSON, enabled, created_at)           -- step 9
audit, app_state, users, sessions                                              -- unchanged
```

- **Ids are opaque and permanent.** Existing ids (`power-station:3db445e0`) are
  kept verbatim: history is keyed by them. New ids carry no meaning.
- **`type_id` is immutable.** Changing what a device *is* means adding a new
  one; its history would not mean the same thing.
- **`config` is validated** against the type's `config` schema on every write.
  Secrets are never in it.
- **Retired by the migration** (§8, step 4): `device.type`, `device.model`,
  `device.driver`, `plugin_config`, `plugin_secret`, `plugin_kv`,
  `active_provider`, and the `relay.stationDeviceId` app-state key.

**Every migration is safe for the owner's real data:**

1. The server copies the database (`VACUUM INTO`) beside itself before it
   applies any migration to a database that already has data, and says where.
   Rolling back is stopping the server and putting the copy back.
2. Each migration runs in one transaction; a failure changes nothing.
3. A migration that moves data is rehearsed against a copy of the real
   database before it ships (`npm run db:rehearse -- <copy>`), on the owner's
   machine — the data never leaves it.

### 4.6 The gateway: every command, one path

Every capability command — from a screen or an automation — goes through
`POST /api/devices/:id/capabilities/:capability/:command` and the action
gateway. It applies, per device and per capability:

- the capability's safety level: confirmation when needed;
- read-only mode;
- dwell time, per device;
- fresh data: acting needs readings younger than the policy allows, and an
  unknown value is never read as a value;
- verification: the capability's own readback, plus the rules its links add —
  switching a plug that `feeds` a station is verified by that station's
  `grid.present` changing, from a reading taken after the switch;
- an audit entry naming the account or automation.

### 4.7 At runtime

```
                   installed packages (discovered at start; generated registry for the app)
            ┌───────────────────────┬──────────────────────┬──────────────────────┐
            │ device-aferiy-p280    │ device-atorch-s1w    │ service-open-meteo   │
            │  protocol-sydpower    │  protocol-tuya-local │  http only           │
            └──────────┬────────────┴──────────┬───────────┴──────────┬───────────┘
                       ▼                       ▼                      ▼
server:  DeviceTypeRegistry ──► DeviceSessionManager (one session per saved device, any type)
                                   │ readings            │ capabilities
                                   ▼                     ▼
                              Sampler / history    ActionGateway ◄── device links
                                   │                     ▲
                                   └──► AutomationEngine ┘
app:     /api/device-types → add a device (renders its setup guide) · generic device view + optional panels
```

The MQTT broker stays a separate process, because stations must stay connected
while the server restarts. The server's transport runtime starts it when an
installed protocol needs it; its topic policy belongs to `protocol-sydpower`.

---

## 5. Safety rules that survive every step

These are not up for refactoring. Their tests move with the code and stay
green at every commit.

- Holding register 68 is never written 0: it permanently bricks the station.
  The whitelist, the schema and the tests that assert it stay.
- The write whitelist, read-only mode, and "read fresh, then write, in one
  turn" for the P280's toggling output registers.
- Physical actions go through the action gateway and nowhere else.
- Unknown is unknown: no reading is invented, no setting is defaulted in place
  of a value never read.
- Device packages are trusted code, from this repository only. Packages from
  elsewhere are out of scope until device types can run in a process of their
  own (see [SECURITY.md](SECURITY.md)).

---

## 6. Where the code stands

What the review found, and which step fixes it.

| | Finding | Step |
|---|---|---|
| F1 | The P280 is special-cased throughout the core: `core.station`, `StationStatus`, `/p280/*` routes, `isStation` in the app | 3–7 |
| F2 | `STATION_MODELS`: eight models, one verified, all decoded as a P280; a hand-built `/device-types` | 3 |
| F3 | Config is per plugin, so a type can have one device: `registry.ts` takes `devices()[0]` | 4 |
| F4 | Capabilities named after one use: `gridRelay.*`, the "active provider", one confirmation phrase | 2, 6 |
| F5 | Closed unions of kinds: `DeviceType`, `DeviceKind`, `PluginKind` | 2–3 |
| F6 | `@kraftverk/protocol` mixes MODBUS, Sydpower and P280 meaning; Tuya is locked inside a plugin | 5, 7 |
| F7 | Setup spread over three screens; no setup-guide contract | 3–5 |
| F8 | No standard telemetry names | 2 |
| F9 | Two hand-edited app registries; `kraftverk.device` and `kraftverk.panel` read by nothing | 3 |
| F10 | The gateway knows one relay; P280 outputs bypass it | 6 |
| F11 | Services have no home | 8 |
| F12 | Nothing stops the boundary eroding | 1 |

---

## 7. Guardrails in CI

`npm run check:architecture` (`scripts/architecture.mjs`) fails the build when:

- **the dependency rule** (§3) is broken by a new import;
- **the leak count** rises: the number of product-specific identifiers —
  `core.station`, `p280`, `StationStatus`, `StationSettings`, `power-station`,
  `gridRelay` — in shipped files outside `packages/devices/aferiy-p280`.
  Tests are held to the dependency rule but not counted: a test that drives
  the real station through a core route moves with that route.

Both are held by a baseline, `scripts/architecture-baseline.json`, listing
today's exceptions file by file. It may only shrink: a file whose count falls
fails the check too, until `npm run check:architecture -- --update` records the
lower number, so the baseline always says exactly where the leaks are. Moving a
file moves its leaks, which per file looks like a new one; `-- --rebaseline`
accepts that, and refuses if either total rose. A deliberate exception —
code that must reach a product for now, and will leave with it — is an edit
to the baseline made in the open, with its reason in the commit. At the end
of step 7 the baseline is empty.

---

## 8. The plan

Each step ships on its own, keeps the app working, and keeps the deployed
station working. The order puts the new model under the plugs first — small,
not yet in daily use, and two of them side by side are the real test of
per-device config — and moves the P280, the only device in production, last,
once the model has carried two real device types.

| Step | | Size | Status |
|---|---|---|---|
| 0 | Words and one authority | S | done |
| 1 | Guardrails | S | done |
| 2 | Contracts: `device-sdk` | M | done |
| 3 | Discover device types | M | |
| 4 | Per-device sessions, config, secrets and links | L | |
| 5 | Tuya as a protocol; the ATORCH and the generic plug as device types | M | |
| 6 | One gateway for every command | M | |
| 7 | The P280 as an ordinary device type | L | |
| 8 | Services: weather first | S–M | |
| 9 | Automations | L | |
| 10 | Make contributing easy | S | |

### Step 0 — Words and one authority
This document; banners on the ones it replaces. **Done when** there is one
glossary (§2).

### Step 1 — Guardrails
The dependency check and the leak ratchet in CI (§7); the database copied
before any migration (§4.5). Splitting the server into `createApp` and route
modules, with route tests, was done in the code audit. **Done when** CI runs
the check.

### Step 2 — Contracts: `device-sdk`
- `plugin-sdk` becomes `@kraftverk/device-sdk` in one move — every user is in
  this repository, so there is no shim.
- `DeviceType`, `DeviceSession`, `DeviceContext`, `SetupGuide`, `MetricSpec`
  with standard metric ids, and the capability library (§4.1). The closed
  unions give way to `category: string` plus capabilities.
- The contract suite, `runDeviceTypeContract(type)`: the manifest is valid, the
  simulator session starts, telemetry matches what is declared, every declared
  capability is implemented, settings round-trip.

**Done when** the SDK builds and the suite passes against an example type.

*Done.* The SDK is `packages/device-sdk`: `DeviceType`, `DeviceSession` and
`DeviceContext` in `device-type.ts`, the capability library in
`capabilities.ts`, metric specs and standard ids in `telemetry.ts`, setup
guides in `setup.ts`, the static checks in `validate.ts`, and the contract
suite as `@kraftverk/device-sdk/testing` (`checkDeviceTypeContract`). Every
type must ship a simulator (`createSimulator`). The v1 extension contract
lives on in `src/v1/`, its capabilities renamed `PluginCapability`, until the
plugins are gone. Controls already speak the new capability names — the P280's
ports are `outlets`, a plug's relay is `switch` — and telemetry carries its
standard ids.

### Step 3 — Discover device types
- **Server:** a `DeviceTypeRegistry` finds `kraftverk.deviceType` in
  `packages/devices/*` and `packages/services/*`, checks the API version and
  loads the type. The P280 is registered as a type from here on, through a
  thin session over today's station code — nothing about how it runs changes.
- **API:** `GET /api/device-types` returns every installed type: meta, support,
  capabilities, config schema and setup steps without their functions.
- **Deleted:** `STATION_MODELS`, the hand-built list. Unverified models are
  gone until someone with the hardware writes their type.
- **App:** `npm run gen:devices` writes `client/src/generated/device-types.ts`,
  the only place the app imports device packages, replacing `screens.ts` and
  `plugins/panels.ts`. The add screen renders from `/api/device-types`.

**Done when** adding a package with no other edit makes it appear in the app.

### Step 4 — Per-device sessions, config, secrets and links
- A `DeviceSessionManager` opens `type.createSession(ctx)` for **every** saved
  device, with that device's own config and secrets. Shared runtimes — the BLE
  radio, the broker, UDP — come through `ctx.transports`.
- The migration (rehearsed first): `driver` and `type` become `type_id`; each
  plugin's config and secrets become its device's; the relay pairing becomes a
  `feeds` link; the retired tables go (§4.5).
- Links: the table, the API and a screen to set "this plug feeds that station".

**Done when** the registry has no `if (driver === …)` and two devices of one
type run side by side.

### Step 5 — Tuya as a protocol; the ATORCH and the generic plug
- `protocol-tuya-local`: frame, session, crypto, discovery and the cloud key
  fetch, out of the plugin.
- `device-atorch-s1w` and `device-tuya-plug`: `switch` and `powerMeter`, each
  with its setup guide — scan → key → read once, including the ATORCH's
  "relay on datapoint 1 or 131" check — and a simulator.
- Deleted: `packages/plugins/*` (the fake relay becomes the ATORCH simulator),
  the Extensions screen and the plugin panel registry.

**Done when** the ATORCH and a second plug, each with its own address and key,
work at once.

### Step 6 — One gateway for every command
Everything in §4.6. The P280's outputs go through it too, via the `outlets`
capability of its step-3 session. **Done when** `gridRelay.*`, `Resource`, the
active provider and the global confirmation phrase are gone.

### Step 7 — The P280 as an ordinary device type
- `@kraftverk/protocol` splits: MODBUS framing, CRC, register blocks, BLE
  reassembly and the MQTT topics become `protocol-sydpower`, their captured-frame
  tests unchanged; `StationStatus`, settings, ports, write rules and the polling
  client move into the P280 package.
- `server/src/drivers/*` becomes the P280's session and simulator. Its setup
  guide replaces the Station link screen and auto-bind: choose Wi-Fi or
  Bluetooth → pick your station from what the server sees → verify.
- `/devices/:id/p280/*` goes; the register tools become type-provided routes
  under `/devices/:id/advanced/*`. The broker's topic policy moves to the
  protocol, and the broker is started when an installed protocol asks for it.
- The legacy one-station import goes.

**Done when** the leak baseline is empty and the P280 passes the contract suite.

### Step 8 — Services: weather first
`services/open-meteo` (no key), `kind: 'service'`, offering `weather.forecast`
and weather telemetry, set up by choosing a location. Shown in its own section
on Home. **Done when** it has history charts and needed no core change beyond
showing services.

### Step 9 — Automations
An `AutomationEngine`: triggers (telemetry thresholds, forecast conditions,
time), conditions, and capability commands as actions — through the gateway.
Automations name devices and capabilities, never types; the editor offers only
devices with the capability a slot needs. Recipes first ("charge when sunny",
"keep the station above X % from the grid"), rules after. **Done when** "if
tomorrow is sunny, turn on the ATORCH" is created in the app and runs with an
audit trail.

### Step 10 — Make contributing easy
`npm run new:device` and `npm run new:protocol` scaffolds, a
`docs/ADDING-A-DEVICE.md` guide, and the contract suite run in CI for every
device type and service.

---

## 9. Decisions

1. **Which station a plug feeds** is a link between devices (§4.4) — a fact
   about the house that the gateway, the energy-flow view and automations all
   read — not part of either device, and not inside one automation.
2. **In-app Bluetooth** (the app holding a station itself) is frozen: it keeps
   working as it is, and nothing new is built on it until step 7 is done.
3. **Unverified station models** are removed. One comes back as its own type,
   reusing the P280's code, when someone with the hardware writes it.
4. **Services** live in `packages/services/*`, found by the same discovery.
5. **Trust:** device types come from this repository only (§5).
6. **Order:** the plugs move before the P280 (§8), unlike the review, which
   moved the P280 first.
7. **Metric keys** stay as stored; standard ids are a mapping on top (§4.2), so
   no history is rewritten.

---

## 10. The architecture is done when…

- [ ] Adding a device type means adding one package: no edits to `server/src`,
      `client/src`, `packages/api-client` or `packages/ui`.
- [ ] `GET /api/device-types` lists exactly the installed packages, and the add
      screen renders from it.
- [ ] Two devices of one type, each with its own config and secrets, run at once.
- [ ] The leak baseline is empty, enforced in CI.
- [ ] Every command goes through `/devices/:id/capabilities/…` and the gateway.
- [ ] Every device type has a setup guide, a simulator and a passing contract test.
- [ ] Weather is a service offering `weather.forecast`.
- [ ] An automation connecting a forecast to a switch runs end to end, audited.
- [ ] The app never says extension, plugin, driver, adapter, bind or transport.
