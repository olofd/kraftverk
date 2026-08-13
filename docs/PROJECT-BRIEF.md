# kraftverk — project brief

## Purpose of this document

The complete hand-off brief for whoever works on this next. It describes what
exists, what has been learned, the owner's desired behaviour, the safety rules,
and a staged plan. Read it together with the [`README.md`](../README.md) and
[`P280-FINDINGS.md`](P280-FINDINGS.md) before changing code.

The project began as an app for one power station and is now a local energy
controller for **the devices you own**, with an AFERIY P280 as the reference
hardware and the only one verified against real firmware. Read the end-goal
section next; everything after it describes the station and its extensions in
detail.

The goal, unchanged since the start:

- prove that every supported station setting can be read and safely changed;
- document every setting and its evidence on the actual P280, rather than trusting
  a register map from a related product;
- add a controllable upstream AC smart plug so the station can run household loads
  from its battery while it is normally connected to mains;
- use solar production and conservative weather/PV forecasts to reduce unnecessary
  AC charging, while never compromising a configured energy reserve.

This must be an open-source **core + extension** product. The station application is
useful on its own; weather services, smart plugs, electricity prices, Home Assistant,
and future devices are optional integrations. No feature may assume every user owns the
same ATORCH plug, uses SMHI, lives in Sweden, or wants automation enabled.

The owner is in Sweden and primarily uses the P280 at home. It is normally left
connected to mains AC. It has two 200 W solar panels (400 W nameplate); their
observed direct-sun peak is about 300 W.

---

## The end goal: devices you own, wired together

