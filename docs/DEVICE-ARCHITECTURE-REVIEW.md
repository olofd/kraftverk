# Architecture review: everything is a device

**Status:** review and plan, September 2026. Nothing here is built yet.
**Scope:** how devices, protocols, extensions, capabilities and services are modelled in the code today, where that falls short of the goal below, and a step-by-step plan to get there.
**Relation to existing docs:** [`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md), [`MODULAR-CODE-ARCHITECTURE.md`](MODULAR-CODE-ARCHITECTURE.md), [`PLUGIN-ARCHITECTURE.md`](PLUGIN-ARCHITECTURE.md) and [`DEVICES-AND-AUTOMATION.md`](DEVICES-AND-AUTOMATION.md) already describe parts of this target. They overlap, use different words for the same things, and none of them is fully implemented. This document takes one position, maps it onto the code as it is, and proposes that it replaces the device-model parts of those four (step 0).

---

## 1. The goal

In the owner's words, reduced to rules:

1. **Everything you add is a device.** A power station, a smart plug, a microwave, a weather service. No separate "extension" concept for the user to learn.
2. **A device type is a plugin.** Each supported product (or product family) is one self-contained package that a contributor can add without touching the core. The app finds the installed types and shows them; nothing lists devices by hand.
3. **A device type speaks a protocol, and protocols are shared.** Sydpower MODBUS, Tuya local and so on each live in one package that any number of device types can use.
4. **Every device exposes the same three things:**
   - **telemetry**: typed metrics over time, such as battery level or power use;
   - **capabilities**: typed things it can do or report, such as switch on/off, measure power, provide a forecast;
   - **settings**: its own configuration.
5. **Each device type owns its setup guide**, written in code: how to find it, what credentials it needs, how to confirm it works.
6. **Services are devices without hardware.** Weather is added the same way and exposes telemetry and capabilities the same way.
7. **Automations connect capabilities**, not specific products: "when the weather forecast says sun, turn on this switch".

The concrete end state:

> Add my AFERIY P280 → add my ATORCH S1W plug → add my other smart plug → add a weather service → create an automation: "if tomorrow is sunny, turn the plug on."

Each of these should be a separate package in code, and none of them should require editing the server, the API client or the app shell.

---

## 2. What already points the right way

Much of the groundwork exists and should be kept:

| Already in place | Where | Why it matters |
|---|---|---|
| Devices are saved records you add, not scan results | `server/src/devices/catalog.ts` | The catalog is the right backbone |
| Distinct identity types: `SavedDeviceId`, `ProviderDeviceId`, `StationId` | `packages/plugin-sdk/src/identity.ts` | The compiler keeps "which device" questions honest |
| A generic device description: `DeviceDescriptor` with `MeasurementSpec[]`, `ControlSpec[]`, a settings schema | `packages/plugin-sdk/src/device.ts` | This is already "telemetry + controls + settings" |
| A small declarative form language, `ConfigSchema` | `packages/plugin-sdk/src/schema.ts` | Setup forms and settings can be rendered generically |
| History sampling that knows nothing about device kinds | `server/src/history/sampler.ts` | Every device gets charts for free |
| One gate for physical actions: grants, dwell time, audit, verification | `server/src/actions/gateway.ts` | The right place for safety, but too narrow today |
| The P280 has its own package with a UI folder | `packages/devices/aferiy-p280` | The shape of a device plugin, half done |
| Tuya plug models described as data (`DeviceProfile`: data-point map and scaling) | `packages/plugins/tuya-local-grid-relay/src/profiles.ts` | "ATORCH is a Tuya device with this profile" is almost expressed already |
| Pure protocol code with tests (MODBUS, CRC, register decoding) | `packages/protocol` | Reusable once split correctly |

The problem is not missing ideas. It is that **two half-built systems live side by side**, and the first device (the P280) was built before either of them.

---

## 3. How the code models things today

```
                         ┌──────────────────────────── server ────────────────────────────┐
  P280 ("core.station")  │ hard-imported · StationDriver · ConnectionManager (stations only)│
  packages/devices/…     │ /p280/* routes · STATION_MODELS list · broker · legacy import    │
                         ├─────────────────────────────────────────────────────────────────┤
  Tuya, Fake relay       │ PluginHost scans packages/plugins · one config per plugin        │
  packages/plugins/…     │ capabilities gridRelay.* · "active provider" · grant · gateway   │
                         └─────────────────────────────────────────────────────────────────┘
                         ┌───────────────────────────── app ──────────────────────────────┐
                         │ screens.ts: BY_DRIVER['core.station'] → P280 screens            │
                         │ panels.ts:  PANELS['com.tuya-local.grid-relay'] → Tuya panel    │
                         │ "Your devices" (catalog)   vs   "Extensions" (PluginHost)       │
                         └─────────────────────────────────────────────────────────────────┘
```

So there are:
- **two registries on the server**: the built-in P280 and the plugin host;
- **two registries in the app**: device screens keyed by driver, and plugin panels keyed by plugin id;
- **two places a user configures a device**: Your devices, and Settings → Extensions.

### The question from the brief: how does a user tell an Extension from a Device?

**They can't, because the difference is an internal implementation detail.** A Tuya plug today is:

1. an **extension** ("Tuya smart plug (local)"), holding the plug's IP address, device ID and local key, its enable switch, its permission grant and its "active provider" choice; and
2. a **device** in Your devices, which holds only a name. Its configuration is ignored, and it shows whatever the extension's single plug reports (`registry.ts:129`, `devices?.()[0]`).

The user has to set up the plug in the extension and then *also* add it as a device, in a different part of the app. The words make it worse. The code, the docs and the app variously call the same thing a *plugin*, *extension*, *adapter*, *driver* or *provider*, and the handover doc defines "plugin" as "a service like weather", which is the opposite of how the code uses it.

---

## 4. Where the code falls short of the goal

Each item names the evidence and the step in section 6 that fixes it.

### F1 — The P280 is special-cased throughout the core · critical

`core.station` and `power-station` appear in about 30 places outside the P280 package. P280 and station types (`StationStatus`, `StationSettings`) appear in over 70 places in the server, the app and the shared packages.

| Where | What is P280/station-specific |
|---|---|
| `server/src/devices/registry.ts:126`, `:192` | `if (record.driver === 'core.station')`, plus a whole `#stationView` |
| `server/src/connections/manager.ts:201` | Live connections exist only for `type === 'power-station'` |
| `server/src/drivers/types.ts:12` | The only driver interface is `StationDriver`: `status(): StationStatus`, `setPort(PortId)` |
| `server/src/transport/types.ts` | The server's transport layer is typed in stations: `StationId`, `StationLink` |
| `server/src/index.ts:1488`, `:1499` | Routes `/devices/:id/p280/state` and `/p280/settings` duplicate the generic settings routes |
| `server/src/index.ts:1648` | The control route: `if (found.record.driver === 'core.station')` |
| `server/src/index.ts:133` | `RELAY_STATION_KEY`: a global "which station does the relay feed" |
| `server/src/index.ts:1316`, `devices/legacy.ts` | Import of a station saved by an older version |
| `server/src/broker/*` | An MQTT broker whose topics, policy and journal are Sydpower-specific, inside the server |
| `client/src/devices/screens.ts:28` | `DeviceScreens` is *typed as* `typeof StationDashboard` |
| `client/src/features/devices/connection.tsx:81` | `isStation = driver === 'core.station'`; the hook returns P280 status and settings |
| `client/src/state/DevicesProvider.tsx:361` | Builds a fake `core.station` record for the in-app Bluetooth link |
| `client/src/state/DirectLinkProvider.tsx` (879 lines) | In-app Bluetooth that only knows the P280 |
| `packages/api-client/src/api.ts:158` onwards | Old global `/status`, `/settings`, `/ports`, `/grid` calls, plus P280 types in shared DTOs |

**Consequence:** a second device of the same importance, say a second brand of power station, can't be added without editing the server, the app and the API client.

### F2 — A list of power stations that aren't really supported · high

`STATION_MODELS` (`server/src/devices/catalog.ts:58`) is a hand-written list of eight models. Only one is verified. Choosing any of the others changes nothing, because every model is read as a P280. The add-device list (`/device-types`, `index.ts:1353`) is also built by hand: one hard-coded "Power station" entry plus plugins filtered by `kind === 'grid-relay'`.

**Target:** the add-device screen lists the **installed device types**, read at runtime. A model that isn't supported has no package and doesn't appear. A model that is "probably the same" gets a small package that reuses the P280's code with its own differences (for example the F2400's charging scale), marked *experimental*.

### F3 — A device type can have only one instance · high

Extension configuration is per plugin, not per device. The Tuya plugin's `configSchema` (`packages/plugins/tuya-local-grid-relay/src/index.ts:31`) holds `host`, `deviceId` and `localKey` for exactly one plug. The catalog record's own `config` is never passed to the plugin. **You cannot add a second Tuya plug**: two device records with the Tuya driver would both show the same one. This directly blocks "add the ATORCH *and* another smart plug".

### F4 — Capabilities are named after one use, not after what the device can do · high

`packages/plugin-sdk/src/capabilities.ts`:
- `gridRelay.read`, `gridRelay.switch`: a plug is modelled as "the relay that feeds the station". Switching a lamp or a heater is not a "grid relay".
- `station.ports: never`: declared, never implemented. The P280's outputs don't go through capabilities at all.
- `weather.forecast: unknown`, `pv.forecast: unknown`, `price.forecast: unknown`: declared with no contract.
- `Resource = 'gridRelay'`, `ACTUATOR_CONFIRMATION = 'switch-grid-relay'`, and "active provider" (only one plugin may be *the* grid relay).

Automations can't be built on this. An automation needs "any device that can **switch**" and "any service that can **forecast weather**". "Feeds the station's AC input" is a *link* between two devices, set up in an automation. It is not the plug's identity.

### F5 — Closed lists of kinds in the shared contracts · medium

- `DeviceType = 'power-station' | 'smart-plug'` (`catalog.ts:18`, plus `z.enum` at `index.ts:1388`).
- `DeviceKind` has five values (`device.ts:17`).
- `PluginKind = 'grid-relay' | 'weather' | …` (`plugin.ts:14`).
- The add screen assumes a type: `chosen.id === 'power-station' ? 'power-station' : 'smart-plug'` (`add-device.tsx:65`).

A contributor adding a microwave would have to edit core unions in three packages. A *category* ("kitchen appliance") should be free-form metadata for display. *Behaviour* should come from capabilities.

### F6 — Protocols are not reusable units · medium

- `@kraftverk/protocol` mixes three layers:
  - generic MODBUS and CRC;
  - Sydpower's wire format (slave 0x11, register blocks, BLE reassembly, MQTT topics);
  - **P280 meaning**: `StationStatus`, `StationSettings`, port ids, write rules, and a whole polling client, `StationClient`.
- The Tuya protocol (`frame.ts`, `session.ts`, `crypto.ts`, `discovery.ts`) is locked inside the *plugin* package `tuya-local-grid-relay`. A second Tuya-based device type couldn't reuse it without depending on a "grid relay" plugin.
- The server's BLE and MQTT layer, and the MQTT broker process, are Sydpower runtimes that live in the core.

### F7 — Setup is spread across three places · medium

- Tuya: a plugin-wide 5-step wizard in Extensions, driven by `setupActions`.
- P280: added on one screen, then connected to the physical station on another (App settings → Station link, `link.tsx`), or picked automatically ("auto-bind").
- There is no *setup guide* contract that a device type provides and the app renders the same way for every device.

### F8 — Telemetry has no shared names · medium

The P280 reports `soc`, `inputWatts`, `acOn`. Tuya reports `watts`, `volts`, `relay`. `MeasurementSpec.kind` (power, percent…) is a good start, but nothing says "this metric is the battery's state of charge" or "this is the power this device draws". So an automation can't say "when *any* battery is below 20 %", and charts can't compare devices.

### F9 — The app has no general way to show a device · medium

- Device screens are looked up by the driver string. Anything that isn't the P280 falls back to a partial generic view (`panels.tsx`).
- A second registry (`client/src/plugins/panels.ts`) maps *plugin* ids to *setup* panels.
- Neither is populated from the installed packages. Both are edited by hand, and the `kraftverk.device` and `kraftverk.panel` fields in the P280's `package.json` are read by nothing.

### F10 — The safety gateway only understands one relay · medium

`ActionGateway` executes exactly one thing: switch *the* grid relay, then check against *the* paired station. Port switches on the P280 bypass it entirely (they go straight to `driver.setPort`). For automations to be safe, every capability command must go through one gateway with a safety level per capability: safe, confirm first, or dangerous. The relay/station check should become a rule attached to the automation that pairs them.

### F11 — Services have no home · low (but it's the next feature)

There is no weather or other service implementation. The plugin kinds list `weather` and the capability exists as `unknown`. Under the current model, weather would become an "extension", repeating F3–F4.

### F12 — Structural debt that blocks the refactor · medium

- `server/src/index.ts` is a 1,700-line file that wires everything and starts the hardware as soon as it's loaded, so routes can't be tested (see the [code audit](audits/2026-09-code-audit.md), A1).
- There are four overlapping architecture documents plus a handover with conflicting vocabulary.
- No automated rule stops the core from importing a device package, so the boundary erodes silently.

---

## 5. The target model

### 5.1 Vocabulary (one word each, used everywhere)

| Term | Meaning | Example |
|---|---|---|
| **Device type** | A package that knows one product or product family. What contributors write. | `@kraftverk/device-aferiy-p280`, `@kraftverk/device-atorch-s1w` |
| **Protocol** | A package that knows a wire format, shared by device types. No product meaning. | `@kraftverk/protocol-sydpower`, `@kraftverk/protocol-tuya-local` |
| **Device** | One thing the user added: an instance of a device type, with its own name, settings and credentials. | "Garage P280", "Heater plug" |
| **Service** | A device type with `kind: 'service'` (no hardware). Added and shown the same way, in its own section. | "Weather (Open-Meteo)" |
| **Telemetry** | Named, typed metrics a device reports over time. | `battery.soc`, `power.in` |
| **Capability** | A typed interface a device offers: things you can command or read. | `switch`, `powerMeter`, `battery`, `outlets`, `weather.forecast` |
| **Setup guide** | The steps a device type uses to create a device: find, authenticate, verify. | Scan the LAN, fetch the local key, test the relay |
| **Automation** | A rule that connects telemetry and capabilities across devices, through the gateway. | "Sunny tomorrow → switch on Heater plug" |

"Extension", "plugin", "adapter", "driver" and "provider" retire as user-facing words. "Plugin" can stay as a code word for "an installable package", which covers device types and protocols.

### 5.2 A device type package

```
packages/devices/atorch-s1w/
  package.json          "kraftverk": { "deviceType": "./src/index.ts", "ui": "./ui/index.ts" }
  src/index.ts          export default defineDeviceType({...})     ← server-safe, no React
  src/session.ts        talks to the device through @kraftverk/protocol-tuya-local
  src/setup.ts          the setup guide
  src/simulator.ts      a fake device, used by tests and "try without hardware"
  ui/index.ts           optional custom panels (lazy); the generic view is used otherwise
  assets/               icon.svg, product.webp
  test/contract.test.ts runs the shared contract suite against this type
```

A sketch of the contract, in a new `@kraftverk/device-sdk`. It evolves from `plugin-sdk` rather than starting fresh:

```ts
export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  id: string;                        // 'atorch.s1w', stable and namespaced
  apiVersion: '2';
  kind: 'hardware' | 'service';
  meta: {
    name: string; brand?: string; models?: string[];
    category: string;                // free text for display: 'power-station', 'smart-plug', 'weather'
    support: 'verified' | 'community' | 'experimental';
    icon: string; image?: string; docsUrl?: string;
  };
  protocols: string[];               // ['tuya-local'], for display and dependency checks
  capabilities: CapabilityName[];    // what every instance offers
  telemetry: MetricSpec[];           // standard metric ids where they exist (§5.4)
  controls?: ControlSpec[];          // presentation of capability commands
  settings?: ConfigSchema;           // the device's own settings, read and written live
  config: ConfigSchema;              // per-device connection config; secrets marked
  setup: SetupGuide<Config>;         // §5.5
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
}

export interface DeviceSession {
  health(): ConnectionHealth;
  readings(): Reading[];                                  // latest telemetry, from cache
  subscribe?(listener: (r: Reading[]) => void): Unsubscribe;
  capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null;
  readSettings?(): Promise<ConfigValues>;
  writeSettings?(patch: ConfigValues): Promise<ConfigValues>;
  close(): Promise<void>;
}

export interface DeviceContext<Config> {
  deviceId: SavedDeviceId;
  config: Config;                    // this device's own config, not a type-wide one
  secrets: { get(field: keyof Config): string | null };
  store: KeyValueStore;              // per device
  log: Logger;
  http: ScopedHttp;
  transports: TransportRuntime;      // BLE radio, MQTT broker, UDP… provided by the server
  schedule(everyMs: number, task: () => Promise<void>): void;
}
```

Two points in this sketch matter most:
- `config` is **per device** (fixes F3);
- the session exposes **capabilities**, not P280 methods (fixes F1 and F4).

### 5.3 Capabilities: a small standard library

Each capability has a typed interface, a safety level and standard telemetry. Keep the set small and add to it deliberately:

| Capability | Interface (sketch) | Safety | Standard telemetry |
|---|---|---|---|
| `switch` | `state(): boolean`, `set(on)` | confirm when turning off, if declared critical | `switch.on` |
| `powerMeter` | `read(): { watts, volts?, amps?, kwh? }` | read-only | `power.draw`, `energy.total` |
| `battery` | `read(): { socPercent, capacityWh }` | read-only | `battery.soc`, `battery.capacity` |
| `outlets` | `list()`, `set(outletId, on)` | confirm when turning off a loaded outlet | `outlet.<id>.on`, `outlet.<id>.power` |
| `acInput` | `read(): { present, watts }` | read-only | `grid.present`, `power.in.ac` |
| `weather.forecast` | `hourly(hours): WeatherHour[]` (temperature, cloud cover, precipitation, irradiance) | read-only | `weather.temp`, `weather.cloud` |

- A **P280** offers `battery`, `outlets`, `acInput` and `powerMeter`.
- An **ATORCH S1W** offers `switch` and `powerMeter`.
- A **weather** service offers `weather.forecast`.
- A **microwave**, if someone writes one, offers `switch` and perhaps `timer`.

Nothing in the core knows any of those products.

### 5.4 Telemetry: standard names, with local additions

`MetricSpec` = today's `MeasurementSpec`, plus a `metric` field that uses a standard id when one applies (`battery.soc`, `power.draw`, `power.in.solar`…). Device-specific metrics are namespaced (`p280.inverterHz`). History, charts and automations key off the standard ids. The generic dashboard can then show "Battery 68 %" for any device that has `battery.soc`.

### 5.5 Setup guides in code

```ts
setup: {
  steps: [
    { kind: 'instructions', title: 'Put the plug in pairing mode', body: '…', image: 'assets/pairing.webp' },
    { kind: 'discover', title: 'Find it on your network', run: (ctx) => scanLan(ctx) },       // returns candidates
    { kind: 'form', title: 'Local key', schema: keyForm, help: 'Fetch it from the Tuya cloud once…',
      actions: [{ id: 'fetchKey', label: 'Fetch from Tuya cloud', run: fetchKeyFromCloud }] },
    { kind: 'verify', title: 'Test the switch', run: (ctx) => readOnce(ctx) },                // must pass
  ],
}
```

The app renders every guide with one wizard. The server runs the steps against a **draft** device and saves it only once `verify` passes. A P280 guide is: choose the connection (Wi-Fi through the server, or Bluetooth) → pick your station from what the server can see → verify. That removes the Station link screen and "auto-bind" (F7).

### 5.6 How the pieces connect at runtime

```
                        installed packages (scanned at start; bundled for the app)
                 ┌────────────────────────┬──────────────────────┬──────────────────────┐
                 │ device-aferiy-p280     │ device-atorch-s1w    │ service-open-meteo   │
                 │  uses protocol-sydpower│  uses protocol-tuya  │  uses http only      │
                 └──────────┬─────────────┴──────────┬───────────┴──────────┬───────────┘
                            ▼                        ▼                      ▼
server:  DeviceTypeRegistry ──► DeviceSessionManager (one session per saved device, any type)
                                   │ readings            │ capabilities
                                   ▼                     ▼
                              Sampler/History      ActionGateway (per-capability safety, audit)
                                   │                     ▲
                                   └──► AutomationEngine ┘  (triggers on telemetry → commands capabilities)
app:     /api/device-types → Add device (renders setup guide) · generic device view + optional panels
```

---

## 6. Step-by-step plan

Each step can be shipped and tested on its own, and keeps the app working. The P280's safety guards (never write 0 to register 68, the write whitelist, read-only mode, pinned writes) and their tests carry through every step unchanged.

### Step 0 — Agree the words and retire overlapping docs · S

- Adopt the vocabulary in §5.1.
- Make this document the authority for the device model. Mark the device-model sections of the four older docs as superseded, and fix the handover's vocabulary.
- **Done when** there's one glossary, and the app's visible text uses "device" and "service" only.

### Step 1 — Guardrails before moving code · S

- Add an import-boundary check (for example `dependency-cruiser`, or an ESLint `no-restricted-imports` config) that fails CI when `server/src`, `client/src`, `packages/api-client` or `packages/ui` import from `packages/devices/*` or `packages/protocol-*`. The only exception is one generated registry file per side (step 3).
- Add a "leak counter" test that counts `core.station|p280|StationStatus` outside device packages and may only go down. Today it's well over 100.
- Split `server/src/index.ts` into `createApp(deps)` plus route modules, so the routes the refactor touches can be tested ([code audit](audits/2026-09-code-audit.md) A1).
- **Done when** CI shows the boundary check and the counter, and the route tests run.

### Step 2 — Contracts: `device-sdk` · M

- Create `@kraftverk/device-sdk` with `DeviceType`, `DeviceSession`, `DeviceContext`, `SetupGuide`, `MetricSpec` (with standard metric ids) and the capability standard library (§5.3). Move `MeasurementSpec`, `ControlSpec`, `ConfigSchema` and the identity types into it. Keep `plugin-sdk` as a re-exporting shim for one release.
- Replace the closed unions (`DeviceType`, `DeviceKind`, `PluginKind`) with `category: string` plus capabilities.
- Write the **contract test suite**, `runDeviceTypeContract(type)`. It checks that the manifest is valid, the simulator session starts, telemetry matches the declared metrics, every declared capability is implemented, and settings round-trip.
- **Done when** the SDK builds and the contract suite runs against a trivial example type.

### Step 3 — Discover device types; delete the hand-written lists · M

- **Server:** a `DeviceTypeRegistry` scans `packages/devices/*` and `packages/services/*` for `package.json → kraftverk.deviceType`, validates the API version, and loads the type. It replaces the plugin host's device side.
- **API:** `GET /api/device-types` returns every installed type: meta, support level, capabilities, config schema, the setup guide's steps (without the functions) and image URLs. It replaces `/device-types`.
- **Delete** `STATION_MODELS` (`catalog.ts:58`) and the hand-built `/device-types` (`index.ts:1353`). Models become device types: `aferiy.p280` (verified), and experimental types only where someone has written the differences.
- **App:** Metro can't discover packages at runtime, so a small build step (`npm run gen:devices`) writes `client/src/generated/device-types.ts`, importing each package's `ui` entry lazily. That generated file is the *only* place the app imports device packages. It replaces `screens.ts` and `plugins/panels.ts`.
- **Done when** the add-device screen is rendered entirely from `/api/device-types`, and adding a package with no other edits makes it appear.

### Step 4 — Per-device sessions for every device · L

- Replace `ConnectionManager`'s station-only rule (`manager.ts:201`) with a `DeviceSessionManager`. It opens `type.createSession(ctx)` for **every** saved device, with that device's own config and secrets (`device_secret` table keyed by device id).
- The server provides shared runtimes through `ctx.transports`: the BLE radio, the MQTT broker connection, UDP. Device types don't open radios themselves.
- **Migration:**
  - `device.driver = 'core.station'` → `type_id = 'aferiy.p280'`;
  - each plugin's config and secrets → the config of the matching device record;
  - drop `plugin_config` for device types.
- **Done when** the registry has no `if (driver === …)` branches, and two devices of the same type run side by side.

### Step 5 — The P280 becomes an ordinary device type · L

- Split `@kraftverk/protocol`:
  - `protocol-sydpower`: the MODBUS framing, big-endian CRC, register-block codec and BLE reassembly as it is today, plus the Sydpower MQTT topic scheme, with the captured-frame tests unchanged;
  - move `StationStatus`/`StationSettings`, ports, write rules and the polling client into `devices/aferiy-p280/src`.
- Move `server/src/drivers/*` (the station driver and simulator) into the P280 package as its session and simulator. The station's outputs become the `outlets` capability, its battery the `battery` capability, its AC input the `acInput` capability.
- Delete `/devices/:id/p280/state` and `/p280/settings`. The generic `/devices/:id` (readings), `/settings` and `/capabilities/…` routes cover them. The register tools become **type-provided advanced routes**, mounted under `/devices/:id/advanced/*` by the registry only for types that declare them.
- The MQTT broker stays a separate process (it has to survive server restarts). It is started by the server's transport runtime when an installed protocol asks for it, not hard-wired, and its Sydpower topic policy moves to `protocol-sydpower`.
- Retire the legacy-import code and `RELAY_STATION_KEY` (their job moves to step 8).
- **Done when** the leak counter is 0 in `server/src`, and the P280 passes the contract suite.

### Step 6 — Tuya as a protocol; ATORCH and your other plug as device types · M

- Extract `protocol-tuya-local` from the plugin: frame, session, crypto, discovery, and the cloud key fetch.
- `device-atorch-s1w`: the ATORCH `DeviceProfile` becomes this type's mapping to `switch` and `powerMeter`, plus its setup guide (scan the LAN → fetch or enter the local key → test the relay, including the "data point 1 or 131" check) and its product image.
- `device-tuya-generic-plug`: the generic profile, for your other plug if it's Tuya-based. A non-Tuya plug gets its own protocol package, and nothing else changes.
- Delete `packages/plugins/tuya-local-grid-relay`, `fake-grid-relay` (it becomes the ATORCH simulator), the Extensions screen and the plugin panels registry.
- **Done when** you can add the ATORCH and a second plug, each with its own address and key, both working at once.

### Step 7 — One gateway for every command · M

- Every capability command, from the UI or an automation, goes through `POST /devices/:id/capabilities/:capability/:command` and the gateway. That includes P280 outlet switches, which bypass it today.
- Each capability declares a safety level. The gateway applies:
  - confirmation;
  - dwell time per device, not one global value;
  - read-only mode;
  - fresh-data checks, using the "unknown is not a value" rule from the code audit (A2);
  - an audit entry.
- Verification becomes pluggable. A capability can verify itself (read back the switch state), and an automation can attach cross-device checks (§ step 8).
- **Done when** `gridRelay.*`, `Resource`, the "active provider" concept and the global confirmation phrase are gone.

### Step 8 — Services: weather first · S–M

- `services/open-meteo` (no API key; or SMHI for Sweden) as `kind: 'service'`, offering `weather.forecast` and telemetry (`weather.temp`, `weather.cloud`, `weather.irradiance`). Its setup guide is "choose location → verify".
- The app shows services in their own section on Home, added through the same add flow.
- **Done when** weather appears as a service with history charts, with no core changes beyond generic service display.

### Step 9 — Automations · L

- Build an `AutomationEngine`:
  - **triggers**: telemetry thresholds, forecast conditions, time;
  - **conditions**;
  - **actions**: capability commands.
- Automations reference **devices and capabilities**, never device types. The editor only offers devices that have the capability a slot needs.
- Build in order: fixed **recipes** first ("Charge when sunny", "Keep the station above X % from the grid"), then rules.
- The current relay-feeds-station logic becomes a recipe: *switch* (the plug) feeds *acInput* (the station), with verification "after switching, the station's `grid.present` must match within 30 s".
- **Done when** "if tomorrow is sunny, turn on the ATORCH" can be created in the app and runs through the gateway with an audit trail.

### Step 10 — Make contributing easy · S

- Two scaffolding commands: `npm run new:device -- my-brand-plug` (a template package with a simulator and contract test) and `npm run new:protocol`.
- A `docs/ADDING-A-DEVICE.md` guide: package layout, contract, setup guide, image guidelines, test checklist, support levels.
- CI runs the contract suite for every package in `packages/devices/*` and `packages/services/*`.

### What the order buys

| After step | You can… |
|---|---|
| 3 | see supported devices listed dynamically; the fake model list is gone |
| 4–5 | treat the P280 as a normal device; the core has no P280 code |
| 6 | add the ATORCH and another plug, each fully independent (your first goal) |
| 7 | switch anything safely through one path |
| 8 | add a weather service |
| 9 | connect them: "sunny → switch on" (your end goal) |

Steps 1–3 are also worth doing on their own: they stop the leak getting worse while the larger moves happen.

---

## 7. Decisions to make before step 2

1. **Where "which station a plug feeds" lives.** Recommended: in the automation or recipe that pairs them, not on either device.
2. **In-app Bluetooth (no server).** Keep it as an *optional client-side session* that a device type may declare (`clientTransports: ['web-ble']`), reusing that type's own session code. Or freeze it until after step 6. Recommended: freeze. Today it's 879 lines of P280-only code, and every step above gets easier without it.
3. **Unverified station models.** Remove them from the list (recommended), or ship them as `experimental` types that reuse the P280 code with overrides, each needing a named owner who has the hardware.
4. **Package location for services.** `packages/services/*` (recommended, clearer to contributors), or `packages/devices/*` with `kind: 'service'`.
5. **Plugin trust.** Device types run inside the server with full access (the code audit's S7). That's fine for packages in this repo. Decide now that outside packages are out of scope until there's process isolation.

---

## 8. Checklist: the architecture is done when…

- [ ] Adding a new device type means adding one package. No edits to `server/src`, `client/src`, `packages/api-client` or `packages/ui`.
- [ ] `GET /api/device-types` lists exactly the installed packages, and the add screen renders from it.
- [ ] Two devices of the same type, each with its own config and secrets, run at once.
- [ ] No `core.station`, `p280`, `StationStatus`, `gridRelay` or `power-station` identifier appears outside `packages/devices/aferiy-p280`. This is enforced in CI.
- [ ] Every command goes through `/devices/:id/capabilities/...` and the gateway.
- [ ] Every device type has a setup guide, a simulator and a passing contract test.
- [ ] Weather is a service offering `weather.forecast`.
- [ ] An automation connecting a forecast to a switch runs end to end with audit entries.
- [ ] The app never says "extension", "plugin", "driver", "adapter", "bind" or "transport".
