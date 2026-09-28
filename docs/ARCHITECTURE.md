# Architecture: everything is a device

**Status:** the authority for how devices, protocols, capabilities, services
and automations are modelled, in code and in the database. Adopted September
2026 from the architecture review, with the changes recorded in §9.
[`DATA-MODEL.md`](DATA-MODEL.md) is its companion and the authority for
the data model: the add-a-device flow screen by screen, the definitions
it uses and the records it leaves behind, with diagrams.

**Every other document agrees with this one.** The earlier design documents —
the device-first refactor, the modular code architecture, the plugin
architecture, and devices and automation — were removed on 2026-09-28 once this
replaced them. Their research lives on where it belongs: the Tuya protocol and
the ATORCH in [`ATORCH-S1W.md`](ATORCH-S1W.md), the P280 in
[`P280-FINDINGS.md`](P280-FINDINGS.md), and the product intent — recipes,
rules, the reserve controller — in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). If a
document ever disagrees with this one, the other document is wrong and is
fixed.

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
5. **A device is reached through connection methods it declares:** each a
   protocol over a transport, set up by steps the layers supply, and held by
   the server or by the app, with the same code either way.
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
| **Category** | What a person would call a thing, from a fixed list in the SDK. For finding things on the add screen, never for behaviour. | Power stations, Smart plugs, Weather |
| **Device type** | A package that knows one product or product family: what its values mean. Models of a family are profiles, as data. What contributors write. | `@kraftverk/device-aferiy-p280` |
| **Transport** | A package that moves bytes or messages and finds devices, with one implementation for each place it can run. Knows nothing of what it carries. | `@kraftverk/transport-mqtt`, `-ble`, `-lan`, `-https` |
| **Protocol** | A package that knows a wire format and how it rides each transport it supports. Pure code, no I/O and no product meaning. | `@kraftverk/protocol-sydpower`, `-tuya-local` |
| **Connection method** | One protocol over one transport, declared by a device type, with the setup steps the layers supply. It says nothing about where it runs. | the P280's `wifi` (sydpower over mqtt) and `bluetooth` (sydpower over ble) |
| **Holder** | Where a connection is held: the server, or one client. It offers a method wherever it has the transport. | "your server", "Olof's iPhone" |
| **Client** | One phone or browser running the app, known to the server. | "Chrome on the laptop" |
| **Device** | One thing the user added: an instance of a device type, with its own name, config and identity. | "Garage P280", "Heater plug" |
| **Identity** | A device's own permanent id, read from the device. What makes one station found two ways a single device. | `sydpower:AABBCC001122` |
| **Connection** | One way a device is reached: a method, a holder and an address, with its own secrets. A device may have several; one is in use at a time. | Garage P280 over Wi-Fi, held by the server |
| **Sighting** | Something a transport can see that no connection claims. Live state, never stored. | "A power station is connected to this server" |
| **Service** | A device type with `kind: 'service'`: no hardware. Added and shown the same way, in its own section. | "Weather (Open-Meteo)" |
| **Telemetry** | Named, typed metrics a device reports over time. | `battery.soc`, `power.draw` |
| **Capability** | A typed interface a device offers: things you can command or read. | `switch`, `battery`, `weather.forecast` |
| **Setting** | Something the device itself remembers across a power cycle. | A charge limit, a standby timer |
| **Config** | Non-secret choices stored with a device (the type's) or a connection (the method's). Secrets are stored apart and never leave their holder. | A plug's profile; a Tuya protocol version |
| **Setup** | The steps from choosing a category to a saved device (DATA-MODEL.md §1). Each method's steps are assembled from its transport, protocol and type. | Scan the LAN, fetch the key, read once |
| **Link** | A physical fact connecting two devices, recorded by the user. | "This plug feeds that station's AC input" |
| **Automation** | A rule that connects telemetry and capabilities across devices, through the gateway. | "Sunny tomorrow → switch on the heater plug" |
| **Session** | A running connection to one device, in whichever holder has it in use. | — (internal) |

Retired: **extension**, **adapter**, **driver** and **provider** as names for
anything, **plugin** on screen, and the **grid relay** as a thing: it was a
role, and is now a smart plug with a `feeds` link. "Plugin" survives only in
prose, for "an installable package". The app never says extension, plugin,
driver, adapter, bind, transport or protocol. It names methods the way people
do: "Wi-Fi, through your server", "Bluetooth, from this phone"; the screen
about them is *Connectivity*. Hardware keeps its own names — a DC charger, a
Bluetooth radio — and so do the ones people know, such as MQTT.

---

## 3. Packages and the dependency rule

```
packages/
  device-sdk/            contracts only: categories, capabilities, link kinds, metrics, schema,
                         DeviceType, ConnectionMethod, Transport, Protocol, DeviceSession
  transports/mqtt/       @kraftverk/transport-mqtt       the broker (its own process) and the server's client; server only
  transports/ble/        @kraftverk/transport-ble        server (noble), web (Web Bluetooth), native (the phone)
  transports/lan/        @kraftverk/transport-lan        TCP and UDP on the home network; server only for now —
                                                         a native entry needs a socket library, a reviewed dependency
  transports/https/      @kraftverk/transport-https      the internet, address-scoped; everywhere
  protocols/sydpower/    @kraftverk/protocol-sydpower    MODBUS-style frames, CRC, register blocks, the register-68 rule;
                                                         bindings for mqtt (topics, broker policy) and ble (service, framing)
  protocols/tuya-local/  @kraftverk/protocol-tuya-local  frames, crypto, handshake, discovery packets, the local key;
                                                         a binding for lan
  protocols/open-meteo/  @kraftverk/protocol-open-meteo  the Open-Meteo API's requests and answers; a binding for https
  devices/aferiy-p280/   @kraftverk/device-aferiy-p280   a device type: power-station
  devices/atorch-s1w/    @kraftverk/device-atorch-s1w    smart-plug
  devices/tuya-plug/     @kraftverk/device-tuya-plug     smart-plug: the generic Tuya energy socket, with profiles
  services/open-meteo/   @kraftverk/service-open-meteo   weather, a service
  gateway/               @kraftverk/gateway              the action gateway's rules: pure, run by whichever holder has the connection
  api-contract/          @kraftverk/api-contract         the HTTP API's shapes, types only: declared once, imported by the server and the app
  holder/                @kraftverk/holder               what every holder does with a device: open, watch, fail over, judge a check; pure
  api-client/  ui/       shared by the app; know no device type
server/  client/         the core; know no transport, protocol or device type by name
```