> **The authoritative target and implementation order is
> [`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md)**, with package
> boundaries in [`MODULAR-CODE-ARCHITECTURE.md`](MODULAR-CODE-ARCHITECTURE.md).
> Where this brief and that document disagree about sequencing or navigation,
> that document wins. This section states the product intent behind it.

Three decisions settled with the owner, which the rest of the documentation must
not contradict:

**A connection's owner decides what a device can do.** Server-owned links are
first class: only the server is running when the app is closed, so only it can
sample history, hold a session and drive an automation. A client-owned Bluetooth
link is a genuine way to *use* a device — live readings, settings, manual
control — and it is not diagnostics-only. But automations and background history
require the server component, and the app must say so rather than implying a
client-only device is durable.

**Services are out of scope until they are built.** Weather, price and Home
Assistant remain plugins, not devices, and do not appear on the device canvas.
Where their own configuration lives — automation, app settings, or somewhere
else — is deliberately unanswered until the first one is written.

**Root is always the canvas; every device also has its own address.** Opening the
app lands on *Your devices* regardless of how many you own, so the shape never
changes as you add the second. Each saved device has a stable route of its own,
so it can be bookmarked or pinned and opened directly.

### Vocabulary

Three words, used precisely from here on:

```text
adapter   code that knows a protocol            "Tuya Local"        installed
device    a saved thing you own, named          "Hallway plug"      added
plugin    a service with no hardware behind it  SMHI weather        optional
```

An adapter is not a device: you add a plug, not a plugin. The Tuya relay work
built as `packages/plugins/tuya-local-grid-relay` is therefore a **device
adapter**, and needs per-saved-device instances rather than one configuration
per package — see the refactor document's Milestone C.

Everything below this section describes the station and its extensions. This section
describes what the whole thing is becoming, and every design decision should be read
against it.

### One noun: the device

The product is not "a P280 app with plugins". It is **your devices**, in one list, each
with its own screen, which you can connect to each other.

```
driver  = code that knows how to talk to something   "Tuya (local)", "core.station"
device  = a thing you own, added and named           "Hallway plug", "Aferiy P280"
```

One driver can provide many devices — a Home Assistant driver would provide dozens —
and a device outlives its driver's mood: unplug a plug for a week and it stays in the
list, greyed, with its history intact. Devices are **persisted in the database**, not
derived from whatever happens to answer a scan.

The station is a device. That is the load-bearing decision: the moment it is a special
case, every feature after it has to be built twice.

### Adding, renaming, removing, resetting

A device is something you deliberately **add**, and adding it is where the model gets
established:

1. **What kind** — a power station, a smart plug, later a weather source.
2. **Which model** — AFERIY P280, FOSSiBOT F2400, "something else". This is not
   cosmetic: the register map differs between them, and the app must not guess. The
   picker says which models are verified and which are assumed.
3. **How it connects** — for a station, WiFi/MQTT, the server's Bluetooth, or the
   browser's; for a plug, its address and key.

Full CRUD, with the destructive parts treated as destructive:

- **Rename** freely; the name is yours and survives the driver renaming things upstream.
- **Remove** with a warning that names what is lost — its history, and any automation
  that references it. "Used by: Backup reserve" appears on the device screen so that is
  visible *before* the button is pressed.
- **Reset to a blank slate** — remove everything and start again, because a setup you
  cannot undo is a setup people are afraid to try.

### Each device brings its own UI

The current P280 screens — the energy-flow dashboard, the settings with their
model-specific charge-power steps, the register diagnostics — are **P280 UI**, not app
UI. They are excellent, and they are specific. So they belong with the thing they
describe, exactly as the Tuya plug's panel already lives in its own package:

```
packages/devices/aferiy-p280/       station UI: dashboard, settings, protocol screens
packages/plugins/tuya-…/ui/         plug UI: live metering and the relay control
client/                             the shell: device list, wiring, shared primitives
```

The app becomes a **shell**: it renders the device list, the wiring, and the generic
pieces (schema forms, charts, health, setup wizards) that every device gets for free. A
device with no UI of its own is fully usable through those generics; a device with UI
of its own takes over its detail screen.

Two rules keep this from becoming a loophole:

- **Compile-time only.** A panel ships in a release or it does not exist. No downloaded
  UI, ever — an iOS build must not fetch and execute code.
- **Data and callbacks, not privileges.** A device's own screen reaches the hardware
  through the same action gateway as everything else, with the same grants, dwell,
  freshness checks and two-stage verification.

### Wiring: Lego with typed studs

Once two devices exist, you connect them. Two tiers, because "make it programmable" and
"do not cut mains at 3am" pull against each other:

- **Recipes** — whole behaviours the core implements, with **roles** you fill from a
  dropdown that only offers devices whose capabilities fit. *Backup reserve* wants a
  station and a grid relay. All the safety lives inside the recipe.
- **Rules** — one sentence for the long tail: *when the plug draws more than 2 kW for a
  minute and the pack is above 50 %, turn the plug off*. Built from what devices
  declare, executed only through the action gateway, dry-run by default.

An incompatible piece cannot be connected. That is the difference between Lego and a
rule engine with a loaded gun.

### Where this stands

| Piece | State |
| --- | --- |
| Extension system: SDK, host, action gateway, audit | **Built** |
| Tuya plug driver, simulated plug, setup wizard UI | **Built** |
| Device catalog: persisted, CRUD, model selection | **Built (server)** |
| Auto-adoption of the station at startup | **Built, and to be removed** — it makes a blank canvas impossible |
| Per-device history sampling | **Built (server)**; charts pending |
| **The P280 as a device package** — declarations *and* all four screens | **Built** |
| `@kraftverk/ui` and `@kraftverk/api-client` extracted | **Built** |
| Devices canvas, device detail, add-device wizard | **In progress** — Milestone A |
| Per-saved-device adapter instances, `ConnectionManager` | **Next** — Milestones B and C |
| Global `StationProvider` and global station tabs | **To be removed**, not extended |
| Recipes, then rules | Planned |

The package layout this produced:

```
packages/protocol        MODBUS, register map, station model
packages/plugin-sdk      the contracts: capabilities, devices, panels
packages/ui              shared primitives; Tamagui as a peer, so one theme context
packages/api-client      every endpoint, and the shapes the server sends
packages/devices/aferiy-p280   the station: what it measures, and its own screens
packages/plugins/*       drivers, one with its own panel
client                   the shell — 34-line tabs that choose whose screen to render
```

Dependencies point one way: a device package never imports from the app. Where a device
needs something from the app, the app passes it — `ProtocolScreenProps.direct` is a
*structural* type describing what the screen needs, which the app's richer object
satisfies.

The two design documents that expand this: [`PLUGIN-ARCHITECTURE.md`](PLUGIN-ARCHITECTURE.md)
for how drivers work, [`DEVICES-AND-AUTOMATION.md`](DEVICES-AND-AUTOMATION.md) for the
device model and the wiring.

---

## Desired real-world behaviour

The P280 currently prefers AC/bypass power whenever its AC input is present. Thus,
after it is charged to (for example) 60%, connecting an output load does **not**
consume battery energy; it largely pulls from the wall.

The desired feature mimics EcoFlow’s *Backup Reserve* concept externally:

```text
Grid AC → ATORCH S1W smart relay/meter → P280 AC input
2 × 200 W solar panels                         → P280 solar/DC input
P280 AC/DC/USB outputs                         → household loads
```

1. When the P280 has sufficient SOC and is delivering a meaningful load, turn the
   ATORCH relay **off**. This removes AC input, so the P280 supplies the load from
   battery and any available solar.
2. Continue until the P280 reaches a user-selected reserve SOC.
3. Turn the ATORCH relay **on** at the reserve. The P280 can then return to its
   normal AC-input/bypass and AC-charging behaviour.
4. Solar and weather forecasts should help decide whether/when AC charging is
   needed, particularly overnight. They must never override real low-battery,
   stale-telemetry, fault, or relay-failure protection.

EcoFlow DELTA 2 documents the analogous logic: above a configured backup reserve,
AC input is disabled and battery/solar is used; below it, AC charging resumes.
This project cannot change P280 bypass priority internally, so it will reproduce
the policy by controlling the upstream AC input.

Important: removing P280 AC input can cause a transfer event. Do not test with
medical, heating, security, network, or other safety/availability-critical loads.
Test first with a small non-critical load.

---

## Current codebase

### Architecture

Seven packages, plus the app and the server. Dependencies point one way: a
device or plugin package never imports from the app.

- `packages/protocol/`: framing, register map, decoding, the write whitelist and
  the polling client. No dependencies, no build step. The server and the app
  both import it, so there is exactly one implementation of what a register
  means and which writes are safe.
- `packages/plugin-sdk/`: the contracts — capabilities, the device model,
  config schemas, setup actions, panels. Types and validation only.
- `packages/ui/`: shared interface primitives. Tamagui is a *peer* dependency:
  two copies would mean two theme contexts and broken styling.
- `packages/api-client/`: every API endpoint and the shapes the server sends.
  Extracted so a device screen can read register dumps without importing the
  app's HTTP client.
- `packages/devices/aferiy-p280/`: the station — what it measures, what it can
  be told to do, what it remembers, and all four of its screens.
- `packages/plugins/`: drivers. A Tuya LAN grid relay with its own panel, and an
  in-memory plug with injectable faults for testing the action gateway.
- `client/`: Expo / React Native / react-native-web with Tamagui and
  expo-router — now a **shell**. Its tabs are 21–46 lines that choose whose
  screen to render. It can talk to the server over HTTP or hold the Bluetooth
  link itself (Web Bluetooth in a browser, react-native-ble-plx on a phone),
  running the shared `StationClient` locally.
- `server/`: Hono API on Bun. Station link over redirected MQTT or BLE, plus the
  plugin host, the action gateway, the device catalog and the history sampler.

Device names are the user's: the catalog stores whatever you rename a device to,
and it survives a driver renaming things upstream. The owner calls this setup
“F3” while the protocol research identifies the hardware as an AFERIY P280 —
which is exactly the split the catalog now models. `model` stays the verified
identity and decides how the thing is decoded; the name is presentation.

Key implementation files:

| File | Purpose |
| --- | --- |
| `packages/protocol/src/modbus.ts` | MODBUS frame build/parse and special CRC handling |
| `packages/protocol/src/registers.ts` | register map, settings decoding, safety whitelist |
| `packages/protocol/src/client.ts` | polling, serialised requests, read-only guard, writes |
| `packages/protocol/src/ble.ts` | GATT layout and frame reassembly, shared by all three BLE stacks |
| `client/src/link/` | the app's own Web Bluetooth and react-native-ble-plx transports |
| `server/src/drivers/device.ts` | the shared client, wearing the server's driver interface |
| `server/src/index.ts` | the API surface |
| `server/src/actions/gateway.ts` | **the only code allowed to switch mains** |
| `server/src/plugins/host.ts` | plugin discovery, lifecycle, config, secrets, grants |
| `server/src/devices/catalog.ts` | the devices you added, persisted |
| `server/src/history/sampler.ts` | one sample per measurement per minute, for any device |
| `packages/devices/aferiy-p280/src/index.ts` | what a P280 measures, controls and remembers |
| `packages/devices/aferiy-p280/ui/` | its dashboard, settings, protocol and energy-flow screens |
| `README.md` | protocol research, setup instructions, current API reference |

### Existing capabilities

- Simulator and real hardware drivers.
- Real P280 transports: redirected local MQTT broker and BLE.
- Polls all 80 input registers and all 80 holding registers.
- `GET /api/diagnostics/registers` emits raw, hex, named and writable register data.
- `POST /api/diagnostics/snapshot` establishes a register baseline.
- Register dumps show changed values after a baseline, enabling one-change-at-a-time
  discovery.
- `--read-only` / `READ_ONLY=1` blocks every hardware write at the device-driver
  layer; blocked attempts are logged at `GET /api/diagnostics/blocked`.
- `GET` and `PATCH /api/settings` read/apply known settings.
- UI already exposes charge limit, discharge floor, charging options, sleep/standby,
  light and panel preferences.

### Protocol facts already evidenced

- Modbus slave address is `0x11`.
- Function `0x04`: input / telemetry registers; `0x03`: holding/settings reads;
  `0x06`: single holding-register writes.
- CRC-16/MODBUS is appended **high byte first**, unlike ordinary MODBUS RTU.
  A stock MODBUS library may silently fail without this correction.
- Requests must be serialised; there is no correlation ID.
- The device needs delay between writes. Current code uses 150 ms; BLE documentation
  suggests roughly 500 ms between writes.

### Known P280 register map

Treat the following as a starting point. The original map was largely derived from
Fossibot F2400/F3600 equipment; each setting must be re-verified on this P280.

Input (read-only) registers include:

- `3`: charging power W; `4`: DC/solar input W; `6`: total input W.
- `20`: AC output W; `21`: AC input voltage in tenths of V; `22`: AC input Hz.
- `39`: total output W; `41`: state bitmask; `48`: AC charging state.
- `56`: SOC in tenths of percent; `57`: AC charging booking minutes;
  `58`/`59`: time to full / empty.

Holding registers exposed as supported settings:

| Register | Intended setting | Allowed / current understanding |
| ---: | --- | --- |
| 20 | max DC charge current | 1–20 A |
| 24 | USB output | 0 / 1 |
| 25 | DC output | 0 / 1; firmware may toggle on every write |
| 26 | AC output | 0 / 1; firmware may toggle on every write |
| 27 | LED mode | 0–3 |
| 56 | key sound | 0 / 1 |
| 57 | silent AC charging | 0 / 1 |
| 59 | USB standby | 0, 3, 5, 10, 30 min |
| 60 | AC standby | 0, 480, 960, 1440 min |
| 61 | DC standby | 0, 480, 960, 1440 min |
| 62 | screen rest | 0, 180, 300, 600, 1800 sec |
| 63 | delay charging | 0–1440 min |
| 66 | discharge lower limit | 0–500; tenths of % (0–50%) |
| 67 | AC charging upper limit | 600–1000; tenths of % (60–100%) |
| 68 | whole-unit sleep | 5, 10, 30, 480 min only |

P280-specific candidates requiring confirmation:

- Holding `14` reads 1800 and is plausibly the P280’s 1800 W AC charge ceiling.
- Input `54` is plausibly battery temperature in tenths of °C.
- Input `47`, input `62`, and holding `11` are currently unknown flags.

### Non-negotiable station safety rules

1. **Never write `0` to holding register `68`.** It reportedly permanently bricks
   the station.
2. Never write an undocumented register.
3. Do not remove or weaken `WRITABLE`, Zod validation, or tests that reject unsafe
   values.
4. Never use the raw diagnostics endpoint to probe writes. It is deliberately an
   escape hatch and must remain disabled unless `ALLOW_RAW_MODBUS=1`.
5. Treat registers `25` and `26` as toggles until their behaviour is verified on the
   actual P280; do not assume writing `1` makes a port on idempotently.
6. Begin every unfamiliar-hardware session in `--read-only` mode.
7. Do not make output-port changes while important equipment is connected.

### Current gaps to fix

- ~~Hardware writes are not proven end-to-end against this P280.~~ **Done.**
  Confirmed against the real station in write mode over BLE: LED mode (27),
  AC output (26), DC output (25) and AC charge limit (67) all written from this
  codebase and observed to take effect. Registers 25/26 toggle behaviour remains
  untested, since the driver skips redundant writes.
- A write may be sent followed by a poll whose errors are swallowed, so the UI needs
  per-setting acknowledgement and explicit readback verification—not just cached state.
- The complete register catalog has not yet been evidenced on this device.
- ~~No smart-plug integration or history database exists yet.~~ **Partly done.**
  The Tuya LAN driver, the action gateway and per-device history sampling are
  built; the plug itself is not yet commissioned, because that needs its local
  key (see [`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md)).
- No weather source, solar forecast, or automation state machine exists yet.
  The controller is designed but unwritten, and nothing may actuate on its own
  until the arming checklist below passes — including API authentication.

### System-level safety boundaries (required before automation)

This is the most important review addition. A software fail-safe cannot turn the
ATORCH relay on when the controller, router, Wi-Fi, Home Assistant, or the plug is
unreachable. Consequently, do **not** call the system fail-safe merely because it
requests AC ON; distinguish a confirmed restoration from an unconfirmed request.

Before unattended use, document and physically verify all of the following:

1. The computer/Raspberry Pi running this server, Home Assistant (if used), router,
   Wi-Fi access point, and DNS are powered independently of the P280 output, or have
   enough independent backup to remain online until AC has been restored. Avoid a
   circular design where a flat P280 turns off the controller that must restore its
   own AC charging input.
2. The S1W has a known and tested power-recovery relay state. Record whether it boots
   ON, OFF, or restores its previous state. A last-state/always-OFF device is not
   suitable for unattended battery-first operation without another recovery path.
3. There is a practical manual recovery path: accessible plug button, safe manual
   plug access, and a clear UI/emergency instruction. The owner must know it.
4. The P280’s physical discharge-lower-limit is deliberately set **below** the
   automation hard floor, leaving a recovery buffer. Example: P280 device lower
   limit 10%, automation hard floor 15%, normal reserve 30%. Verify the real P280
   behaviour before depending on it.
5. The server API is protected before it is allowed to control mains power. The
   current development API has broad CORS and no authentication. Bind it to the LAN,
   add authentication/authorisation, store secrets outside the client, and never
   expose it through router port forwarding.
6. The controller cannot distinguish a grid outage from a failed relay solely from
   “P280 AC input absent.” Model and display this as `GRID_UNAVAILABLE` after relay
   ON is confirmed but P280 AC voltage does not return. Do not relay-cycle repeatedly
   during a real grid outage.

---

## Extension architecture — open-source core, optional plugins

> The detailed design for this section, together with research into existing ATORCH/Tuya
> implementations that can be reused instead of reverse engineered, is in
> [`PLUGIN-ARCHITECTURE.md`](PLUGIN-ARCHITECTURE.md).

### Product boundary

The core product is **the station**: live status, safe settings, protocol diagnostics,
history, and manual controls for the owner’s power station. It must operate fully with
zero extensions.

Extensions may provide observation, control, or optimisation inputs:

| Extension category | Examples | Can observe | Can request actions |
| --- | --- | --- | --- |
| Weather | SMHI, Open-Meteo, Forecast.Solar | forecast/weather/PV estimate | no direct hardware control |
| Grid relay | ATORCH via HA, Shelly, Tasmota, Tuya Local | relay state, W/V/A/kWh | request grid AC on/off |
| Energy price | Nord Pool, Tibber | price forecast | influence recharge recommendation |
| Home automation | Home Assistant | entities/events | selected user-approved actions |
| Station transport | MQTT, BLE, future vendor driver | station telemetry | core-gated station settings only |

The central automation controller is the sole authority that decides whether a requested
station/relay action is safe. A plugin must never write raw MODBUS, call an arbitrary
relay endpoint, or bypass user-configured reserve/hard-floor/approval rules.

### Deployment reality: server plugins versus mobile/web UI plugins

Do not promise arbitrary runtime React-code installation in the Expo client. iOS/Expo
distribution is not an appropriate place to download and execute unreviewed UI code.

Use two extension surfaces:

1. **Server plugins** are installed by the self-hosting user as reviewed npm/workspace
   packages, discovered at server startup and loaded with a restart. They perform local
   device/API work and expose only validated data/commands to the core.
2. **Generic client extension UI** is driven by versioned manifests and JSON Schema:
   setup forms, health, data cards, consent, and standard controls work for any installed
   server plugin without shipping arbitrary client code.
3. **Custom visual panels** are compile-time client contributions. An open-source fork or
   official release may register a plugin’s React panel, but absence of that panel must
   never prevent its server integration from being configured/used.

This preserves an extensible self-hosted server while keeping iOS/web builds safe and
predictable.

### Versioned plugin manifest and lifecycle

**Built.** The SDK is `packages/plugin-sdk`; the manifest below is close to what
shipped, with `setupActions` and the device model added since. What follows
records the reasoning, and remains the specification any new capability is held
to.
Use stable reverse-DNS IDs, semantic versions, and a compatibility range—not filesystem
names as identity.

Illustrative manifest:

```ts
type PluginManifest = {
  id: string;                 // e.g. "se.smhi.weather"
  name: string;
  version: string;
  apiVersion: "1";
  kind: "weather" | "grid-relay" | "price" | "home-automation";
  capabilities: string[];     // e.g. ["weather.forecast.read"]
  configSchema: JsonSchema;   // no secrets/values in this manifest
  ui: { icon: string; setupHelp?: string; customPanel?: boolean };
};

interface AferiyPlugin {
  manifest: PluginManifest;
  validateConfig(config: unknown): ValidationResult;
  start(context: PluginContext): Promise<void>;
  stop(): Promise<void>;
  health(): PluginHealth;
}
```

`PluginContext` gives scoped facilities only: logger, SQLite namespace/migrations,
encrypted secret store, scheduler, HTTP client with timeouts, event subscription, and
typed capability registration. Do not provide unrestricted access to the station driver,
raw network clients, global database tables, or arbitrary core configuration.

Plugin lifecycle and API endpoints:

- discover installed packages at startup; validate manifest/API compatibility;
- migrations run transactionally and are namespaced by plugin ID;
- plugin status: `not-installed`, `installed`, `needs-configuration`, `starting`,
  `healthy`, `degraded`, `failed`, `disabled`;
- `GET /api/plugins` lists manifests, capability grants, health and generic UI schema;
- `GET/PATCH /api/plugins/:id/config` validates config; secret fields are write-only;
- `POST /api/plugins/:id/test` performs a side-effect-free connection/test read where
  possible; relay-control tests require explicit user confirmation;
- plugin events and action results flow to the central audit timeline;
- an incompatible or failed plugin is disabled without preventing core station control.

Keep plugin configuration in a documented export/import format **without secrets**.
Back up/restore should include extension version and non-secret configuration so an
open-source user can reproduce a setup.

### Capability and safety model

Separate signals, recommendations, intents, and commands:

```text
plugin signal          → weather forecast / relay state / price / availability
plugin recommendation  → "charge before 05:00" or "solar likely low tomorrow"
core policy decision   → checks reserve, hard floor, freshness, dwell, user mode
core command intent    → "restore grid AC", reason and required confirmation
approved plugin action → one typed relay command and verified result
```

Examples:

- The SMHI plugin can publish a forecast and confidence, but cannot turn AC off.
- An ATORCH/Home Assistant relay plugin can expose `gridRelay.set(on)`, but the command
  is accepted only through the core policy/action gateway.
- A future price plugin can recommend a cheap charging window, but the core refuses it
  if it violates the station reserve/hard-floor model.

Capabilities must be explicitly granted in the UI. The first grant for any physical
actuator requires a clear warning and two-step confirmation. Record grant/revoke changes
in the audit log. Core rule validation must apply again at execution time, not only when
the plugin is configured.

### Automation modes and composition

Expose modes owned by the core, not by individual plugins:

```text
Manual              Station monitor/settings only; no automatic external actions.
Observe             Plugins collect data and produce recommendations; no relay changes.
Reserve             Battery-first / restore-grid behavior using only live station + relay data.
Reserve + Solar     Reserve mode; actual P280 solar can influence limited hold behavior.
Forecast-aware      Reserve + Solar with an enabled, healthy weather/PV plugin; conservative only.
Scheduled / Price   Optional future mode; requires explicit price/schedule plugin and all reserve guards.
```

For each mode, render a “requirements” checklist. Example: `Reserve` needs a healthy,
configured grid-relay plugin; `Forecast-aware` additionally needs a fresh weather/PV
plugin and sufficient calibration history. If requirements disappear at runtime, degrade
to the safest compatible core mode—normally `GRID_SUPPORT`/AC restoration—not to an
unknown plugin-specific state.

Multiple plugins of the same category may be installed, but only one active provider
may control a given physical resource. Allow multiple weather sources for comparison;
the user chooses the primary forecast source, while the core retains source/provenance
on every prediction. Do not silently blend or swap providers.

### Built-in reference extensions

Implement the first two integrations as separately enabled reference plugins, not
hard-coded features:

1. `se.smhi.weather`
   - Swedish SNOW point forecast; read-only;
   - configuration: location, refresh interval, timezone; no secrets;
   - publishes weather forecast, raw SMHI metadata, freshness and confidence;
   - optional associated PV-estimator component publishes clearly labelled estimates.
2. `com.homeassistant.grid-relay`
   - connects to a selected Home Assistant switch/sensor set, enabling ATORCH S1W via
     LocalTuya/Tuya Local or any other HA-supported plug;
   - configuration: server URL, encrypted long-lived token, switch entity, optional
     power/voltage/current/kWh entities;
   - must verify state after every command and expose availability/freshness;
   - must never assume the device is ATORCH-specific.

The direct ATORCH/Tuya implementation may later be a separate `com.tuya-local.grid-relay`
plugin. It must use the same capability contract, so users can replace it with Shelly,
Tasmota, Home Assistant, or another supported actuator without changing automation logic.

### Extensions UI

**Built**, with one revision from the end-goal section: Extensions is where you
manage *drivers*, while **Devices** is where you add and use the things you own.
People add a plug, not a plugin. Add an **Extensions** area to the main app:

- catalog of installed and available reference plugins, grouped by category;
- per-plugin card with icon, description, capability badges, health, data freshness and
  last error; never show a green “connected” state for stale data;
- guided setup generated from the plugin schema, with secret inputs masked/write-only;
- test connection/action controls, activity log, disable/remove and configuration export;
- explicit capability/actuator consent screen;
- automation-mode requirements panel identifying exactly which plugin is required and
  why it is blocked/degraded.

The main Dashboard/Energy Flow stays station-first. It may show small source badges such
as “Weather: SMHI, updated 12 min ago” and “Grid relay: Home Assistant,” but plugin
configuration belongs in Extensions rather than cluttering the core station UI.

### Plugin test and documentation requirements

Every reference plugin needs:

- a README with hardware/service prerequisites, permissions, setup, local/cloud
  implications, and recovery steps;
- mocked contract tests and a simulator/fake provider for core automation tests;
- explicit offline/stale/error tests;
- versioned migration and compatibility tests;
- a sample non-secret configuration file;
- privacy documentation: what data leaves the LAN, where it goes, and how to disable it.

---

## Stage 1 — Establish a trustworthy station link

Do this before any write or automation work.

1. Run the device driver with `--read-only`.
2. Confirm discovery/binding and collect at least one hour of stable reads:
   no malformed frames, reconnect loops, unexplained timeouts, or stale values shown
   as live.
3. Improve diagnostics as necessary to display:
   - last successful input-register read and holding-register read;
   - transport errors, request/response timestamp, request hex, response hex;
   - cache age / freshness of every UI value;
   - exportable timestamped JSON/CSV register snapshots.
4. Add a local, append-only audit record for every attempted write:
   timestamp, user action, register, requested raw value, before value, frame/ack,
   after readback, duration, final result, error.
5. Never report success merely because a request was sent. A setting is *verified*
   only when its specified readback is received and matches.

Acceptance: a documented one-hour read-only session and clear diagnostics evidence.

---

## Stage 2 — Enumerate and prove every station setting

The aim is a register catalog based on this exact P280.

For each holding register `0…79`:

1. Take a baseline of *both* input and holding registers.
2. Classify it: documented writable, documented read-only, unknown, or dangerous.
3. Do not write unknown/dangerous registers.
4. For documented controls, change one thing in BrightEMS or from the P280 panel,
   then dump again. Record every changed input/holding register, raw/hex values,
   displayed value, scale/unit, side effects, and whether it survives a power cycle.
5. Add confidence: `verified`, `inferred`, `contradicted`, `unknown`, or `dangerous`.

For controlled writes, require explicit user approval before each physical test and
use this order:

1. Key sound (`56`).
2. Screen rest (`62`).
3. LED mode (`27`).
4. Silent AC charging (`57`).
5. AC charge limit (`67`) within 60–100%.
6. Discharge lower limit (`66`) within 0–50%.

For every approved write:

1. Read the current holding value directly.
2. Present the exact register/value and expected physical result to the user.
3. Send exactly one write and wait for its acknowledgement.
4. Read all holding registers again and require exact readback.
5. Confirm physical/app behaviour where applicable.
6. Store the evidence in the audit log and register catalog.
7. On timeout, mismatch, malformed/unrecognised ack, or inconsistent state: stop all
   remaining writes, mark it unverified, and show raw evidence.

Do not test AC/DC output toggles until everything above is stable and the owner has
confirmed no important loads are attached.

### Settings/API/UI completion criteria

- Define a single source of truth per setting: register, raw scale, UI unit, allowed
  values, safety level, confidence, last verification result and human explanation.
- `PATCH /api/settings` returns per-setting operation results: before, requested,
  acknowledgement, readback, verified/error. It does not merely return cached settings.
- UI shows pending / verified / failed / stale status.
- Unverified controls stay disabled by default with an explanation.
- Label holding register `67` accurately: it caps **AC charging only**; solar may
  charge beyond it, so it is not a global battery charge ceiling.

---

## ATORCH plug research and integration plan

### Exact hardware

The owner provided this listing:

> AC85-265V 16A Tuya WIFI Smart Socket Digital Wattmeter Electricity Consumption
> Power Kwh With Switch Power Energy Meter

The listing corresponds to the **ATORCH S1W Wi‑Fi** socket. It is a Tuya / Smart
Life 2.4 GHz device with an LCD meter and relay. Its meter reports voltage, current,
real power, energy (kWh), frequency and power factor.

There is an important rating discrepancy: marketing describes 16 A, whereas a reseller
specification for this S1W describes measurement up to 16 A but an **internal relay
rated at 10 A / 2650 W at 265 V**. Until the actual device label/manual establishes
otherwise, treat the relay as 10 A maximum. The P280’s claimed 1800 W AC input is
about 7.8 A at 230 V and therefore within that conservative figure, but the owner
must verify actual sustained draw and plug/outlet temperature.

The plug must be only upstream of the P280’s AC charger. Do not route P280 output
loads, extension strips, heaters, or other large loads through it.

### Integration architecture

Implement the reference relay integration as a grid-relay plugin using the shared provider abstraction in the server:

```ts
interface SmartPlugProvider {
  getState(): Promise<{
    relayOn: boolean;
    reachable: boolean;
    watts?: number;
    volts?: number;
    amps?: number;
    kwh?: number;
    updatedAt?: string;
  }>;
  setRelay(on: boolean, reason: string): Promise<CommandResult>;
  health(): Promise<HealthResult>;
}
```

Preferred control path:

1. Pair the S1W in Tuya Smart or Smart Life on a dedicated **2.4 GHz** IoT SSID.
2. Add it to Home Assistant.
3. Prefer a local Tuya integration (Tuya Local / LocalTuya) and confirm that HA has:
   a switch entity and power sensor; ideally voltage/current/kWh availability too.
4. Make this application call Home Assistant’s REST API only. Store the HA URL,
   entity IDs, and long-lived token only in server-side environment variables; never
   expose tokens to Expo/web clients.
5. Use Tuya cloud control only as an explicitly labelled fallback if local control
   cannot be proven. It is not safe to describe a cloud path as local or outage-proof.

Do not guess Tuya data-point IDs. Their DPs vary by product/firmware. Retrieve actual
S1W DPs after pairing and record ID, code/name, type, scale, unit and range. This
normally identifies the relay Boolean plus power, voltage, current, energy and any
protection/setpoint DPs.

### S1W discovery and acceptance checklist

Before an automated command is allowed:

1. Record exact model, serial/firmware, product ID, Tuya/Smart Life app, Home
   Assistant entities, DPs, local address and power-on relay behaviour.
2. Manually toggle the relay at least 20 times without critical load; every result
   must be observed and recorded.
3. Test after a brief power cut: does the relay boot on, off or restore last state?
   The application must model this explicitly.
4. With P280 and a small non-critical load, verify relay OFF removes P280 AC input
   and relay ON restores it—both with S1W measurement and P280 telemetry.
5. Test actual AC transfer interruption using a non-critical load.
6. During a normal charge cycle, observe S1W current, cable/outlet/plug temperature,
   and protection behaviour. Do not enable unattended switching if anything heats
   abnormally or input current approaches the conservative relay limit.

---

## Stage 3 — Telemetry history and solar/weather data

Build this before the controller. Use Bun SQLite and store one-minute samples:

- P280 SOC, total output W, AC output W, DC output W, solar input W, AC/grid input W,
  AC input voltage/frequency and charging state.
- S1W relay state, W, V, A, kWh, availability and last update.
- Automation state/mode/reason and every command/ack/readback.
- Weather/PV forecasts including provider and **issued-at** timestamp.

Store data in UTC; display Europe/Stockholm. Maintain raw recent data plus hourly/daily
aggregates. All data should be exportable to CSV/JSON.

### Solar configuration

Create a Solar settings schema/UI:

- latitude/longitude (server-side; explain privacy implications);
- timezone default `Europe/Stockholm`;
- nominal capacity: 400 W;
- observed practical peak: initially 300 W;
- number of panels: 2;
- tilt, azimuth (define south as 180°), and confidence level;
- optional shading notes: tree, roof/chimney, balcony, morning/evening obstruction.

Do not require perfect geometry: support `observed solar only` from P280 input telemetry
immediately. Require configuration before forecast-driven automation can be enabled.

### Weather and PV sources

Use provider interfaces; keep external API details out of the control state machine.

```ts
interface WeatherForecastProvider {
  getHourlyForecast(location, start, end): Promise<HourlyWeather[]>;
}
interface PvForecastProvider {
  getHourlyProductionEstimate(system, start, end): Promise<HourlyPvEstimate[]>;
}
```

**SMHI is the primary weather provider.** Implement it as the `se.smhi.weather`
reference plugin, with `SmhiSnowProvider` behind its typed weather capability, against
SMHI’s official SNOW point-forecast API. This is not a vague lookup: it has a defined JSON
contract, reports all times in UTC, exposes `createdTime`/`referenceTime`, selects the
nearest forecast grid point, and forecasts roughly ten days ahead.

Endpoint shape (use the owner’s configured location):

```text
https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/
geotype/point/lon/{longitude}/lat/{latitude}/data.json
```

Use a reduced `parameters` query once it has been integration-tested. Request at least:

```text
cloud_area_fraction,
low_type_cloud_area_fraction,
medium_type_cloud_area_fraction,
high_type_cloud_area_fraction,
cloud_base_altitude,
air_temperature,
precipitation_amount_mean,
probability_of_precipitation,
symbol_code,
wind_speed
```

SMHI reports cloud cover in octas (0–8); normalise it to percent for the internal
weather model, preserve the raw values, and handle documented missing values. Do not
assume every forecast time step is hourly: the forecast interval expands farther into
the future. Persist `createdTime`, `referenceTime`, requested coordinates and returned
grid-point coordinates so revisions and forecast accuracy can be measured honestly.

Fetch with bounded cadence and jitter (for example, every 30 minutes), cache results,
and save a new forecast revision only when `createdTime` changes. Validate responses
with Zod; a malformed response is a stale/unavailable forecast, never an instruction
to change the relay.

SMHI SNOW's documented point-forecast parameter list is weather-oriented; it does not
by itself provide a ready-to-use, panel-plane PV watt forecast. Therefore use it in a
two-layer solar estimator:

1. Generate a clear-sky/seasonal baseline from PVGIS plus the system geometry, then
   cap it at observed physical behaviour (400 W nameplate, about 300 W observed peak).
2. Use SMHI’s total/low/medium/high cloud cover, precipitation and weather symbols as
   inputs to a *locally calibrated and conservative* attenuation model. Train it only
   from stored P280 solar telemetry and retain a large uncertainty margin.
3. Until there is enough data, SMHI affects display and forecast confidence only; it
   cannot defer a required AC recharge.

`Forecast.Solar` can be implemented later as an optional second, independent PV forecast
for comparison. Do not silently substitute it for SMHI: show which provider/estimator
produced each estimate and compare forecasts against measured solar before trusting
either one. Open-Meteo is optional only if a secondary radiation data source is desired.

PVGIS remains for commissioning and long-term/seasonal expectation—not for the
immediate relay decision. It estimates hourly PV production using site/orientation and
radiation databases but is not a guarantee of tomorrow’s local cloud behaviour.

Cache/rate-limit all API requests. Forecast fetch failures must be non-fatal and must
reduce confidence rather than cause unsafe behaviour.

### Forecast calibration

At each hour, compare the forecast that existed *before* the hour started with the
integrated actual P280 solar Wh. Store error Wh and percent, rolling daily/7-day bias,
absolute error, and optionally error by hour/month/cloud category.

Start conservative:

```text
usableForecastWh = max(0, forecastWh × conservativeFactor − uncertaintyMargin)
```

Initial `conservativeFactor = 0.60`. Require at least 14 days of local history before
auto-calibration; do not let learning become more optimistic than observed physical
performance without review. Surface green/amber/red forecast confidence. When red
(missing/stale/poor recent accuracy), disable forecast-driven optimisation but keep
the hard safety controller working.

Weather is most valuable for **overnight grid-charge planning**. It is not the right
input for minute-by-minute safety switching: actual P280 solar watts are more reliable
than a cloud forecast, particularly for a 300 W observed peak system.

---

## Stage 4 — Energy budget and automation

### Separate user concepts

Do not overload P280 `AC_CHARGING_UPPER_LIMIT` / “AC charge limit.” It is an
AC-only device setting and solar can pass it.

The controller needs separate values:

- `hardFloorSOC`: absolute safety boundary, safely above P280 shutdown.
- `reserveSOC`: normal threshold at which AC is restored.
- `batteryStartSOC`: SOC above reserve required before battery-first begins.
- `gridRechargeTargetSOC`: desired SOC when AC has been restored.
- `forecastReserveWh`: optional extra retained energy when poor weather is forecast.
- `minimumLoadW`, `sustainedLoadDuration`.
- `minimumPlugOnDuration`, `minimumPlugOffDuration`.
- manual override and weather-optimisation enablement.

Suggested cautious defaults: hard floor 15%, reserve 30%, start battery-first 40%,
load 20 W sustained for 60 seconds, hysteresis of at least 5 SOC points, and at least
10 minutes between plug changes.

The values must be validated as a relationship, not independently:

```text
P280 physical discharge lower limit < automation hard floor < reserve SOC < battery-start SOC
P280 AC charging upper limit ≥ grid-recharge target SOC
```

Reject or clearly warn about any configuration that breaks this relationship. The
controller should normally restore AC at reserve, well before the P280's own output
cut-off; the lower device limit is only a last-resort guard.

### Energy budget

For rest of day, overnight, tomorrow morning and next 24 h calculate:

- usable battery Wh: `capacityWh × max(0, SOC - hardFloor) / 100`;
- reserve energy and projected SOC at sunrise/noon/sunset;
- load projection from configurable recent median/percentile or user-provided fixed
  essential load; never infer from one minute;
- conservative expected solar Wh;
- AC energy needed to avoid crossing hard floor/reserve before the next viable solar
  period.

Show the assumptions, not just an opaque result.

### Explicit automation state machine

```text
DISABLED       No automatic plug control.
OBSERVE        Calculate and log recommendations; never switch.
BATTERY_FIRST  S1W OFF; P280 runs from battery / real-time solar.
GRID_SUPPORT   S1W ON; P280 can bypass/charge from AC.
FORECAST_HOLD  Limited extension of battery mode due to actual solar surplus.
MANUAL_AC_ON   User-requested grid restoration; controller cannot turn it off.
FAILSAFE       Fault/stale telemetry/control failure; request AC ON and stop switching.
GRID_UNAVAILABLE  Relay is confirmed ON but grid/P280 AC input has not returned.
```

`BATTERY_FIRST` entry requires all of:

- fresh P280 telemetry and confirmed fresh S1W state;
- SOC at/above `batteryStartSOC`;
- P280 output exceeds `minimumLoadW` continuously for the configured duration;
- S1W currently on, no fault/manual override/cooldown, and minimum on-dwell elapsed.

Return to `GRID_SUPPORT` if any of:

- SOC reaches `reserveSOC`;
- projected SOC reaches hard floor before a viable solar window;
- telemetry is stale, station faults, S1W is unavailable, command/readback fails;
- user selects “Restore AC now”; maximum allowed off duration expires.

`FORECAST_HOLD` is deliberately restricted. It may delay AC restoration only while
**actual** solar input exceeds output by a configured margin for a sustained period,
SOC remains above hard floor plus buffer, and a timeout has not elapsed. Forecast alone
must not keep AC off below reserve.

Every relay transition must:

1. audit intent/reason;
2. issue one relay command;
3. confirm S1W relay state;
4. verify P280 AC-input telemetry changes in the expected direction before timeout;
5. audit verified/failed final evidence;
6. enter `FAILSAFE` after an unverified action.

On process start/restart, take no automatic relay action until both current S1W state
and fresh P280 telemetry are known. If AC was last known off and communications are
unavailable, show a prominent alert: software cannot guarantee AC restoration without
reachability to the plug.

Never automatically retry an unverified OFF transition. For an ON transition, use a
bounded retry policy only after checking dwell time and command history, then enter
`GRID_UNAVAILABLE`/`FAILSAFE`; never create a relay-cycle loop. The event record must
distinguish `AC restoration requested`, `S1W ON confirmed`, and `P280 AC present
confirmed`.

### Weather-aware policy

Start with recommendations only:

- “Tomorrow’s conservative solar estimate is X Wh; grid charging can likely wait until
  [time], subject to reserve.”
- “Poor forecast: retain/start grid support overnight to reach target SOC.”
- “Observed solar materially below forecast: reduce confidence; do not defer grid
  charge based on forecast.”

Only after 7–14 days of observe-mode evidence and at least 14 days of local forecast
calibration, permit an opt-in conservative policy:

- poor next-day forecast → charge from AC overnight to `gridRechargeTargetSOC`;
- strong next-day forecast → avoid unnecessary overnight AC charging but guarantee
  the configured morning reserve/hard floor;
- missing/poor forecast → restore grid by a user-configurable latest safe charge time;
- battery at/below reserve → restore AC regardless of forecast.

---

## UI, operational safety and acceptance

### Energy-flow dashboard — polished, physical and truthful

The Energy page should feel like a premium power-station display, not a collection of
generic cards. Build a custom responsive flow diagram in the shared Expo codebase,
preferably with SVG paths plus a native/web-compatible animation layer. Do not create
separate visual logic for iOS and web. The animation must be driven by live telemetry,
not decorative guesses.

Layout concept:

```text
       Solar panels ────────┐
                             ├──▶  [ P280 battery ] ───▶ [ AC / DC / USB outlets ]
       Grid / ATORCH ───────┘                 │
                                               └── SOC, time, state
```

Use real directional paths and small animated particles/light pulses, like water or
electrons flowing through pipes:

- solar → battery/outlets only when measured P280 solar/DC input is meaningful;
- grid → battery when AC charging is evidenced;
- grid → outlets when AC bypass is evidenced;
- battery → outlets when output exceeds input and SOC is falling;
- solar → outlets/battery may coexist with battery → outlets; show concurrent paths
  rather than pretending there is only one source;
- no flow animation when the corresponding data is zero, stale, unknown or merely
  forecast. A muted line and “Waiting for live data” is more trustworthy.

Give each path a stable semantic colour and label; never rely on colour alone:

- solar: warm yellow;
- grid/AC: cool blue;
- battery discharge: green/teal flowing outward;
- battery charging: green/teal flowing inward;
- unavailable/fault: muted grey or restrained warning colour.

Each active path must have a nearby readable value, for example `Solar 214 W`,
`Grid 0 W — relay off`, `Battery −86 W`, `AC outlets 84 W`. The sign convention
must be defined once and used throughout the app. When P280 telemetry cannot separate
bypass power from charging power with confidence, label the flow as estimated and show
the raw source (`P280` or `ATORCH`) used for it.

The central battery should show SOC, charge/discharge direction, estimated time remaining
when known, configured reserve/hard-floor markers, and current control state. Make the
reserve marker visually distinct from the device’s physical discharge limit and AC
charge ceiling. Tapping any source/path should open a compact explanation: latest raw
values, timestamp, whether it is measured/estimated/forecast, and the automation reason.

Motion-quality and accessibility requirements:

- interpolate values gently but never fabricate readings; update at telemetry cadence;
- particle speed/intensity scales with watts, with a sensible visual cap;
- respect OS reduced-motion preference: replace travelling particles with static arrows
  and numerical changes;
- maintain text contrast and non-colour status indicators; screen-reader labels must
  describe source, direction, watts, freshness and relay state;
- preserve smooth interaction on mid-range iPhones and browsers: pause/off-screen
  animations, avoid expensive re-renders, and use one shared animation clock;
- include a compact mobile layout and an expanded desktop layout;
- include skeleton, offline, stale-data and simulator states designed intentionally.

Below the live flow, show a calm 24-hour timeline: actual solar/grid/load energy to the
left of now, SMHI-based conservative forecast to the right, and projected SOC with an
uncertainty band. Clearly separate measured history from forecast using labels and line
styles, not just colour.

Create a dedicated Energy page with:

- SOC, reserve, hard floor, recharge target;
- live P280 load, solar input, grid input and S1W relay state;
- 24-hour actual/forecast solar energy chart with confidence band;
- projected SOC with/without conservative forecast solar;
- plain-language automation state/reason, next planned decision and cancellation reason;
- Dry run, Observe only, Enable automation, Restore AC now, Manual battery mode;
- event timeline and CSV/JSON export.

Every decision must be explainable. Example:

> AC remains disconnected: SOC 56%, reserve 30%, output 84 W, actual solar 210 W,
> next three-hour conservative solar estimate 430 Wh.

or:

> AC restored: SOC 29.8% reached the 30% reserve; ATORCH relay and P280 AC input
> were both verified on.

Required tests:

- setting write acknowledgement/readback/failure handling;
- threshold, hysteresis and dwell-time boundaries;
- stale/missing weather, P280 telemetry and plug data;
- forecast over- and under-prediction;
- cloud changes/daylight/overnight scenarios;
- intermittent low load;
- S1W unavailable/command failure/state mismatch;
- P280 fault and server restart with plug on/off;
- manual override/emergency restore; no relay chatter.
- controller/router/Home Assistant outage while S1W is OFF;
- S1W reboot and Wi-Fi reconnect while OFF and while ON;
- actual grid outage while S1W is ON (must become `GRID_UNAVAILABLE`, not cycle);
- wrong/missing time zone and daylight-saving transition;
- P280 inverter idle consumption and SOC/capacity error margins.

Physical acceptance before unattended automation:

1. Observe mode for at least 7–14 days.
2. Review forecast-versus-actual solar daily.
3. Test every state transition using non-critical load only.
4. Confirm AC restoration in both P280 telemetry and S1W measurement.
5. Verify plug temperature/current over normal P280 charging.
6. Start unattended operation with conservative defaults only after the audit log shows
   stable operation.
7. Perform an explicit recovery drill: intentionally leave the S1W OFF, restart every
   controller component, then prove the system either restores and verifies AC or
   clearly requires the documented manual recovery path.

---

## Interface design direction

The Dashboard is now built around a live **energy-flow diagram**, which is the
signature element of this product category — EcoFlow, Lunar Energy and MYGRID all
centre on one, and usability research on MYGRID found the flow chart and the
headline value were what users returned to several times a day.

Current implementation (`packages/devices/aferiy-p280/ui/energy-flow.tsx` — it
belongs to the device, because none of it generalises to a plug or a forecast):

- sources feed the battery from above, loads draw from below;
- each active path animates a dashed stroke toward the ring or away from it, so
  direction reads without arrowheads;
- dash speed scales with wattage, so a trickle and a fast charge look different;
- idle paths stay drawn but dim, keeping the topology stable as ports switch;
- the state-of-charge ring springs to new values, and wattages ease between
  readings rather than snapping, because 2-second telemetry otherwise flickers.

### Next interface work, in order of value

1. **Charge-limit and reserve markers on the ring.** Show the AC charge limit as a
   tick, and shade the region below the automation hard floor. The reserve concept
   is what this whole project is built around and it is currently invisible.
2. **Tap a node to drill in.** Tapping AC should expand voltage, frequency and
   per-port detail in place, rather than that living in a separate card further
   down the page.
3. **History sparklines.** Once telemetry is logged to SQLite, put a 24-hour SOC
   curve under the ring, and input/output history behind the flow tiles.
4. **Grid-relay state in the flow.** When the ATORCH plug exists, the grid path
   needs a third visual state — connected, disconnected by automation, and
   unavailable — because "no AC input" means something very different in each.
   Do not render an automation-driven disconnect the same as a power cut.
5. **Light theme pass.** Only dark has been reviewed.
6. **Motion accessibility.** Respect `prefers-reduced-motion`; the flow animation
   should degrade to a static directional indicator rather than stopping dead.
7. **Device-first testing.** The animation has only been judged in a desktop
   browser. It has to feel right on a phone, which is where it will be used.

Keep the Dashboard station-first. Forecast, price and relay extensions may add
small badges, but their configuration belongs in the Extensions area.

## Research links

- Existing project protocol sources: see `README.md`.
- [EcoFlow DELTA 2 App User Manual — Backup Reserve](https://websiteoss.ecoflow.com/cms/upload/2023/8/29/EcoFlow%20DELTA%202%20-%20App%20User%20Manual%20V1.0_1693295643575.pdf)
- [ATORCH S1W manual / product identification](https://device.report/m/0f4c63795525e741cd5ec2098faecbcdc8e00882380fe744b53d6516a9130932)
- [S1W reseller specification — includes 10 A relay statement](https://fr.sdtek.com/e/120701-6555723/)
- [Tuya data-point documentation](https://developer.tuya.com/en/docs/iot-device-dev/bluetooth_software_map_bt_dp_data?id=Kcmeae40r8zdq)
- [LocalTuya setup documentation](https://xzetsubou.github.io/hass-localtuya/usage/configure_add_device/)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Forecast.Solar API](https://forecast.solar/)
- [SMHI SNOW point-forecast API](https://opendata.smhi.se/metfcst/snow1gv1/get_point_forecast)
- [SMHI SNOW parameter catalog](https://opendata.smhi.se/metfcst/snow1gv1/parameters)
- [European Commission PVGIS API](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en)
- [Open-Meteo forecast API fields](https://open-meteo.com/en/docs)

## Definition of done

The work is complete only when:

1. Each supported P280 setting is backed by real-P280 write/readback evidence and has
   clear UI status.
2. The P280 and S1W integration has an auditable, verified, safe control path.
3. Automation is off by default, explainable, hysteretic and fails safely.
4. Weather/PV forecasts are calibrated from real solar telemetry, treated
   conservatively, and never used to violate battery safety thresholds.
5. The owner can understand current state, expected behaviour, data freshness and the
   exact reason for every relay action.
6. The independent-power, recovery-path, API-security and grid-outage acceptance
   checks above have passed; a mere software request to turn AC on is not accepted as
   proof that mains was restored.
7. A second device — the plug, and later a weather source — is added, used and
   wired to the station **without a screen being written for it**. That is the
   test of whether the device model is real: if adding one still needs bespoke
   UI, the abstraction has not earned its keep.