The rule, checked in CI by `npm run check:architecture` (§7):

- **The core** — `server/src`, `client/src`, `client/app`,
  `packages/api-client`, `packages/ui`, `packages/gateway`, the SDK — never imports a device type,
  a service, a protocol or a transport package. The server finds them at
  runtime and loads them by path, and starts only the transports its installed
  device types need. The app cannot — Metro bundles what is imported, and a
  store build must not download code — so `npm run gen:devices` writes
  `client/src/generated/registry.ts` from the installed packages (device types,
  protocols, the transports' web and native implementations, and screens), and
  that one file is the app's exception. CI checks it is current.
- **A transport** imports the SDK only. It is the one place for platform code
  — sockets, radios, the broker — with a separate entry for each place it runs
  (`server`, `web`, `native`), so the app never bundles server code.
- **A protocol** imports the SDK and other protocols. It is pure: bytes and
  messages in, bytes and messages out, with no I/O and no Node or Bun
  built-ins. It has no idea what a P280 is.
- **A device type** imports the SDK and protocols, and — in its `ui/` folder
  only — `@kraftverk/ui`, `@kraftverk/api-client`, React and Tamagui (peer
  dependencies). Never a transport, the server or the app: it is handed an
  open connection. It is pure too, because it runs in whichever holder has
  its connection. A **family** may build on another device type's package, by
  its name and never by a path: the ATORCH S1W is `@kraftverk/device-tuya-plug`'s
  generic socket with a profile of its own.
- **No third-party runtime dependencies** in a device type, protocol or
  transport without a review: they run inside the server with everything it
  can do (§5), and the server image installs its own dependencies, not every
  package's.

### A device type package

```
packages/devices/atorch-s1w/
  package.json          "kraftverk": { "deviceType": "./src/type.ts", "ui": "./ui/index.ts" },
                        and both entries listed in "exports"
  src/type.ts           export default defineDeviceType({...})   pure, no React: identify,
                        createSession, createSimulator and any setup steps of its own —
                        in this file, or split beside it as the type grows
  ui/index.ts           optional screens, export default { dashboard, settings, advanced };
                        the generic ones are used otherwise
  assets/               icon.svg, product.webp
  test/contract.test.ts checkDeviceTypeContract(type) from @kraftverk/device-sdk/testing
```

---

## 4. The contract: `@kraftverk/device-sdk`

The contract, API version 3, in `packages/device-sdk/src` (`device-type.ts`,
`connection.ts`). Abridged: the comments in the code say the rest.

```ts
export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  id: string;                        // 'atorch.s1w' — stable forever, namespaced
  apiVersion: '3';
  kind: 'hardware' | 'service';
  meta: {
    name: string; brand?: string; models?: string[]; description?: string;
    category: CategoryId;            // from the SDK's fixed list: 'power-station', 'smart-plug', 'weather'
    support: 'verified' | 'community' | 'experimental'; supportNote?: string;
    icon: string; image?: string; docsUrl?: string;
  };
  capabilities: CapabilityName[];    // what every device of this type offers
  telemetry: MetricSpec[];           // standard metric ids where they exist (§4.2)
  controls?: ControlSpec[];          // how capability commands are presented
  settings?: SettingsSpec;           // what the device remembers, read and written live
  config: ConfigSchema;              // the type's own per-device choices, e.g. a profile; never secrets
  connections: ConnectionMethod[];   // at least one; §4.3
  setup?: { steps?: SetupStep[]; saveAnyway?: string };   // steps of its own, whatever the method
  identify(connection: OpenConnection, ctx: IdentifyContext): Promise<Identified>;  // { identity, model, summary }
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
  createSimulator(ctx: DeviceContext<Config>): Promise<DeviceSession>;   // ctx.connection is null
}

export type ConnectionMethod = {
  id: string;                        // 'wifi' — stable forever within the type
  label: string;                     // 'Wi-Fi' — the holder is added on screen: 'through your server'
  protocol: string;                  // 'sydpower'
  transport: string;                 // 'mqtt' — where it may run follows from this, never declared
  recommended?: boolean;
  address?: string;                  // a fixed one — a web API's origin — so nothing is chosen
  config?: ConfigSchema;             // the method's own choices; secrets come from the protocol
  steps?: SetupStep[];               // the type's additions to what the layers supply
};

export type TransportDefinition = { // what a transport is, as data, the same on every platform
  id: string;                        // 'ble'
  label: string;                     // 'Bluetooth'
  channel: 'bytes' | 'messages' | 'http';
  exclusive: boolean;                // an address is one physical thing
  platforms: Platform[];             // where it has an implementation: 'server', 'web', 'native'
  discovery: Partial<Record<Platform, 'list' | 'chooser' | 'none'>>;
};

export type Transport = {           // one running on one platform: a package entry per place
  definition: TransportDefinition;
  available(): Availability;         // { ok: false, reason: 'This server has no Bluetooth radio' }
  start(): Promise<void>; stop(): Promise<void>;
  watch?(filter, listener: (sightings: Sighting[]) => void): () => void;  // server and native: a live list
  choose?(filter): Promise<Sighting | null>;                              // web: the browser's own chooser
  open(address: string, options: OpenOptions): Promise<Channel>;         // bytes, messages or http
  values?(): Record<string, string>;                                      // the broker's address, for instructions
  diagnostics?: Record<string, (query) => Promise<unknown>>;              // read-only
};

export type Protocol = {            // pure: no I/O, no product meaning
  id: string; label: string;         // 'sydpower'
  bindings: Record<string, Binding>; // per transport: open options, filter, recognise, instructions,
                                     // parseAddress, and a message broker's policy
  credentials?: { schema: ConfigSchema; actions?: SetupAction[] };  // stored as connection secrets
  guard?(payload: Uint8Array): string | null;  // a refusal, applied by every holder and the broker
};

export type OpenConnection = {      // what identify and a session are handed, wherever it is held
  method: string; protocol: string; transport: string; address: string;
  channel: Channel;                  // opened by openChannel(): the binding, guarded
  config: ConfigValues;              // the method's config and the protocol's non-secret credentials
  secrets: { get(field: string): string | null };  // the connection's own, from wherever it is held
  platform: Platform;
};

export interface DeviceSession {
  health(): ConnectionHealth;
  readings(): Reading[];                                   // latest telemetry, from cache
  capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null;
  readSettings?(): ConfigValues | null;                    // null until read — never defaults
  writeSettings?(patch: ConfigValues): Promise<ConfigValues | null>;
  identity?(): { id: string | null; name: string | null };  // what the device says it is, once it has
  advanced?: Record<string, AdvancedAction>;               // a register dump: /devices/:id/advanced/:name
  close(): Promise<void>;
}

export interface DeviceContext<Config> {
  deviceId: SavedDeviceId;
  config: Config;                    // this device's own, validated
  connection: OpenConnection | null; // the method in use, already open; null for a simulator
  store: DeviceStore;                // this device's own
  log: DeviceLogger;
  schedule(everyMs: number, task: () => void | Promise<void>): void;  // cancelled on close
  emit(event: DeviceEvent): void;    // lands in the audit timeline
  readOnly: boolean;                 // every hardware write is refused
  allowRawFrames: boolean;           // bringing up an unfamiliar unit; the guard still applies
  platform: Platform;
}
```

Every holder opens a connection the same way, with the SDK's `openChannel`:
the protocol's binding, over the holder's own transport, and the channel
wrapped by `guardChannel`, so the protocol's guard sees every frame whatever
code sends it.

Three properties carry the design: everything is **per device** and **per
connection**, a session exposes **capabilities** and never product methods, and
nothing a device type runs knows **where** it is running.

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
`outlet.<id>.power` for each outlet. `weather.irradiance`, with the measurement
kind it needs, comes with the first recipe that needs it (step 14), not before:
nothing reads it yet. A standard id has one unit and kind, and a
type that claims it must use them, so two devices share an axis without
conversion; `validateDeviceType` checks it.

### 4.3 Connection methods and setup

Adding a device is one flow for every type, described screen by screen in
[DATA-MODEL.md §1](DATA-MODEL.md): category → type → connection method and
holder → get it ready → choose the device → credentials → check → name →
links → save.

A method's steps are **assembled from its layers**, so a device author mostly
declares pairs and writes `identify`:

| Step | Supplied by |
|---|---|
| Get it ready | the protocol's binding for that transport, filled in with the transport's values (the broker's address), plus the type's own steps |
| Choose your device | the holder's transport implementation (a live list, or the browser's chooser), filtered by the protocol |
| Credentials | the protocol (`credentials`), with actions such as *Fetch with my Tuya account* |
| Check it | the type's `identify`, then one read; the identity decides new, already yours, or yours before |

Each step **runs in the holder**: steps for a server-held connection run on the
server against a **draft**, and steps for an app-held one run in the app. The
save is always the server's, in one transaction. A type may offer **save
anyway** after a failed check when failure is expected, as it is for a station
that is asleep. The first successful connection then fills in the identity.
Secrets a server step finds stay on the server; the app sees a short-lived
placeholder (see [SECURITY.md](SECURITY.md)). Secrets of an app-held connection
never leave that client.

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

One source feeds at most one target. Removing either device removes the
link. Links replace the global "which station does the relay feed" key, and
are set while adding a device ("What is plugged into this plug?") or later on
either device's page.

### 4.5 The data model

The catalog is the backbone. A device exists because the user added it, and it
keeps its history while it is unplugged — and after it is removed, until its
history is deleted on purpose. The model, with an example for every field and
the reason for every table, is [DATA-MODEL.md](DATA-MODEL.md). In short:

```sql
device            (id PK, type_id, identity, name, config JSON, added_at, removed_at)
device_connection (id PK, device_id → device, method, transport, held_by → client | NULL = server,
                   address, priority, config JSON, created_at, last_connected_at)
connection_secret (connection_id → device_connection ON DELETE CASCADE, field, value, encrypted)
client            (id PK, user_id → users, name, platform, transports JSON, created_at, last_seen_at)
device_kv         (device_id → device ON DELETE CASCADE, key, value)
device_link       (id PK, kind, source_id → device, target_id → device, created_at)
sample            (device_id → device ON DELETE CASCADE, key, at, value)            -- 14 days
sample_hour       (device_id → device ON DELETE CASCADE, key, hour, min, avg, max, n) -- 2 years
automation        (id PK, name, recipe, roles JSON, params JSON, time_zone, mode, created_at,
                   updated_at, last_run_at, last_result JSON)                  -- migration 8
audit, app_state, users                                                       -- unchanged
sessions          (… as today, + client_id → client)
```

- **Ids are opaque and permanent.** Existing ids (`power-station:3db445e0`) are
  kept verbatim: history is keyed by them. New ids carry no meaning.
- **`type_id` is immutable.** Changing what a device *is* means adding a new
  one; its history would not mean the same thing.
- **Identity, not address, is the device.** One device per identity among those
  not removed; an exclusive transport's address belongs to one device.
- **Config is validated** against the schema its definition declares, on every
  write. Secrets are never in it.
- **Remove keeps history;** deleting history is a separate, confirmed action.
- **Retired by the migrations** (§8, steps 5 and 9): `device.type`, `device.model`,
  `device.driver`, `device.config.transport` and `.boundId`, `plugin_config`,
  `plugin_secret`, `plugin_kv`, `capability_grant`, `active_provider`, and the
  `gridRelay.stationDeviceId` app-state key.

**Every migration is safe for the owner's real data:**

1. The server copies the database (`VACUUM INTO`) beside itself before it
   applies any migration to a database that already has data, and says where.
   Rolling back is stopping the server and putting the copy back.
2. Each migration runs in one transaction; a failure changes nothing.
3. A migration that moves data is rehearsed against a copy of the real
   database before it ships (`npm run db:rehearse -- <copy>`), on the owner's
   machine — the data never leaves it. The file named is only read; the report
   gives every table's and every device's rows before and after, and fails on
   history lost without a note in the audit timeline.

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
- an audit entry naming the account, the automation or the client.

The gateway's rules are shared code, not a server route's: when a phone or
browser holds a device's connection, the same rules run there, and the audit
entry is sent to the server (queued while offline).

### 4.7 At runtime

```
          installed packages (found at start on the server; the generated registry in the app)
   ┌──────────────────────────┬──────────────────────────┬──────────────────────────┐
   │ device-aferiy-p280       │ device-atorch-s1w        │ service-open-meteo       │
   │  protocol-sydpower       │  protocol-tuya-local     │  its own API             │
   │  transport-mqtt, -ble    │  transport-lan           │  transport-https         │
   └────────────┬─────────────┴────────────┬─────────────┴────────────┬─────────────┘
                ▼                          ▼                          ▼
server:  DeviceTypeRegistry ──► DeviceSessionManager: for every device, the connection in use,
         TransportHost (starts what      │ readings              │ capabilities
         installed types need)           ▼                       ▼
                                   Sampler / history       ActionGateway ◄── device links
                                         │                       ▲
                                         └──► AutomationEngine ──┘
app:     the same registry, sessions and gateway rules for connections it holds; readings and audit
         go up to the server · /api/device-types → the add flow · generic device view + optional panels
```

The MQTT broker stays a separate process, because stations must stay connected
while the server restarts. It belongs to `transport-mqtt` and knows no
protocol: each protocol's binding supplies its topics and its guard, which the
broker applies to every publish, so the register-68 refusal stays at the broker.

---

## 5. Safety rules that survive every step

These are not up for refactoring. Their tests move with the code and stay
green at every commit.

- Holding register 68 is never written 0: it permanently bricks the station.
  The whitelist, the schema and the tests that assert it stay.
- The write whitelist, read-only mode, and "read fresh, then write, in one
  turn" for the P280's toggling output registers.
- Physical actions go through the action gateway and nowhere else — on the
  server, or in the app when it holds the connection, with the same rules.
- A protocol's guard runs in every place its frames can leave from: each
  holder, and the broker.
- Unknown is unknown: no reading is invented, no setting is defaulted in place
  of a value never read.
- Device packages are trusted code, from this repository only. Packages from
  elsewhere are out of scope until device types can run in a process of their
  own (see [SECURITY.md](SECURITY.md)).

---

## 6. Where the code stands

What the review found, and which step fixes it. Every finding below is fixed
as of step 13 (2026-09-28): the architecture baseline is empty — no boundary
exceptions, and no product identifier outside the P280's package. The table is
kept as the record of why the layout is what it is.

| | Finding | Step |
|---|---|---|
| F1 | The P280 is special-cased throughout the core: `core.station`, `StationStatus`, `/p280/*` routes, `isStation` in the app | 3–10 |
| F2 | `STATION_MODELS`: eight models, one verified, all decoded as a P280; a hand-built `/device-types` | 3 |
| F3 | Config is per plugin, so a type can have one device: `registry.ts` takes `devices()[0]` | 5 |
| F4 | Capabilities named after one use: `gridRelay.*`, the "active provider", one confirmation phrase | 2, 11 |
| F5 | Closed unions of kinds: `DeviceType`, `DeviceKind`, `PluginKind` | 2–3 |
| F6 | `@kraftverk/protocol` mixes MODBUS, Sydpower and P280 meaning; Tuya is locked inside a plugin | 8 |
| F7 | Setup spread over three screens; no setup-guide contract | 3–6 |
| F8 | No standard telemetry names | 2 |
| F9 | Two hand-edited app registries; `kraftverk.device` and `kraftverk.panel` read by nothing | 3 |
| F10 | The gateway knows one relay; P280 outputs bypass it | 11 |
| F11 | Services have no home | 13 |
| F12 | Nothing stops the boundary eroding | 1 |
| F13 | Connectivity for one product lives in the core: `server/src/{broker,mqtt,transport,connections,drivers}`. The broker and its client parse Sydpower frames; "transport" means "a way to reach a Sydpower station" | 7–10 |
| F14 | The add screen is one flat list of types, simulators and plugins included; how to connect is a config dropdown, and the P280's guide assumes Wi-Fi | 4–6 |
| F15 | Forgetting a device deletes its history — it happened in production on 2026-09-27 | 5 |
| F16 | The smart plugs are plugins playing a "grid relay" role: device, protocol and role in one package, one plug per install | 9 |
| F17 | In-app Bluetooth is a separate code path that the server knows nothing about | 12 |

**A second audit, 2026-09-28**, after steps 0–15 were deployed. The layering
held; what it found is inside the layers — things written twice, and promises
the code kept only in part.

| | Finding | Step |
|---|---|---|
| G1 | Two holder runtimes: the server's and the app's session lifecycles are written twice and have drifted — only the server has the open timeout and the wrong-device check | 17 |
| G2 | Two setup engines: the check's judgement (new, yours, another model) is written twice | 17 |
| G3 | The API's shapes are declared twice, by hand, on the server and in the app | 16 |
| G4 | Settings writes bypass the gateway; the app's path skips the schema and the dangerous-field confirmation, and nothing verifies them | 18 |
| G5 | The gateway names `switch` and `outlets`: a new actuating capability means editing it | 18 |
| G6 | The app has no tests, though it now runs sessions, the gateway, setup and failover | 17 |
| G7 | History is 14 days of raw samples and nothing after; the audit timeline grows forever | 19 |
| G8 | No app–server compatibility check: a store build can lag the server's installed types | 20 |
| G9 | App-held secrets are stored in plaintext in the app | 21 |
| G10 | Retired vocabulary in configuration: `STATION_DRIVER`, `--driver` | 22 |
| G11 | The app's device state and add screen are too big to change safely | 22 |
| G12 | Segmented controls cannot be operated from a keyboard or a screen reader | 22 |

---

## 7. Guardrails in CI

`npm run check:architecture` (`scripts/architecture.mjs`) fails the build when:

- **the dependency rule** (§3) is broken by a new import;
- **the leak count** rises: the number of product-specific identifiers —
  `core.station`, `p280`, `StationStatus`, `StationSettings`, `gridRelay` — in
  shipped files outside `packages/devices/aferiy-p280`. (`power-station` is a
  category now, and belongs in the SDK.) Tests are held to the dependency rule
  but not counted: a test that drives the real station through a core route
  moves with that route. Nor are database migrations, which must name what
  stored data used to be called and never change once shipped, or a pointer to
  a document such as `docs/P280-FINDINGS.md`;
- **purity** is broken, from step 4: a protocol or a device type's `src/`
  imports a Node or Bun built-in (`node:*`, `bun:*`), or a transport, or
  anything else that does I/O. Those packages run in the app as well as on the
  server, so this is what keeps "the code doesn't know where it runs" true;
- **a transport** imports anything from kraftverk but the SDK, or its `web`
  or `native` entry reaches its `server` one.

Both are held by a baseline, `scripts/architecture-baseline.json`, listing
today's exceptions file by file. It may only shrink: a file whose count falls
fails the check too, until `npm run check:architecture -- --update` records the
lower number, so the baseline always says exactly where the leaks are. Moving a
file moves its leaks, which per file looks like a new one; `-- --rebaseline`
accepts that, and refuses if either total rose. A deliberate exception —
code that must reach a product for now, and will leave with it — is an edit
to the baseline made in the open, with its reason in the commit. At the end
of step 10 the baseline is empty.

---

## 8. The plan

Each step ships on its own, keeps the app working, and keeps the deployed
station working. The order is:
- **Contracts, then the data, then what people see.** The add flow is only
  right once connection methods and identities exist to build it on.
- **Then the packages underneath**, moved out of the core one layer at a time:
  transports, then protocols. Nothing on screen changes while they move.
- **The plugs move before the P280,** because two of them side by side are the
  real test of per-device connections and secrets. The P280, the only device in
  production, is finished last, once the model has carried two real device
  types.

Steps 4–12 were re-planned on 2026-09-27, when connection methods, transports,
holders and identity were added to the model (DATA-MODEL.md).

| Step | | Size | Status |
|---|---|---|---|
| 0 | Words and one authority | S | done |
| 1 | Guardrails | S | done |
| 2 | Contracts: `device-sdk` | M | done |
| 3 | Discover device types; a session for every device | M | done |
| 4 | Contracts for connections: categories, methods, transports, protocols, identity | M | done |
| 5 | The data model: type ids, identities, connections, secrets, links, clients | L | code done, rehearsed on a development copy; production migrates at the deploy |
| 6 | Adding a device: category → type → method → setup; a device's connections | M–L | done |
| 7 | Transports as packages; the core loses its connectivity code | L | code done; the station staying connected is checked at the deploy |
| 8 | Protocols as packages: Sydpower and Tuya local | M | done |
| 9 | Smart plugs: the ATORCH and the generic Tuya plug as device types | M | done |
| 10 | The P280 as an ordinary device type | M | done |
| 11 | One gateway for every command, in shared code | M | done |
| 12 | Connections held by the app | L | done, native Bluetooth untested |
| 13 | Services: weather first | S–M | done; SMHI next |
| 14 | Automations | L | done: recipes; rules next |
| 15 | Make contributing easy | S | done |
| 16 | One API contract | S | done |
| 17 | One holder core, and the app tested | L | done |
| 18 | The gateway knows capabilities, not names; settings go through it | M | done |
| 19 | History that lasts | M | done |
| 20 | App and server agree on what they speak | S | later |
| 21 | Secrets at rest in the app | S | |
| 22 | Loose ends: configuration words, big modules, accessibility | M | later |

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
lived on in `src/v1/`, its capabilities renamed `PluginCapability`, until the
plugins went in step 9. Controls already speak the new capability names — the P280's
ports are `outlets`, a plug's relay is `switch` — and telemetry carries its
standard ids.

### Step 3 — Discover device types; a session for every device
- **Server:** a `DeviceTypeRegistry` finds `kraftverk.deviceType` in
  `packages/devices/*` and `packages/services/*`, checks the API version and
  loads the type. The P280 is registered as a type from here on, through a
  thin session over today's station code — nothing about how it runs changes.
- **Sessions:** a `DeviceSessionManager` opens `type.createSession(ctx)` — or
  `createSimulator(ctx)` without hardware — for every saved device of an
  installed type, with its own validated config and its own store
  (`device_kv`). Merged in from the data-model step, because the P280 cannot be a type
  without a session and a simulator of its own.
- **API:** `GET /api/device-types` returns every installed type: meta, support,
  capabilities, config schema and setup steps without their functions.
- **Deleted:** `STATION_MODELS`, the hand-built list. Unverified models are
  gone until someone with the hardware writes their type.
- **App:** `npm run gen:devices` writes `client/src/generated/registry.ts`,
  the only place the app imports device packages, replacing `screens.ts` and
  `plugins/panels.ts`. The add screen renders from `/api/device-types`.

**Done when** adding a package with no other edit makes it appear in the app.

*Done.* `server/src/devices/types.ts` discovers and validates;
`server/src/devices/sessions.ts` opens one session per device;
`server/src/devices/registry.ts` builds every typed device's view from its
type and session, and names no product. The P280 package now holds its
`DeviceType` (`src/type.ts`), its simulator (moved from the server, settings
kept in its device store) and its session adapter (`src/station.ts`: readings,
`battery`, `outlets`, `acInput`, settings checked against its own schema before
the driver's whitelist), and passes the contract suite. On real hardware the
session borrows its driver from the connection manager through the
`sydpower.station-links` transport — the bridge step 10 removes. The gateway's
second proof reads the paired device's `acInput` rather than P280 status. New
devices are added by `typeId` and get opaque ids; the station model list is
gone. Outlet controls act through the `outlets` capability.

### Step 4 — Contracts for connections
- **SDK, API version 3** (§4): the fixed category list (id, label, icon, and
  its section: devices or services); `ConnectionMethod`, `Transport`,
  `Protocol` with its bindings, `recognise`, `credentials` and `guard`; holder
  availability with reasons; `identify`; setup assembled from the layers
  (§4.3). `DeviceType.connections` replaces `protocols`, the P280's
  `transport`/`boundId` config and the single `setup` guide.
- **The first transport and protocol packages, declarations only:**
  `transport-mqtt`, `transport-ble` and `protocol-sydpower` with their ids,
  bindings (topics, the Bluetooth service), `recognise` and instructions. Their
  I/O stays where it is until steps 7–8.
- **The P280 declares `wifi` and `bluetooth`,** and `identify`, over today's
  code through the station-links bridge.
- **Checks:** `validateDeviceType` and the contract suite check that each
  method names an installed protocol and transport, that the protocol has a
  binding for that transport, and that `identify` works against the simulator
  over every method. CI gains the purity and transport rules (§7).

**Done when** `GET /api/device-types` lists each type's methods and where each
can be held right now, and the P280 passes the suite with both methods.

### Step 5 — The data model
- **The migration**, rehearsed first with `npm run db:rehearse` on a copy of
  the real database. The first rehearsal uses the copy taken before migration 6,
  because it still holds the station and its history. The migration:
  - `device` gains `type_id` (`core.station` → `aferiy.p280`), `identity`
    (`sydpower:` plus the MAC) and `removed_at`, and loses `type`, `model` and
    `driver`;
  - `device.config.transport` and `.boundId` become a `device_connection`;
  - `connection_secret`, `client`, `device_link` and `sessions.client_id` are
    added;
  - `sample` gets its foreign key.

  The plugin tables stay until step 9, when their plug has a type to move to.
- **Remove keeps history.** Remove sets `removed_at`, frees the addresses and
  drops the links. *Delete history* is a separate action, in the API and the
  app, confirmed by typing the device's name.
- **Sessions** are opened with `ctx.connection` and the connection's secrets.
  Clients are registered at sign-in.

**Done when** the catalog stores what each device is and how it is reached,
the production station has migrated with its history, and removing a device
no longer deletes anything.

### Step 6 — Adding a device
- **The flow** in [DATA-MODEL.md §1](DATA-MODEL.md), for server-held methods:
  - categories, search and *Found near you*;
  - types with their support level;
  - methods, with where each can be held and why one can't;
  - instructions with real values, a live list of sightings, credentials;
  - the check, with all five outcomes (new, already yours, yours before,
    another model, no answer);
  - name, links, and one save.
- **Server:** setup drafts that expire, a live sightings feed, and the save in
  one transaction.
- **A device's Connections section:** which one is in use and which is standing
  by, *Add another way to reach it*, *Make preferred*, *Remove*. Also Remove
  and Delete history.
- **Removed:** the Station link screen and auto-bind. A station is added, and
  reconnected, only through this flow. Rows for app-held methods arrive in
  step 12; until then in-app Bluetooth stays where it is.

**Done when** the P280 is added through the flow over Wi-Fi and over server
Bluetooth, re-adding a removed station brings its history back, and adding the
same station a second way adds a connection, not a device.

### Step 7 — Transports as packages
- **`transport-mqtt`:** the broker, still its own process so stations stay
  connected across server restarts, and the server's client. The broker
  applies each protocol binding's topics and guard, and knows no protocol
  itself. From `server/src/broker` and `server/src/mqtt`.
- **`transport-ble`:** the server implementation from
  `server/src/transport/ble.ts`, and the web and native implementations from
  the app's Bluetooth code (the app uses them in step 12).
- **`transport-lan` and `transport-https`:** from the Tuya plugin's sockets and
  the SDK's scoped HTTP.
- **The server** gets a transport host that starts what installed types need
  and reports what is available. `server/src/{broker,mqtt,transport}` are
  gone. The connection manager shrinks to the station-links bridge, which goes
  with `drivers` in step 10.
- **Carried over:** the broker's journal, its known-stations file and its
  token. The deploy is checked on the NAS with the station staying connected.

**Done when** the core has no connectivity code and the station stayed
connected through the deploy.

### Step 8 — Protocols as packages
- **`protocol-sydpower`** from `packages/protocol`: framing, CRC, register
  blocks, the register-68 guard, and the bindings, with the broker policy
  moved in from `server/src/broker/policy.ts`. The captured-frame tests move
  unchanged. `StationStatus`, settings, ports, write rules and the polling
  client move into the P280 package.
- **`protocol-tuya-local`** from the plugin: frames, crypto, handshake,
  discovery packets, the local-key credential and its cloud fetch (request
  shapes only; the holder's `https` transport sends them).
- `packages/protocol` is gone.

**Done when** the guard's tests pass in the new package, and a test through
the broker shows a write of 0 to register 68 still refused there.

### Step 9 — Smart plugs
- **`device-atorch-s1w` and `device-tuya-plug`** (one profile per socket), both
  in the Smart plugs category:
  - `switch` and `powerMeter`;
  - one method, `lan` (tuya-local over lan);
  - `identify` by the Tuya device id;
  - the "relay on datapoint 1 or 131" question settled in the check step;
  - a simulator, made from the fake relay.
- **The migration** (rehearsed): the plugin's config, key and store become an
  ATORCH device with its connection and secret, and the relay pairing becomes
  a `feeds` link. The plugin tables, `capability_grant` and `active_provider`
  go.
- **The gateway's relay path** switches the plug through `switch`, and verifies
  through the linked station's `acInput`.
- **Deleted:** `packages/plugins/*`, the v1 contract (`device-sdk/src/v1`), the
  Extensions screen and the plugin panel registry.

**Done when** the ATORCH and a second plug, each with its own address and key,
work at once, and "the relay" is simply the plug that feeds the station.

### Step 10 — The P280 as an ordinary device type
- **`server/src/drivers/*`** becomes the P280's session over `ctx.connection`,
  and the station-links bridge and `stationOf` go.
- **`/devices/:id/p280/*`** goes. The register tools become type-provided
  routes under `/devices/:id/advanced/*`.
- **The legacy one-station import** goes.

**Done when** the leak baseline is empty and the P280 passes the contract
suite.

### Step 11 — One gateway for every command, in shared code
Everything in §4.6, for every capability command: the P280's outlets and
settings as well as the plugs. The rules live in a shared package, so that
step 12 can run them in the app. **Done when** `gridRelay.*`, `Resource` and
the global confirmation phrase are gone, and every command goes through
`/devices/:id/capabilities/…`.

### Step 12 — Connections held by the app
- **Clients report their transports.** The setup flow gains the "from this
  phone" and "from this browser" rows, using `transport-ble`'s web and native
  implementations.
- **The app runs the device's session** for a connection it holds: the same
  device-type and protocol code, the protocol's guard and the gateway's rules.
  It sends readings and audit entries to the server, queued while offline.
  Secrets stay on the client.
- **The active-connection rule** (DATA-MODEL.md §4): the reachable connection
  with the lowest priority is in use, and a connection lower down takes over
  only while those above it are unreachable.
- **Local mode** keeps its devices and connections in the app's own storage,
  with the same shape, and runs the same flow with only the app's methods.
- **The old in-app Bluetooth path goes.**

**Done when** a station reached "Bluetooth, from this phone" records history on
the server while the phone has it, the server's Wi-Fi connection takes over
again when the phone leaves, and local mode adds and uses a station through
the same flow with no server.

### Step 13 — Services: weather first
`services/open-meteo`, in the Weather category: `kind: 'service'`, one method
(its API over `https`, held by the server, no key), offering
`weather.forecast` and weather telemetry, set up by choosing a place. Shown in
its own section on Home. Open-Meteo first because it works anywhere; SMHI, the
owner's primary forecast (PROJECT-BRIEF.md, Stage 3), follows as a second
service with no core change. **Done when** it has history charts and needed no
core change beyond showing services.

### Step 14 — Automations
An `AutomationEngine`: triggers (telemetry thresholds, forecast conditions,
time), conditions, and capability commands as actions — through the gateway.
Automations name devices and capabilities, never types; the editor offers only
devices with the capability a slot needs. A device held only by a phone is
reachable while the phone has it, and a run that can't reach it records why.
Recipes first ("charge when sunny", "keep the station above X % from the
grid"), rules after. **Done when** "if tomorrow is sunny, turn on the ATORCH"
is created in the app and runs with an audit trail.

*Done* with the first recipe. `server/src/automations`: recipes (`recipes.ts`,
with roles by capability and settings as a schema), the store (migration 8),
and the `AutomationEngine`, which asks each automation whether it is due, lets
its recipe decide, and sends what it decided through the gateway as
`actor: 'automation'` — dwell, freshness, read-only mode and verification
apply, and every run is audited under `automation:<name>` and kept as its last
result. A new automation **observes**: it says what it would have done.
**Arming** it is confirmed, as is changing what an armed one does. Times are
the owner's clock, carried from the app that made it, whatever zone the
server runs in. The first recipe is *Switch by the forecast*: once a day, at
the hour chosen, today's or tomorrow's average cloud cover between 09:00 and
17:00 decides whether to switch; a forecast with gaps decides nothing. The
app's Automations screen makes one — each role offers only the devices that
fit — and shows the last run and what it would do now. Verified end to end
against a simulated weather service and plug. Next: the backup-reserve
recipe (PROJECT-BRIEF.md), which needs the arming checklist, and rules.

### Step 15 — Make contributing easy
`npm run new:device`, `new:protocol` and `new:transport` scaffolds, a
`docs/ADDING-A-DEVICE.md` guide, and the contract suite run in CI for every
device type, protocol, transport and service.

### Step 16 — One API contract (G3)
`packages/api-contract`: every shape the HTTP API takes and answers, types
only, imported by the server and by `@kraftverk/api-client`. The server
validates bodies with its own schemas, typed against the contract's inputs.
`npm run check:architecture` fails when a shape the contract declares is
declared again in the server or the app. **Done when** each shape is declared
once, and a changed field fails the typecheck on both sides.

*Done.* It caught two drifts on the way in: `SaveInput.mode` was required on
one side and optional on the other, and a recipe's role capabilities were
read-only on one side only.

### Step 17 — One holder core, and the app tested (G1, G2, G6)
A pure `packages/holder` with what every holder does: open a connection,
build the device's context, schedule its work, time out an open, refuse a
connection that reaches a different device, fail over after two minutes, the
hold rule, and the check's judgement. The server and the app inject only what
differs — where the store, secrets and audit go. **Done when** both holders
run devices through the same code and `client/src/runtime` has tests.

*Done.* `@kraftverk/holder`: `openDevice` (the guarded channel, the context,
skip-if-running schedules, the open timeout, closing), `identityVerdict`,
`Failover`, the hold rule (`activeConnection`, `toHold`, `withInUse`) and
`judgeCheck`. The server's session manager, its setup and its registry use
them, and so do the app's held sessions, runtime and setup flow — the app
gained the open timeout and the wrong-device check, and its failover now
follows the channel rather than polling. Tests: the package's own, and the
app's first (`LocalCatalog`, `Uplink`), which found that a flush asked for
during another was dropped until the next timer. `check:architecture` holds
the shared core — contract, SDK, gateway, holder — to no platform built-in.

### Step 18 — The gateway knows capabilities, not names (G5, G4)
Each actuating command in the capability library says how it is read and
sent; the gateway calls that. Settings writes become a gateway intent:
validated against the schema, refused while read-only, confirmed for
dangerous fields, verified by reading back, audited — from either holder.
**Done when** `gateway.ts` names no capability.

*Done.* `device-sdk/src/actuators.ts`: each actuating command's `read` and
`send` (`switch.set`, `outlets.set`), and each link kind's evidence (a station
a plug `feeds` sees its mains). `ActionGateway.writeSettings` holds a patch to
the type's schema, refuses it while read-only, asks a person to confirm a
setting in `dangerous` and never lets an automation change one, then verifies
by reading back; the server's route and the app's own writes both use it, and
each holder says what read-only means there. A role in a recipe may be filled
by one of several capabilities (`meetsNeed`), and through a part: *Switch by
the forecast* switches a plug, or one of a station's outlets.

### Step 19 — History that lasts (G7)
Hourly roll-ups kept for two years beside 14 days of raw samples; the audit
timeline kept for a year. **Done when** a 30-day chart draws from the roll-ups.

*Done.* Migration 9 adds `sample_hour` (min, mean, max and count per device,
key and hour), filled from the samples already kept. The sampler rolls up
the last two days every ten minutes — idempotently, so late readings correct
an hour rather than count twice — and a late batch from an app rolls up its
own hours. Pruning rolls up before it deletes minutes. `/history` answers a
span over two days, or older than the minutes kept, from the hours, and says
which (`resolution`); charts reach back a month and a year.

### Step 20 — App and server agree on what they speak (G8)
An API version and the installed types in `/version`; an app that lacks a
type shows that one device as needing an update. Later: there is no store
build yet.

### Step 21 — Secrets at rest in the app (G9)
A secure store on a phone, and a non-extractable key on the web, behind one
vault. **Done when** no secret sits in the app's storage in plaintext.

### Step 22 — Loose ends (G10–G12)
`KRAFTVERK_TRANSPORTS` as the only documented setting, the app's device
state and add screen split, and segmented controls a keyboard can reach.

---

## 9. Decisions

1. **Which station a plug feeds** is a link between devices (§4.4) — a fact
   about the house that the gateway, the energy-flow view and automations all
   read — not part of either device, and not inside one automation.
2. **In-app Bluetooth** is not a special path. It is a connection held by the
   app (step 12), and the old path is gone.
3. **Unverified station models** are removed. One comes back as its own type,
   reusing the P280's code, when someone with the hardware writes it.
4. **Services** live in `packages/services/*`, found by the same discovery.
5. **Trust:** device types come from this repository only (§5).
6. **Order:** the plugs move before the P280 (§8), unlike the review, which
   moved the P280 first.
7. **Metric keys** stay as stored; standard ids are a mapping on top (§4.2), so
   no history is rewritten.
8. **A device type declares connection methods, not transports and protocols
   separately.** Each method is one protocol over one transport, because not
   every protocol rides every transport. Where a method can run is never
   declared: it follows from which holders have its transport.
9. **The code doesn't know where it runs.** Protocols and device types are
   pure, and all platform code lives in transports, one implementation for
   each place. The server and the app run the same session code.
10. **Setup belongs to the method and is assembled from its layers.** Each
    step runs in the holder: the server's broker list for a server-held
    method, the browser's Bluetooth chooser for a browser-held one.
11. **A device is its identity, read from the device.** It is never its
    address, because browsers and phones hide or scramble addresses. The same
    station found two ways is one device with two connections.
12. **One connection in use at a time** per device: the reachable one with the
    lowest priority.
13. **Removing a device keeps its history.** Deleting history is a separate,
    confirmed action. Decided after a device removal on 2026-09-27 deleted the
    station's history in production.
14. **Categories are a fixed list in the SDK.** A simulator is never something
    you can add: every type has one, for tests and "try without hardware".
15. **Local mode stays: the app works with no server.** In the model it is
    simply a client that is the only holder: it offers the methods whose
    transports it has, and keeps the same records — devices, connections, their
    secrets, links — in its own storage instead of on a server
    (`client/src/runtime/local.ts`). What it cannot do is what only an
    always-running server can: history while the app is closed, and
    automations.

---

## 10. The architecture is done when…

Ticked where the code does it and a test shows it; what only hardware can show
is said beside it.

- [x] Adding a device type means adding one package: no edits to `server/src`,
      `client/src`, `packages/api-client` or `packages/ui` — only
      `npm run gen:devices`, which rewrites the app's generated registry. The
      same for a protocol or a transport (`npm run new:device` and its siblings
      prove it on every run).
- [x] `GET /api/device-types` lists exactly the installed packages, and the add
      flow renders from it: category (or a search) → type → method → setup.
- [x] Two devices of one type, each with its own connection and secrets, run at
      once. *Shown with simulated devices; two real plugs side by side wait on
      the ATORCH's local key.*
- [x] One device reached two ways (server Wi-Fi, phone Bluetooth) is one device
      with one history, and the reachable connection highest in the list is the
      one in use. *Web Bluetooth is verified up to the browser's chooser; a phone
      has not run it.*
- [x] Removing a device keeps its history; adding it again brings it back.
- [x] The core has no connectivity code; protocols and device types are pure,
      enforced in CI.
- [x] The leak baseline is empty, enforced in CI.
- [x] Every command goes through `/devices/:id/capabilities/…` and the gateway's
      rules, wherever the connection is held; every holder applies the
      protocol's guard where it opens the channel.
- [x] Every device type has its methods, a simulator and a passing contract
      test, and one test checks every installed package
      (`server/src/runtime/packages.test.ts`).
- [x] Weather is a service offering `weather.forecast`.
- [x] An automation connecting a forecast to a switch runs end to end, audited
      (step 14). *Against simulated devices; the ATORCH waits on its local key.*
- [x] The app never says extension, plugin, driver, adapter, bind, transport or
      protocol.
