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

> **Phase: research and development — strict version 1.** Nobody runs
> kraftverk in production but its owner, so nothing here is kept backward
> compatible: no adapters, no versions, no migration chain, no fields nullable
> only for old rows. A change to the model is made everywhere at once. Where
> this document says "stable forever", it means from the first release on.
> See [AGENTS.md](../AGENTS.md) and decision 21 in §9; this changes when there
> is a production state to protect.

---

## 1. The goal

1. **Everything you add is a device.** A power station, a smart plug, a
   microwave, a weather service. There is no second concept for the user to
   learn.
2. **Support is packages, of two kinds.** An **integration** teaches kraftverk
   a platform — how things on it are reached, signed into and found; a
   **device package** teaches it one product or product family on a platform
   (docs/PLAN-INTEGRATIONS.md §1). Each is self-contained, added without
   touching the core. The server and the app find the installed packages;
   nothing lists them by hand.
3. **Protocols are shared packages.** Sydpower MODBUS, Tuya local and so on each
   live in one package that any number of device types use.
4. **Every device is described the same way:** parts (the device, and whatever
   it has several of), their attributes (what they report, and what they
   remember and can be told — settings), the capabilities they offer, and the
   events it raises. The description comes from its type, or from the device.
5. **A device is reached through connection methods it declares:** each a
   protocol over a transport, set up by steps the layers supply, and held by
   the server or by the app, with the same code either way.
6. **Services are devices without hardware.** Weather is added the same way and
   is described the same way.
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
| **Integration** | The one place kraftverk meets a service or a vendor's system: its protocol (how it is spoken to), its ways in and their setup, its accounts, gateways and services, its own screens, the builder and typed API its devices are built with, the generic type a device nobody described falls back to. Names no product (PLAN-INTEGRATIONS.md §1.1). | `@kraftverk/integration-tuya` |
| **Device package** | A package that knows one kind of device on an integration — a product, a product family — what its values mean, its screens. Built on its integration and importing nothing else. What contributors mostly write. | `@kraftverk/device-aferiy-p280` |
| **Device type** | One kind of thing: a product, declared by a device package; or the platform's own — a service, the generic type — declared by its integration. Models of a family are profiles, as data. | `aferiy.p280`, `tuya.plug` |
| **Transport** | A package that moves bytes or messages and finds devices, with one implementation for each place it can run. Knows nothing of what it carries. | `@kraftverk/transport-mqtt`, `-ble`, `-lan`, `-https` |
| **Protocol** | How an integration speaks to its service: a wire format and how it rides each transport, part of the integration (`src/protocol/`). Pure code, no I/O, importing only the SDK; its id is its integration's or begins with it. | `sydpower`, `tuya-local`, `niu-cloud` |
| **Connection method** | One protocol over one transport, declared by a device type, with the setup steps the layers supply. It says nothing about where it runs. | the P280's `wifi` (sydpower over mqtt) and `bluetooth` (sydpower over ble) |
| **Node** | A kraftverk node: the hub running somewhere — a machine on the network, a phone, a browser — holding the connections it reaches there. It declares what it is (`NodeTraits`): **always on**, **reachable** by others, **trusted** with what must stay put. It offers a method wherever it has the transport and is what the method `needs`. Known by its own id in every database that knows it. The node holding a connection is its *holder*. | "Garage NAS", "Chrome on the laptop" |
| **Master** | The node whose database is the home's, and the only one that writes it (`home.master_id`): the one fittest for it — always on, then reached by others. | your server; the app alone, with none |
| **Follower** | Any other node of the home: it keeps a copy of what the master says, and holds for it the ways it reaches itself (`createFollower`). | the app with a server; a Raspberry Pi beside a station |
| **Server** | The HTTP entrance of a reachable node — its address, its accounts — not a kind of node. On screen, "your server" is the always-on node most people have. | `http://nas.local:3000` |
| **Device** | One thing the user added: an instance of a device type, with its own name, config and identity. | "Garage P280", "Heater plug" |
| **Identity** | A device's own permanent id, read from the device. What makes one station found two ways a single device. | `sydpower:AABBCC001122` |
| **Connection** | One way a device is reached: a method, the node that holds it — or the bridge it goes through — and an address, with its own secrets, kept on that node. A device may have several; one is in use at a time. | Garage P280 over Wi-Fi, held by the NAS |
| **Bridge** | A device through which others are reached — its members: a role, not a kind. A member's way goes through it: its session hands the member a **link**, an object of plain calls its integration declares, and it is held wherever the bridge is (PLAN-INTEGRATIONS.md §4.3). | A NIU account and its scooters; a Zigbee gateway and its plugs |
| **Sighting** | Something a transport can see that no connection claims. Live state, never stored. | "A power station is connected to this server" |
| **Service** | A device type with `kind: 'service'`: no hardware. Added and shown the same way, in its own section. | "Weather (Open-Meteo)" |
| **Account** | A device type with `kind: 'account'`, always an integration's own: a sign-in to someone's cloud, usually a bridge to the devices on it. Held as a device is, managed on its integration's page. Not a person's account in kraftverk. | "Family iCloud", "NIU account" |
| **Description** | What a device is, as data: its parts, their attributes, and its events. Declared by its type, or reported by the device. | — |
| **Part** | The device itself (`main`), or one of what it has several of, as a Matter endpoint is. | `main`, `outlet.ac`, `pack.1` |
| **Attribute** | A value a part reports, with a stable key, a type and — where one applies — a standard meaning. | `soc` meaning `charge` |
| **Capability** | What a part can do or report, declared like a Matter cluster: attributes, commands, queries. | `switch`, `battery`, `weather.forecast` |
| **Setting** | An attribute the device remembers across a power cycle, and can be told. | A charge limit, a standby timer |
| **Event** | Something that happened, declared by the device's description. | An overload trip |
| **Config** | Non-secret choices stored with a device (the type's) or a connection (the method's). Secrets are stored apart and never leave their holder. | A plug's profile; a Tuya protocol version |
| **Setup** | The steps from choosing a category to a saved device (DATA-MODEL.md §1). Each method's steps are assembled from its transport, protocol and type. | Scan the LAN, fetch the key, read once |
| **Link** | A physical fact connecting two devices, recorded by the user. | "This plug feeds that station's AC input" |
| **Automation** | A recipe whose roles are filled by parts of devices, acting through the gateway. | "Sunny tomorrow → switch on the heater plug" |
| **Session** | A running connection to one device, on whichever node has it in use. | — (internal) |

Retired: **extension**, **adapter**, **driver** and **provider** as names for
anything, **plugin** on screen, and the **grid relay** as a thing: it was a
role, and is now a smart plug with a `feeds` link. "Plugin" survives only in
prose, for "an installable package". The app never says extension, plugin,
driver, adapter, bind, transport or protocol. It names methods the way people
do: "Wi-Fi, through your server", "Bluetooth, from this phone"; the screen
about them is *Connectivity*, which lists the home's *kraftverk nodes*. Hardware keeps its own names — a DC charger, a
Bluetooth radio — and so do the ones people know, such as MQTT.

---

## 3. Packages and the dependency rule

```
packages/
  device-sdk/            contracts only: values, meanings, capabilities, descriptions, projections,
                         categories, link kinds, schema, DeviceType, ConnectionMethod, Transport,
                         Protocol, DeviceSession
  transports/mqtt/       @kraftverk/transport-mqtt       the broker (its own process) and the server's client; server only
  transports/ble/        @kraftverk/transport-ble        server (noble), web (Web Bluetooth), native (the phone)
  transports/lan/        @kraftverk/transport-lan        TCP and UDP on the home network; server only for now —
                                                         a native entry needs a socket library, a reviewed dependency
  transports/https/      @kraftverk/transport-https      the internet, address-scoped (plus the origins a protocol
                                                         declares beside it: a sign-in host); everywhere
  integrations/sydpower/ @kraftverk/integration-sydpower the Sydpower stations' platform: its protocol (MODBUS-style frames,
                                                         CRC, register blocks, the register-68 rule; bindings for mqtt and
                                                         ble) and its ways in, Wi-Fi through the broker and Bluetooth
  integrations/tuya/     @kraftverk/integration-tuya     Tuya: its local protocol (frames, crypto, handshake, discovery, the
                                                         local key), the socket builder, and the generic plug, with profiles
  integrations/niu/      @kraftverk/integration-niu      NIU: its cloud's protocol (sign-in, tokens, the state), the NIU
                                                         account — a bridge — the scooter builder and the generic scooter
  integrations/open-meteo/ @kraftverk/integration-open-meteo the weather, a service, and its API
  integrations/elprisetjustnu/ @kraftverk/integration-elprisetjustnu Sweden's electricity prices, a service, and its API
  devices/aferiy-p280/   @kraftverk/device-aferiy-p280   a device on sydpower: power-station
  devices/atorch-s1w/    @kraftverk/device-atorch-s1w    a device on tuya: smart-plug
  devices/tuya-zigbee-plug/ @kraftverk/device-tuya-zigbee-plug a device on tuya: smart-plug, a Zigbee socket behind a Tuya
                                                         gateway (`ip#zigbee-address` on the lan transport)
  devices/niu-uqi-gt/    @kraftverk/device-niu-uqi-gt    a device on niu: vehicle, the UQi GT, through the account
  automation/            @kraftverk/automation           the automation language: rules, checking, describing, evaluating, editing, its
                                                         text form, the standard recipes, what a package contributes; pure (its README)
  home-file/             @kraftverk/home-file            a home, in one file: YAML, its JSON Schema, migrations; pure
  automation-engine/     @kraftverk/automation-engine    runs automations: triggers, steps, runs and their logs, rehearsal, the library;
                                                         where they are kept is a port it declares; pure
  store/                 @kraftverk/store                the data model in SQLite: one schema and every store, over a SQL port the
                                                         server (bun:sqlite) and the app (expo-sqlite; SQLite's WebAssembly
                                                         build in a browser) fill; pure
  hub/                   @kraftverk/hub                  a home, running: what is installed, devices' views, setup, history,
                                                         attention, automations, the configuration — wired over the ports
                                                         the place it runs gives it; the server's and the app's alike; pure
  message-port/          @kraftverk/message-port         a home's API and a transport over a message port: served on one side, the
                                                         same interface on the other — a browser's page and the hub in its worker; pure
  gateway/               @kraftverk/gateway              the action gateway's rules: pure, run by whichever holder has the connection
  api-contract/          @kraftverk/api-contract         the HTTP API's shapes, types only: declared once, imported by the server and the app
  holder/                @kraftverk/holder               what every holder does with a device: open, watch, fail over, judge a check; pure
  api-client/  ui/       shared by the app; know no device type
server/  client/         the core; know no transport, integration or device package by name
```

**The core runs anywhere** (decision 22). Whatever is kraftverk's logic
rather than the server's — sessions, the gateway, automations and their
language, the configuration, history — is a shared package with no platform
built-in, so the app can run it as the server does. The server keeps only
what needs an always-running machine: the HTTP API, accounts, the broker,
the disk. Where the server still holds such logic, and the order it moves
in: [PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md).

The rule, checked in CI by `npm run check:architecture` (§7):

- **The core** — `server/src`, `client/src`, `client/app`,
  `packages/api-client`, `packages/ui`, `packages/gateway`, the SDK — never imports an
  integration, a device package or a transport package. The
  server finds them at runtime and loads them by path, and starts only the
  transports its installed device types need. The app cannot — Metro bundles
  what is imported, and a store build must not download code — so `npm run
  gen:devices` writes `client/src/generated/` from the installed packages:
  what a hub installs (integrations, with their protocols, their own types
  and the products on them and what those bring to automations; transport
  definitions — no React), each transport's entry for a phone and for a
  browser's page, and the screens and pictures. Those files are the app's
  exception. CI checks they are current.
- **A transport** imports the SDK only. It is the one place for platform code
  — sockets, radios, the broker — with a separate entry for each place it runs
  (`system`, `web`, `native`), so the app never bundles server code.
- **An integration** imports the SDK, the automation language (to declare the
  recipes and functions its types contribute, an entry of its own beside each
  type), and — in its `ui/` folder only — `@kraftverk/ui`,
  `@kraftverk/api-client`, React and Tamagui (peer dependencies). It names no
  product: never a device package, nor another integration. **Its protocol**,
  in `src/protocol/`, imports the SDK and its own files only: bytes and
  messages in, bytes and messages out, with no I/O and no Node or Bun
  built-ins. It has no idea what a P280 is.
- **A device package** imports the same, and the one integration it is built
  on — by its name, never by a path, its protocol as
  `@kraftverk/integration-<id>/protocol` — and nothing else: the ATORCH S1W
  is `@kraftverk/integration-tuya`'s socket with a profile of its own. Never
  another device package, another integration, or a protocol of its own.
- **Calls, not messages** (PLAN-INTEGRATIONS.md §1.1). Packages, the core
  and a bridge's members talk by typed function calls on interfaces the SDK
  or an integration declares. Publish/subscribe is a wire some devices speak
  (MQTT), kept inside the transport and the integration that speaks it; the
  live stream (`LiveBus`) tells what happened and is never asked or
  commanded through.
- **Both** keep `src/` from their own `ui/`: the server loads `src/`, and
  what both need lives there. Never a transport, the server or the app: each
  is handed an open connection. Both are pure, because they run in whichever
  holder has the connection — a server, a browser, a phone.
- **No third-party runtime dependencies** in an integration, a device
  package or a transport without a review: they run inside the server with everything it
  can do (§5), and the server image installs its own dependencies, not every
  package's.

### An integration and a device package

```
packages/integrations/tuya/
  package.json          "kraftverk": { "integration": { "id": "tuya", "name": "Tuya",
                                         "protocols": ["./src/protocol/index.ts"],
                                         "types": [{ "id": "tuya.plug", "entry": "./src/plug.ts" }] } }:
                        its protocols, and the platform's own types — accounts, gateways,
                        services, the generic one — which may be none; every entry listed
                        in "exports", its protocol as "./protocol"
  src/protocol/         how Tuya is spoken to: pure, the SDK and its own files only
  src/index.ts          what its devices are made with: a builder, its ways in, the link a
                        device behind its gateway reads
  ui/                   its own screens ("kraftverk": { "integration": { "ui": … } }): pieces of
                        its page and of an account's, which the app shows under Integrations —
                        never among the devices; a device's screens are its type's

packages/devices/atorch-s1w/
  package.json          "kraftverk": { "device": { "integration": "tuya", "types": [{ "id": "atorch.s1w",
                                         "entry": "./src/type.ts", "ui": "./ui/index.ts",
                                         "images": ["./assets/image-1.png"] }] } },
                        and every entry listed in "exports"
  src/type.ts           export default defineDeviceType({...})   pure, no React: identify,
                        createSession, createSimulator and any setup steps of its own —
                        in this file, or split beside it as the type grows
  ui/index.ts           optional slots, export default { dashboard, parts, settings, tools } satisfies DeviceUi;
                        the generic pages draw whatever it leaves out
  assets/               image-1.png, image-2.png…: the device as it looks, on a transparent
                        background, at most 1024 px and 512 KB each (gen:devices checks); small
                        beside its name in lists, large on its own page. The first unless a
                        device's owner picks another (kept by the server, per device)
  test/contract.test.ts checkDeviceTypeContract(type) from @kraftverk/device-sdk/testing
```

---

## 4. The contract: `@kraftverk/device-sdk`

The contract, in `packages/device-sdk/src`: a type (`device-type.ts`), what
it describes (`description.ts`, checked in `check-description.ts`), how it is
reached (`connection.ts`, over a `transport.ts`, a `protocol.ts` and the
`channel.ts` between them), the node holding it (`node.ts`), and the ids and
names everything is known by (`ids.ts`, `names.ts`). Abridged: the comments
in the code say the rest. There is one version of it (decision 21).

```ts
export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  id: string;                        // 'atorch.s1w' — stable forever, namespaced
  kind: 'hardware' | 'service';
  meta: {
    name: string; brand?: string; models?: string[]; description?: string;
    category: CategoryId;            // from the SDK's fixed list: 'power-station', 'smart-plug', 'weather'
    support: 'verified' | 'community' | 'experimental'; supportNote?: string;
    icon: string; image?: string; docsUrl?: string;
  };
  describe(config: Config): DeviceDescription;  // parts, attributes, events (§4.2); a session may report its own
  config: ConfigSchema;              // the type's own per-device choices, e.g. a profile; never secrets
  connections: ConnectionMethod[];   // at least one; §4.3
  setup?: { steps?: SetupStep[]; saveAnyway?: string };   // steps of its own, whatever the method
  identify(connection: OpenConnection, ctx: IdentifyContext): Promise<Identified>;  // { identity, model, summary, info?, description? }
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
  createSimulator(ctx: DeviceContext<Config>): Promise<DeviceSession>;   // ctx.connection is null
}

export type ConnectionMethod = {
  id: string;                        // 'wifi' — stable forever within the type
  label: string;                     // 'Wi-Fi' — the holder is added on screen: 'through your server'
  protocol: string;                  // 'sydpower'
  transport: string;                 // 'mqtt' — where it may run follows from this, never declared
  needs?: NodeNeeds;                 // what the node holding it must be, and why: { trusted: 'your password stays at home' }
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
  nearby: boolean;                   // reached only within range of its holder, as Bluetooth: such a way stays with the phone near it
  platforms: Platform[];             // the runtimes it has an implementation for: 'system', 'web', 'native'
  discovery: Partial<Record<Platform, 'list' | 'chooser' | 'none'>>;
  finds: AnnouncementKind[];         // how devices on it are heard: 'broadcast', 'advert', 'client', 'mdns', 'ssdp'
  background: boolean;               // watching costs nothing (broadcasts, a broker's clients): watched all the time
};

export type Transport = {           // one running on one platform: a package entry per place
  definition: TransportDefinition;
  available(): Availability;         // { ok: false, reason: 'This server has no Bluetooth radio' }
  start(): Promise<void>; stop(): Promise<void>;
  watch?(matchers, listener: (sightings: Sighting[]) => void): () => void;  // server and native: a live list, one per host
  choose?(matchers): Promise<Sighting | null>;                              // web: the browser's own chooser
  open(address: string, options: OpenOptions): Promise<Channel>;         // bytes, messages or http
  values?(): Record<string, string>;                                      // the broker's address, for instructions
  diagnostics?: Record<string, (query) => Promise<unknown>>;              // read-only
};

export type Protocol = {            // pure: no I/O, no product meaning
  id: string; label: string;         // 'sydpower'
  bindings: Record<string, Binding>; // per transport: open options, recognise (confirms what a way's matchers picked), instructions,
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
  health(): SessionHealth; // status, a sentence, the last reading: who holds it is the holder's to add
  readings(): Reading[];                                   // every attribute's latest value, settings too; from cache
  description?(): DeviceDescription | null;                // its own, when it differs from the type's: a pack plugged in
  info?(): DeviceInfo | null;                              // manufacturer, model, serial, firmware
  command(request: CommandRequest): Promise<CommandResult>;  // { part, capability, command, args } — the gateway's only
  query?(request: QueryRequest): Promise<Value>;           // data that is not a value now: a forecast, in its declared type
  write?(patch: Record<string, Value>): Promise<Record<string, Value>>;  // attributes it can be told; a readback
  identity?(): { id: string | null; name: string | null };  // what the device says it is, once it has
  tools?: Record<string, ToolRun>;                         // the type's declared tools it can run: /devices/:id/tools/:name
  close(): Promise<void>;
}

export interface DeviceContext<Config> {
  deviceId: SavedDeviceId;
  config: Config;                    // this device's own, validated
  connection: OpenConnection | null; // the method in use, already open; null for a simulator
  store: DeviceStore;                // this device's own
  log: DeviceLogger;
  schedule(everyMs: number, task: () => void | Promise<void>): void;  // cancelled on close
  changed(): void;                   // something changed: for devices that push
  event(id: string, data?, part?): void;  // an event the description declares; checked, kept, published
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
connection**, a session is addressed by **part and capability** and never by
product methods, and nothing a device type runs knows **where** it is running.

### 4.1 Capabilities: a small standard library

A capability is **declared the way a Matter cluster is** (step 23): the
attributes it binds, each to a standard meaning; the commands it accepts, each
with typed arguments from the one value system (`values.ts`), **what makes it
consequential** (step 35) and the attribute it `sets` — which is how the
gateway verifies it; queries for data that is not a value now, each with the
type of its **answer**; and the events a part offering it may raise. Nothing implements a
capability by hand: a session takes commands and queries addressed to a part and
a capability. A part offers a read-only capability when its attributes carry
the meanings it requires, and one with commands or queries when it says so
(`offers`). The set grows deliberately, one reviewed addition at a time, and a
new capability borrows a Matter cluster's meaning and names where one exists.
A package may declare capabilities of its own in its description, namespaced
by its type (`acme.plug.childLock`), in the same shape: offered, commanded and
verified like any other, with no projection and no place in cross-type
automations until promoted to the library.

| Capability | Attributes (meaning) | Commands and queries | Consequential |
|---|---|---|---|
| `switch` | `on` (`on`, required) | `set(on)` sets `on`; turning on **drains** the store behind a load part | turning off while `power` is above the home's `loadWatts` (5 W until set), or not known; or while it is the source of a consequential link. Turning a load on while its device's charge is below the home's `reserveSoc` (none until set): refused to automations and assistants, confirmed by a person |
| `powerMeter` | `activePower` (`power`, required), `voltage`, `activeCurrent`, `frequency`, `energyImported` | — | — |
| `battery` | `soc` (`charge`, required), `capacity` | — | — |
| `acInput` | `present` (`mainsPresent`, required), `activePower`; events `mains.lost`, `mains.restored` | — | — |
| `energyPrice` | `now` (`price`, required), `rank` (`priceRank`) | — | — |
| `weather.forecast` | — | query `hourly(hours)`, answering a list of `{at, temperature, cloudCover, precipitation, irradiance}` | — |

**Projections** (`standards.ts`): every standard meaning, quantity, state class
and capability says what it is in Home Assistant (platform, device class,
state class, unit) and in Matter (cluster, attribute, scale) — or, where
there is no counterpart, why. The maps are typed over the whole vocabulary, so
a meaning or capability without a projection does not compile, and tests
check the units and clusters agree. A bridge to either standard is a lookup
in this table.

What makes a command consequential is declared, and the gateway evaluates
the declaration at the time — it names no domain. Every reading is stamped
with when the device **observed** it, and each attribute says how long a value
stays current (`currentFor`, from its state class when absent: two minutes
for a measurement, an hour for a total); history, the gateway and the app all
hold to it. A device may say a reading still holds without observing it
again — a parked scooter's charge, each time its cloud answers — as
`confirmedAt`: current from then, while `at` stays when it was observed.
Null is unknown — never off, never zero.
The library lives in `packages/device-sdk/src/capabilities.ts`.

A P280's `main` part offers `battery`, its `input.ac` part `acInput`, and
each of its outlets — `outlet.ac`, `outlet.dc`, `outlet.usb` — `switch` and
`powerMeter`; each expansion battery it reports is a part `pack.<n>` offering
`battery`. An ATORCH S1W's one part offers `switch` and `powerMeter`. A weather service offers `weather.forecast`.
Nothing in the core knows any of those products.

### 4.2 Descriptions: parts, attributes, events

A device's **description** (`description.ts`) is what the app draws, the
gateway checks, automations ask for, history is kept by and the bridges
publish. A type declares it for a device's config (`describe`); a session may
report its own and change it — a pack plugged in is a new part — and the holder
keeps the latest with the device.

- **Parts**: `main` always, and whatever the device has several of, each of a
  **kind** from a curated list with an icon (outlet, input, battery, sensor,
  meter, light, lock, valve, …) or one of the type's own, namespaced
  (`acme.hopper`), with its icon; an optional place in the flow of energy
  (`energy: { role: 'source' | 'storage' | 'load' }`) — a lock has none — and
  the capabilities it `offers` beyond what its attributes show.
- **Attributes**: a `key` — what history is stored under, beginning with its
  part when it is not on `main`: the P280's `soc`, `input.ac.present`,
  `outlet.ac.on`, `pack.1.soc`; a value type from the one value system
  (number with unit and precision, boolean, enum, string, timestamp, or a list
  or object of values); how long a value stays **current**; a **meaning** — a
  standard one (`charge`, `power`), whose unit, quantity and state
  class it must keep, or one namespaced by the type (`p280.minutesToFull`); a
  quantity and a **state class** (`measurement`, `total`, `total_increasing`),
  as Home Assistant has them; `read` or `write` — a setting is an attribute
  that can be written; a category (`primary`, `config`, `diagnostic`), a
  section and `dangerous`.
- **Events**: declared with their level and data; raised with `ctx.event` and
  checked against the declaration by the holder.
- **Information**: manufacturer, model, serial, hardware and firmware, from
  `identify` and `session.info()`.

The standard meanings start small and grow only when something needs them:
`charge`, `capacity`, `input`, `mainsInput`,
`solarInput`, `output`, `power`, `energy`, `voltage`,
`current`, `frequency`, `mainsPresent`, `on`, `temperature`,
`cloudCover` (`meanings.ts`) — each one word, named by what it measures, the
part saying where, and read by that word in a rule (`station.charge`,
`charger.power`); a type's own always has a namespace, so the two never meet
— and three a station keeps as settings, so a recipe can change
them without naming a product's keys: `chargeLimit`,
`dischargeFloor` and `mainsInputLimit` (a `number` in Home
Assistant); and `price` and `priceRank`, what electricity costs now
(in the provider's currency: a meaning may allow several units) and where the
hour stands among the day's by price. An on/off has no quantity: it is a boolean, drawn as a band. `validateDescription` checks every rule, and
the contract suite checks a session keeps its description.

**Units** are one enumeration (`units.ts`): every unit kraftverk knows,
what it measures and how it converts, and the units each quantity is
measured in (`QUANTITY_UNITS`, which is also what Home Assistant takes for
it). A number's unit is a `Unit`, never free text — in a description, a
meaning, a setting, a rule's own numbers — so a typo does not compile; one
arriving as data is refused by `validateDescription`, the rule checker and
the file's schema; and the app offers a unit as a choice among those of its
dimension, never a text field. Numbers of one dimension meet converted
(`2 kW` beside a reading in W is 2000 W); two dimensions never meet.

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

Each step **runs on the node that will hold it**, against a **draft** there:
the master's for a way it holds, a follower's — the app's — for one it holds
for the master, which judges what the follower read. The save is always the
master's, in one transaction. A type may offer **save
anyway** after a failed check when failure is expected, as it is for a station
that is asleep. The first successful connection then fills in the identity.
Secrets a step on the master finds stay on the master; the app sees a
short-lived placeholder (see [SECURITY.md](SECURITY.md)). A connection's
secrets stay on the node that holds it: those of a way a follower holds never
reach the master.

### 4.4 Links between parts

Some facts are about the house, not about any one device: *this plug's output
feeds that station's AC input*. They are recorded as **links**, not as part of
either device and not inside an automation, because several things need them:

- the gateway, whose second proof after a command on a linked part is the
  target part's own evidence (§4.6);
- the energy-flow view;
- any number of automations.

A link joins **parts**: a plug's `main`, a station's `outlet.ac`, another
station's `input.ac`. Its kind says which capability each end offers, which
meaning on the target should follow which on the source, whether one source
part has one target, and whether being its source makes a command
consequential:

| Kind | From | To | Evidence | One per source | Consequential |
|---|---|---|---|---|---|
| `feeds` | a part with `switch` | a part with `acInput` | `mainsPresent` follows `on` | yes | yes: cutting it, and the first command through it |

The gateway walks every link from the part it commands, of any kind, by these
declarations; it names none. The second kind comes with the first device
that needs it (`charges`, `measures`). Removing either device removes the
link. Links replace the global "which station does the relay feed" key, and
are set while adding a device ("What is plugged into this plug?") or later on
either device's page.

### 4.5 The data model

The catalog is the backbone. A device exists because the user added it, and it
keeps its history while it is unplugged — and after it is removed, until its
history is deleted on purpose. The model, with an example for every field and
the reason for every table, is [DATA-MODEL.md](DATA-MODEL.md). In short:

```sql
device            (id PK, type_id, identity, name, config JSON, description JSON, info JSON,
                   place_id → place, added_at, removed_at)
device_attribute  (device_id → device ON DELETE CASCADE, key, part, spec JSON, first_seen, last_seen)
device_connection (id PK, device_id → device, method, transport, held_by → node, address,
                   priority, config JSON, created_at, last_connected_at)
connection_secret (connection_id → device_connection ON DELETE CASCADE, field, value, encrypted)
                                                      -- only the ways this database's node holds
node              (id PK, name, platform, always_on, reachable, trusted, transports JSON,
                   place_id → place, account_id → users, self, created_at, last_seen_at)
home              (id PK, name, master_id → node, created_at)       -- one: which node is the master
place             (id PK, key, name, latitude, longitude, time_zone, created_at)
device_kv         (device_id → device ON DELETE CASCADE, key, value)
device_link       (id PK, kind, source_id → device, target_id → device, created_at)
sample            (device_id → device ON DELETE CASCADE, key, at, value | text)     -- 14 days
sample_hour       (device_id → device ON DELETE CASCADE, key, hour, min, avg, max, n) -- 2 years
device_event      (id PK, device_id → device ON DELETE CASCADE, part, event, level, data JSON, at)
automation        (id PK, name, recipe, roles JSON {role: {device, part}}, params JSON, time_zone,
                   mode, created_at, updated_at, last_run_at, last_result JSON)
audit, home_setting, login_session (the server's own: users)
```

- **Ids are opaque and permanent.** New ids carry no meaning.
- **`type_id` is immutable.** Changing what a device *is* means adding a new
  one; its history would not mean the same thing.
- **Identity, not address, is the device.** One device per identity among those
  not removed; an exclusive transport's address belongs to one device.
- **A device keeps its description.** The latest — its type's, or its own — is
  kept with it, and `device_attribute` records every attribute it has ever
  had, so a pack's history keeps its name after the pack is unplugged.
- **Config is validated** against the schema its definition declares, on every
  write. Secrets are never in it.
- **Remove keeps history;** deleting history is a separate, confirmed action.

**One schema, not a chain of migrations** (decision 21). The schema is
`packages/store/src/schema.ts`, and its fingerprint is kept in the database's
`user_version`. A database made by any other schema is not changed: it is set
aside beside itself — `kraftverk.db.set-aside.<time>` — and a new one started.
Nothing is deleted; history from the old schema is not carried over. Every
column that can be required is: a null is left only where it means something.

### 4.6 The gateway: every command, one path

Every command — from a screen, an automation or a bridge — goes to one part of
a device, through
`POST /api/devices/:id/parts/:part/commands/:capability/:command` and the
action gateway; every write of a device's settings through
`PATCH /api/devices/:id/attributes` and the same gateway. It names no
capability, no link kind and no domain — what a command takes, what it sets
and what makes it consequential come from the capability's declaration (the
library's, or one the device's description declares); what a link proves
from its kind's — and applies, per part:

- that the part offers the capability, and the arguments are the command's own,
  of the right types;
- confirmation where the command is **consequential** as declared — `switch.set`
  turning off a part whose `power` is above `loadWatts` — or the part is
  the source of a link whose kind says being its source is (cutting what feeds
  a station), and for the first command through such a link. A declared
  condition that cannot be judged — the part reports the meaning, but nothing
  current — counts as holding: unknown is never taken for the safe answer. A
  part that does not report it at all makes no claim, and only a link can make
  its command consequential;
- thresholds a declaration names rather than fixes: the capability says what is
  consequential, the home says how much (`POLICY_VALUES`, set in App settings,
  kept by the home in `home_setting` and served at `/api/policy`);
- the home's **reserve**: a command declared to drain (`drains`) — turning a
  load part on — on a device with a `storage` part, changing something, while
  that store's `charge` is below `reserveSoc` or not known: refused to
  automations and agents, confirmed by a person (docs/SHARED-PARTS-AND-RESERVE.md);
- confirmation as a **token**, not a word: the refusal hands out one bound to
  the device, part, command and arguments (or the patch) and the person,
  good once, for a minute; the retry presents it. Arming an automation is
  confirmed the same way;
- an **agent** — an assistant acting for a person, over MCP — does what needs
  no one's yes, with a minute's dwell per part; what needs a person's
  confirmation, and a setting that can damage the hardware, is refused to it
  with a sentence saying so, and no token;
- read-only mode;
- dwell time, per part;
- a **run's** allowance (docs/SEQUENCES.md): an automation's commands within
  one run carry the run. The run's first switch of a part meets the dwell of
  whoever asked for the run — a person's, an agent's, or, started by its own
  triggers, an automation's. After that, the run may switch the part again
  after the gateway's least gap (`runGapMs`), as often as its rule allows and
  never more than the gateway's ceiling (`runSwitchCeiling`). The gateway
  forgets a run's counts when it ends. An agent may start a sequence a person
  has let act: that person's letting it act is the yes. Its run switches as an agent's,
  and what needs a person's confirmation is still refused to it;
- fresh data: acting needs readings that are current for their attribute and
  no older than the policy allows, and an unknown value is never read as a
  value;
- verification: reading back the attribute the command `sets`, plus every
  link from the part — the target part's evidence must come to agree, from a
  reading taken after the command: a station's `mainsPresent` following the
  plug that feeds it;
- for a write: only attributes that can be written, held to their types, a
  dangerous one confirmed by a person and never changed by an automation; and
  what is left of its dwell, so a screen keeps the control busy that long
  rather than let the next nudge be refused;
- an audit entry naming the account, the automation or the client.

The gateway's rules are shared code, not a server route's: when a phone or
browser holds a device's connection, the same rules run there, and the audit
entry is sent to the server (queued while offline).

A type's **tools** are not commands and do not pass through the gateway; the
holder checks them against their declaration (`runTool`), refuses one that
writes while read-only, and audits it. One that declares what it cannot undo
(`ToolSpec.confirm`) is confirmed as a command is: the server refuses it with a
token for a person's yes, good once, for a minute.

**The one write outside it.** A session may keep up, by itself, a state a
person asked for through the gateway, and nothing more: the socket profile's
`refresh` renews a plug's fast readings (the ATORCH's datapoint 140) when the
plug lets them lapse, for as long as the `live` attribute — written through
the gateway, audited — says so. It is a heartbeat, not a control: it changes
nothing a person can see or rely on beyond what they asked, is never sent
while read-only, never twice within ten seconds, and stops when the wish runs
out. Anything else a session would write on its own is a command, and goes
through the gateway; the next exception has to argue against this paragraph.

### 4.7 At runtime

```
          installed packages (found at start on the server; the generated registry in the app)
   ┌──────────────────────────┬──────────────────────────┬──────────────────────────┐
   │ device-aferiy-p280       │ device-atorch-s1w        │ integration-open-meteo   │
   │  integration-sydpower    │  integration-tuya        │  its weather service     │
   │   its protocol           │   its protocol           │   its own API            │
   │  transport-mqtt, -ble    │  transport-lan           │  transport-https         │
   └────────────┬─────────────┴────────────┬─────────────┴────────────┬─────────────┘
                ▼                          ▼                          ▼
master:  DeviceTypeRegistry ──► SessionManager (holder): for every device, the connection in use,
         TransportHost (starts what      │ readings, description,│ commands, writes
         installed types need)           │ events → LiveBus      ▼
                                   Sampler / history       ActionGateway ◄── device links
                                   catalog, event store          ▲
                                         └──► AutomationEngine ──┘
follower: the same registry, SessionManager and gateway rules for the ways it holds; readings and audit
         go up to the master · device types → the add flow · generic device view + optional panels
```

The MQTT broker stays a separate process, because stations must stay connected
while the server restarts. It belongs to `transport-mqtt` and knows no
protocol: each integration's protocol binding supplies its topics and its guard, which the
broker applies to every publish, so the register-68 refusal stays at the broker.

---

### 4.8 Next to Home Assistant and Matter

Reviewed 2026-09-29, for the direction in [PRODUCT.md](PRODUCT.md): a hub
where every device gets first-class support, written as code — standards the
floor, packages the ceiling. Two models are worth measuring against: **Home
Assistant**, the hub most of our users already run, and **Matter**, the
standard most devices will speak.

| | kraftverk | Home Assistant | Matter |
| --- | --- | --- | --- |
| **The unit of support** | Two: an integration per platform (ways in, setup, builder, generic type) and a device package per product on it (category, a description, session, simulator) | An integration: `manifest.json`, a config flow, entity platforms, a Python library beside it | A device type: an endpoint with required clusters |
| **A device** | Identity read from the device; a type; a name; config | Device registry: identifiers, connections, manufacturer, model, firmware, serial, `via_device` | A node: Basic Information (vendor, product, serial, versions) |
| **Its parts** | Parts, since the model was rebuilt (2026-09-29): `main`, `outlet.ac`, `pack.1` | Many entities on one device | **Endpoints**, each with its own clusters |
| **What it can do** | Capabilities, from a small library | Entity platforms (switch, sensor, light…) and `supported_features` | **Clusters**: attributes, commands, events |
| **What it measures** | Attributes: stable key, value type (enum and text included), meaning, quantity, state class, category | Sensor: `device_class`, `state_class`, unit, `entity_category`; enum and text states | Attributes, typed, enums included |
| **Where the description comes from** | Declared by the type, or reported by the device and kept with it | Integrations create entities at runtime from what the device reports | Read from the node's descriptor |
| **Things that happen** | Declared events, checked, kept and published | Events, event entities, device triggers | Events |
| **Reaching it** | Connection methods — protocol over transport — several per device, failover across holders | One config entry per device; `iot_class`; discovery matchers in the manifest | Operational discovery over IP; commissioning over BLE |
| **Protocol code** | Pure packages, run on the server, in a browser and on a phone | A library on PyPI, by rule | The SDK |
| **Physical safety** | One gateway: schema, confirmation, verification, audit | A service call | Access control lists |
| **Automations** | Recipes in the core, their roles filled by parts | Automations, blueprints, device automations from integrations | Out of scope |
| **Evolving a type** | Not yet: strict version 1 until there is data to protect (decision 21) | Config entry versions and migrations | Spec revisions |

**Where kraftverk is already ahead, and should stay:** connections apart from
devices, with failover across holders; a device *is* its identity, so history
survives removal and re-adding; one gateway for every physical action;
protocols that run in a browser; links between devices; services as devices;
a simulator for every type.

**What to borrow:** Matter's **endpoints**, as parts; descriptions that come
**from the device**; Home Assistant's **device information**, **state classes**,
**diagnostic entities**, **enum values**, **events** and **config-entry
migrations**; and Matter's **cluster semantics** as the source of new
capability names, so that bridging to either standard is a table rather than
a project.

**What not to borrow:** an entity registry with per-entity overrides (a
package decides what its device is); YAML; one integration owning many
devices through one config entry (connections already do better); unit
conversion and translations — later, when users need them.

**Matter and Thread, when they come.** Matter is an integration over IP,
with Bluetooth only for commissioning; [matter.js](https://github.com/project-chip/matter.js)
is a TypeScript controller that fits the package model. A Matter device
describes itself — endpoints and clusters — so it arrives as one generic type
whose description is read from the node, which is the ability steps 23, 25
and 27 build. Its fabric (certificates, node ids) is state of the transport
(step 31). Commissioning is setup steps: a pairing code, then the device joins
kraftverk's fabric; a device already in Apple or Google Home can be shared in
by its pairing code (multi-admin). **Thread is not something kraftverk
speaks**: a Matter-over-Thread device is an IPv6 host behind a border router
(an Apple TV, a Nest hub, OpenThread's border router), so kraftverk needs no
radio — only, for commissioning a new Thread device, the network's
credentials, from a border router or shared from another home. Open
questions for a spike: matter.js under Bun, and IPv6 multicast from inside
Docker. Zigbee and Z-Wave stay out, or come in through Zigbee2MQTT as another
generic, self-describing type.

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
exceptions, and no product word outside its package (counted for every
installed package since 2026-09-29, the P280's alone before). The table is
kept as the record of why the layout is what it is.

<!-- kept as written -->

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
| G10 | Retired vocabulary in configuration: `STATION_DRIVER`, `--driver` — *fixed 2026-09-29: there is no transport setting at all* | 22 |
| G11 | The app's device state and add screen are too big to change safely | 22 |
| G12 | Segmented controls cannot be operated from a keyboard or a screen reader | 22 |

**A third review, 2026-09-29**, against Home Assistant and Matter (§4.8), for
the direction in PRODUCT.md: every device first-class, standards the floor.
What it found is in the data model.

| | Finding | Step |
|---|---|---|
| H1 | Parts are encoded in names. Outlets exist only as the metric pattern `outlet.<id>.on`, an `outlets` capability with its own `set(id, on)`, and a `target` parameter; nothing else a device has several of — battery packs, solar inputs, a strip's sockets — can be said | 24, 26 |
| H2 | A device's description is fixed per type. The P280's expansion batteries (none to several) exist only in its own screen: no history, nothing an automation or a bridge can see. Every standard describes its devices at runtime, so none of them can be a type today | 24, 25 |
| H3 | Values are numbers or booleans (`Reading.value`, `sample.value REAL`): no enum — a station's mode, a fault — and no text | 23, 24 |
| H4 | No device information: firmware, hardware revision and serial are not in the model; the P280's firmware versions are a register tool | 24 |
| H5 | No events: a device cannot say that something happened — a button, an overload trip, a fault — except as a log line nothing can trigger on | 24, 29 |
| H6 | Thin measurement semantics: `cumulative` cannot say a counter that resets daily; nothing marks a diagnostic value (signal strength) to keep it off the dashboard; nine kinds, none for the first sensor that arrives | 23, 24 |
| H7 | Automations belong to the core (`server/src/automations/recipes.ts`): a package cannot bring the automations its device is for — *fixed 2026-09-29: recipes and functions come from packages* | 29 |
| H8 | Types cannot evolve: no version, no migration of a saved device's config or store when its type changes | 24 |
| H9 | No shared vocabulary with the standards: capabilities and kinds map to nothing in Home Assistant or Matter, so every bridge would invent its own | 23 |
| H10 | Refinement exists only inside the Tuya package: its profiles make the ATORCH a layout over the generic socket — standards the floor, packages the ceiling — but nothing lets a package refine a device another protocol found | 30 |
| H11 | Discovery and reach under-declared: filters know Bluetooth services, name prefixes and UDP ports, not manufacturer ids, mDNS, DHCP or USB; nothing declares whether a method needs a cloud, though the README promises nothing leaves the network unless setup needs it | 30 |
| H12 | Transports keep no state: a Matter fabric, a Bluetooth bond or a broker's credentials have nowhere to live | 30 |
| H13 | Quality is implicit: the support level is the only signal; no checklist a package can be measured against, no diagnostics bundle for a *My device differs* report | 32 |

---

<!-- /kept as written -->

## 7. Guardrails in CI

`npm run check:architecture` (`scripts/architecture.mjs`) fails the build when:

- **the dependency rule** (§3) is broken by a new import;
- **the leak count** rises: the number of words that mean one product in
  shipped files where that product is not. The words are derived from what is
  installed: every integration and device package's folder name, the
  `brand` it declares, and the words it lists in its package.json
  (`kraftverk.words`: the P280 lists `p280`, `StationStatus`, `gridRelay`…;
  the Sydpower integration the brands it speaks for). They are counted in the
  core, and in a package that neither depends on that product nor shares the
  word (the Tuya integration may say Tuya). Transports are technologies, not
  products, and the core may name them. Tests are held to the dependency rule
  but not counted: a test that drives a real device type through a core route
  moves with that route. Nor is a pointer to a document such as
  `docs/P280-FINDINGS.md`;
- **purity** is broken, from step 4: a protocol or a device type's `src/`
  imports a Node or Bun built-in (`node:*`, `bun:*`), or a transport, or
  anything else that does I/O. Those packages run in the app as well as on the
  server, so this is what keeps "the code doesn't know where it runs" true;
- **a transport** imports anything from kraftverk but the SDK, or its `web`
  or `native` entry reaches its `server` one;
- **the layers** are crossed (decision 22): a core package imports one the
  table `MAY_IMPORT` does not list for it — up the layers, by a path into
  another package, or the server or the app — or a device type imports the
  core beyond the SDK and the language. A folder under `packages/` with no
  place in the table fails outright;
- **a shared package needs the platform**: each — the core's, every
  protocol, device type and service — is bundled for a browser with its
  dependencies, and a Node or Bun module in the bundle (an import, or Bun's
  stand-in for one) fails outright. `npm run typecheck` checks the same
  code against only the globals every place has
  (`tsconfig.shared.json`, `packages/device-sdk/everywhere.d.ts`), so a
  built-in, `process` or `Buffer` fails where it is written;
- **logic is written in the server or the app**: a file in `server/src`
  outside its routes, accounts (`auth/`), platform and process (`app.ts`,
  `index.ts`, `log.ts`, `config.ts`), or a `.ts` in `client/src` with no
  screen in it outside `platform/`. There are none since
  [PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md) moved them out, and a new one
  fails the check;
- **a document names what is not there**: a path, or a link, in a document
  [docs/README.md](README.md) lists as current, a package's README or
  AGENTS.md; and every document in `docs/` is listed there, as current or
  as a plan or record kept as written.

The import rule, the product words and the placement of logic are held by a
baseline, `scripts/architecture-baseline.json`, which is empty — there are
no exceptions left — and the rest fail outright. A baseline may only shrink: a file whose count falls
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
| 21 | Secrets at rest in the app | S | done |
| 22 | Loose ends: configuration words, big modules, accessibility | M | later |
| 23 | The model, 1: one value system; declarative capabilities; projections into Home Assistant and Matter | M | done |
| 24 | The model, 2: parts, attributes, device information, events | L | done |
| 25 | Storage and holders carry descriptions | M–L | done |
| 26 | Packages on the new model; the gateway typed and generic | L | done |
| 27 | The API: descriptions, typed commands, a live stream | M | done |
| 28 | The app: pages from descriptions, slots, a kit for packages, live | L | |
| 29 | Automations from packages; event and threshold triggers | M | done, as a language |
| 30 | Refinement, discovery, reach, transport state | M | |
| 31 | The Home Assistant bridge | S–M | |
| 32 | Packages from outside the repository, and rails for contributors | M | |
| 33 | The first standard floor: BTHome, then Shelly and ESPHome | M | |
| 34 | A Matter spike | M | |
| 35 | The model, part 3: time, structure, consequence, parts and links, tools as data | L | done |

Each step below is kept as it was written when it was planned or done: the
paths in it are those of its day.

<!-- kept as written -->

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
type and session, and names no product. (Since moved: finding packages on
disk to `server/src/platform/packages.ts`, the sessions to
`@kraftverk/holder`, the registry to `@kraftverk/hub`.) The P280 package now holds its
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

*Done* for the web, where secrets were kept: `SecretVault` seals every
connection's secrets with AES-GCM under a non-extractable key in IndexedDB,
one vault per server and one for local mode, whose catalog keeps its secrets
there too. Reads come from what was opened at start; plaintext from before
moves in and is cleared. Where there is no key, nothing is written down. A
phone persists nothing yet — its preferences are memory — so a secure store
there (`expo-secure-store`) comes with persisting its preferences at all.

### Step 22 — Loose ends (G10–G12)
The app's device state and add screen split, and segmented controls a
keyboard can reach. (G10 is done, further than planned: there is no transport
setting at all. Every installed transport is available, and simulation is a
way to add a device — the simulated method every type has — not a mode of the
server.)

### Steps 23–34 — The model first, then everything above it

Planned 2026-09-29, from the review in §4.8 and findings H1–H13. The idea:
**the device model is the foundation everything else is a projection of** —
what is stored, what the API says, the pages the app draws, what the gateway
checks, what automations need and what the bridges publish. Make it right, and
each layer above becomes simple and generic; a package's deep integration and a
standard's generic one become the same thing at different depths.

```
  description = info + parts + attributes + commands + events
  source      = declared by the type | reported by the device | refined by another package
```

One vocabulary, borrowed from Matter: a **part** (an endpoint) offers
**capabilities** (clusters) made of **attributes**, **commands** and
**events**. The old step 20 (a version handshake) is dropped under decision 21
— there is one version; step 22 goes alongside 28.

**How 24–26 were done, 2026-09-29.** The plan was an adapter that let the old
contract and the new one live side by side while packages moved one at a time.
The owner decided instead that nothing is kept backward compatible while
kraftverk is in research and development (decision 21), so the model changed
everywhere at once: the SDK has one contract, every package is written against
it, the gateway, holder, server, API and app speak it, and the database is one
schema. The adapter and the type versions it would have needed were removed
before they shipped.

### Step 23 — One value system, declarative capabilities, projections (H3, H6, H9)
- **`values.ts`: one value system** — number (unit, range, step, precision),
  boolean, enum (options), string — used by attributes, command arguments,
  event data and config alike. Config fields become a value type plus
  presentation (`secret` and `host` are strings shown their own way).
  `null` is unknown, never off or zero.
- **Capabilities are declared like clusters**: the attributes they bind — each
  to a standard meaning (`charge`, `power`) — the commands they
  accept, with typed arguments, a safety level, and which attribute each one
  `sets`, and queries for data that is not a current value (a forecast). The
  hand-written capability interfaces stay until step 26.
- **`standards.ts`: projections.** Every quantity, state class and capability
  maps to Home Assistant (platform, device class, state class, unit) and to
  Matter (cluster, attribute or command, scale), or says `none` and why. A
  test keeps the table complete. From here on a new capability borrows a Matter
  cluster's meaning where one exists.

**Done when** every capability and quantity has its projections under test,
and config is validated by the value system.

*Done.* `values.ts` holds the value system and `checkValue`; a config field is
a value type plus presentation, validated by it. Capabilities declare their
attributes (by standard meaning), commands (typed arguments, safety, what they
set) and queries; `requiredMeanings` replaces the old `requires` list.
`stateClass` replaced `cumulative` outright — one package used it. New
meanings `current` and `frequency` give a plug's current and frequency a
standard name, and the quantities gained humidity, illuminance and signal.
`standards.ts` projects every meaning, quantity, state class and capability
into Home Assistant and Matter, with `homeAssistantEntityOf` as the one call a
bridge needs. `energyMeter` stays inside `powerMeter` (its `kwh`) until a
device measures energy without power.

### Step 24 — Parts, attributes, information, events (H1, H2, H3, H4, H5)
The device-type contract:
- A **description** — parts, attributes, events — that a type declares
  (`describe(config)`) and a session may report and change
  (`session.description()`): a pack plugged in is a new part. Keys of parts
  that come and go derive from the device (`pack.1.soc`).
- **Parts**: `main`, and whatever a device has several of, each with a kind and
  a role — source, storage, load — so an energy flow can be drawn for any
  device. A part's capabilities are derived from its attributes' meanings and
  what it `offers`, never declared twice.
- **Attributes** replace telemetry, settings and controls.
- **Device information**, from `identify` and `session.info()`.
- **Events**, declared, raised with `ctx.event`; `ctx.changed()` for devices
  that push.
- The session: `readings()`, `command({ part, capability, command, args })`,
  `write(patch)`, `query(…)`, and the tools it runs (step 35: declared as data).

*Done.* `description.ts` is the model, with `capabilitiesOf` deriving a
part's capabilities and `validateDescription` checking one; `device-type.ts`
is the one contract. The contract suite knows no capability by name — it flips
any on/off attribute a command `sets`, asks every query, round-trips a written
attribute and checks every event raised — and runs over every installed
package. A test station in `model.test.ts`, whose pack is reported by the
device, keeps it; one flaw at a time, it does not.

### Step 25 — Storage and holders carry descriptions (H2)
*Done.* The one schema (`schema.ts`) keeps each device's description and
information; `device_attribute` records every attribute a device ever had;
`sample` holds a number or text; `device_event` keeps what devices raised;
automation roles name a device and a part. The holder (`openDevice`) gives
each device's current description and information and checks every event
against it; the server's session manager records them — on open and on every
check — and publishes readings, events and description changes on a
`LiveBus`. An app holding a device sends its description up with its
readings. The sampler keeps only what a description says to keep. Links stay
between devices: a `feeds` link runs from the source's main part to the
target's part that offers `acInput`, found when it is used.

### Step 26 — Packages on the new model; the gateway typed and generic (H1)
*Done.* The P280 is parts — the station, its mains and solar inputs, its three
outlets and each expansion pack it reports — with its settings as writable
attributes in sections, its operating state an enum and its firmware as
information; the plugs and the weather service likewise. The gateway takes a
typed command to a part, checks the part offers the capability and the
arguments are the command's own, judges confirmation by that part's load and
links, and verifies by reading back what the command `sets`; settings are
written through `ActionGateway.write`, the same path. `OutletsCapability`,
the `outlet.<id>` pattern, `SettingsSpec`, `ControlSpec`, `MetricSpec` and
`ACTUATORS` are gone. The generic pages draw controls from the commands parts
take, readings part by part, and settings from writable attributes by section.

### Step 27 — The API (H2)
`DeviceView` carries the device's information, description and readings;
commands go to `/devices/:id/parts/:part/commands/:capability/:command` with
typed arguments, writable attributes to `PATCH /devices/:id/attributes`, and
`GET /devices/:id/events` lists what a device raised — *done*, with the model.
The live stream is *done* too (2026-09-29), as a **WebSocket**, not
server-sent events: `GET /api/live` (docs/API.md). A phone's React Native has
no `EventSource`, and one socket can later carry an app's own readings up as
well. The session manager publishes on the `LiveBus` only what moved (a
reading by value, health when it changes), at once when a device pushes or
finishes a poll, and on a one-second pulse otherwise, so a package that never
calls `ctx.changed()` still streams. Each socket coalesces and sends at most
four times a second; a change made through the API says `changed`, and the
app reads the list again. The app polls only while the socket is down.
**Done when** the app updates without polling — it does. Next, on the same
socket: the readings of connections an app holds, sent up as they arrive
rather than every 20 s.

### Step 28 — The app: pages from descriptions, slots, a kit, live
Generic pages drawn from the description: parts as sections, controls from
commands, settings from writable attributes by section, history per
attribute, events, *About* from the information, an energy flow from part
roles. A package's screens become **slots** — a card, a dashboard, a section
for a part, settings, tools, recipe editors — so it deepens one piece and
inherits the rest, built from a kit in `packages/ui`. Live through the stream.
**Done when** the ATORCH has a full page with no screen code, and the P280
overrides only what it draws better.

*Done* (2026-09-29, NEXT-STEP-ARCHITECTURE.md phase 5). Slots are `DeviceUi`
in `@kraftverk/api-client` — `dashboard`, `parts` (by id or kind), `settings`,
`tools` — and the kit in `packages/ui` is `PartCard`, `ReadingRow`,
`EnergyFlow` (from part roles and links), `EventList`, `InfoCard` and
`ToolPanel`, each taking model types only. Every device has a page per part,
its events (the server keeps an app-held device's too, at the level its
description declares) and a problems page across devices, *About*, and its
tools drawn from their declarations. The P280's screens draw from its
readings and links: its `state` tool is gone, and every figure it shows is a
declared attribute. On the web a toggle is a real `button`, so it is operated
from the keyboard. The `card` and recipe-editor slots wait for a package that
needs them.

### Step 29 — Automations from packages (H5, H7)
`defineRecipe` in the SDK: roles as capability needs over parts, parameters
in the value system, a decision and a sentence. Packages export recipes; the
engine runs every installed one through the same gateway, modes and audit.
Triggers: a schedule, an event, an attribute crossing a threshold.
**Done when** the forecast recipe ships from the weather package, and a
threshold recipe runs observe → act.

*Done* (2026-09-29), as a language rather than as code: see
[AUTOMATIONS.md](AUTOMATIONS.md). A recipe is a **rule** — roles, settings,
triggers (`at`, `event`, `becomes` with `heldFor`), a condition and
gateway commands, over the model's own words — checked before it runs
(`checkRule`, `checkBinding`), evaluated three-valued with a trace, and read
as a sentence. Code enters only as **functions** a package contributes. The
weather package ships `skyLooks` and "Switch by the forecast"; the station
declares `mains.lost` and `mains.restored` events and ships "When the battery
runs low" and "When mains power is lost"; the core has no recipe. The same
language is what a DSL and an AI in the app will write.
`WeatherHour` and `QueryAnswers` left the SDK for the weather protocol, and
the time-zone helpers moved into it. An action names its capability, so a
role no longer has to (NEXT-STEP J40).

### Step 30 — Refinement, discovery, reach, transport state (H10–H12)
A type may **refine** another (`refines: { type, match }`), offered at the
check like another model is today; the Tuya profiles become refinements. A
protocol may ship a generic, self-describing type — the floor. Filters gain
Bluetooth manufacturer ids, mDNS, DHCP and USB; a method declares its
**reach** (local push or poll; cloud never, at setup, or always); a transport
gets a store and secrets of its own. **Done when** the ATORCH is a refinement
and the add screen states reach from declarations.

<!-- /kept as written -->

### Step 31 — The Home Assistant bridge
MQTT discovery, written entirely from the projections of step 23; commands
from Home Assistant go through the gateway as actor `home-assistant`;
dangerous settings and tools are not bridged. **Done when** a device appears
in Home Assistant with the right classes and switching it there is on
kraftverk's timeline.

### Step 32 — Packages from outside the repository; rails for contributors (H13)
A `kraftverk.packages.json` names packages from npm or a folder, which the
server's discovery and `gen:devices` include and one command builds into an
image — trust stays explicit, nothing is downloaded from a screen. The SDK on
npm; `npm run check:packages` measures each package and writes the README's
device table; a recording tool turns a session's bytes into a fixture and a
replaying simulator; a diagnostics bundle per device, secrets redacted; an
`AGENTS.md` for device packages. **Done when** a package outside the
repository builds into an image and passes the checks.

Before the first package from outside — found in a review on 2026-10-02,
decided then, not built until this step:
- **The closed lists.** Which of the SDK's fixed lists are a reviewed
  taxonomy, grown here, and which become data a package contributes:
  `CATEGORIES` (5), `Quantity` (15), `LINK_KINDS` (1), `POLICY_VALUES` (2),
  `EventLevel` (3), `SupportLevel` (3). A quantity becomes a declared record —
  its unit, formatting and chart — so adding one is a row, not a union threaded
  through the app; categories grow toward Home Assistant's breadth. A
  support level becomes a checklist a package is measured against.
- **The contract's version.** A package's `kraftverk` section says which
  contract it was written for, and the server says "written for 2, this is 3"
  rather than refusing it with a validation error. Strict version 1 has one
  exception for this, as it has one for the configuration file — the day the
  SDK leaves the repository.
- **Namespaces.** A type's id, and every meaning it declares, carries its
  namespace (meanings are only checked for a dot today); a namespace is
  claimed by the first package to publish it, and the manifest list pins it.
- **Trust.** What a package may reach — the purity check gives most of it —
  and the dependencies it may bring, as an allowlist the bundle check holds,
  written down before the first upload. Sandboxing is a later decision.

### Step 33 — The first standard floor
BTHome (passive Bluetooth, self-describing), then Shelly and ESPHome, each a
generic type. **Done when** a BTHome sensor works with no package of its own.

### Step 34 — A Matter spike
matter.js as a protocol over IP, commissioning over Bluetooth, the fabric in
transport state; Thread through a border router, multi-admin first. **Done
when** there is a recorded go or no-go, with the path for Thread.

### Step 35 — The model, part 3 (NEXT-STEP-ARCHITECTURE.md phase 1)
Everything the review of 2026-09-29 found the model could not say, changed
everywhere at once (decision 21):

- **Values**: `timestamp`, `list`, `object` (with required fields); a config
  field is a value type with a **presentation** (`secret`, `host`,
  `multiline`, `slider`), not a type of its own. `ValueOf` derives the
  TypeScript type from a declaration.
- **Time**: a reading's `at` is when it was observed; `AttributeSpec.currentFor`
  says how long it stays current, and the sampler, the gateway, the rule
  engine and the app's cards hold to it. Weather history is continuous: its
  readings were stamped with the hour they were about, and the sampler kept
  two minutes of every sixty (J2, J20).
- **Capabilities**: queries declare their `answer` (the forecast's hours; the
  weather function reads a checked answer, with no cast); commands declare
  what makes them `consequential`; a package may declare its own,
  namespaced; `powerMeter`'s attributes take Matter's names; `acInput`
  declares the events it raises (J3, J10, J12).
- **Meanings**: `temperature` and `cloudCover` replace the weather
  service's; the quantity `state` is gone (J9).
- **Parts**: curated kinds with icons and a namespaced escape; the energy role
  optional; a key off `main` begins with its part, enforced, and `sample`
  and `sample_hour` carry the part (J1, J8).
- **Links join parts** (`device_link` has both ends' parts); a kind declares
  its evidence and whether being its source is consequential, and the
  gateway walks every kind from a part — it names none. A station's outlet
  can feed another station (J4, J5).
- **Categories** are shelves with no product prose; the add screen's sections
  come from each type's `kind` (J7, J11).
- **Reach** on every connection method: `local`, `cloud-at-setup`, `cloud`
  (H11, J19).
- **Tools declared as data** (`DeviceType.tools`): what each asks for and
  answers; the holder checks both ways, and the contract suite runs every
  tool that only reads (J15). `/devices/:id/advanced` is
  `/devices/:id/tools`.
- **Screens are not told who holds a device**: `DeviceScreenProps.holder` is
  `reach` — whether actions reach it now, and what to say while they do not
  (J16).
- **Ids are branded**: connection, app, link and automation ids, like the
  device id (J14).
- **Automations**: a function is handed a read-only view of its part —
  readings, health, checked queries — and nothing that acts; recipes that
  need only the shared vocabulary live beside it in the SDK
  (`standard.low-battery`, `standard.charge-between`,
  `standard.mains-lost`), and a package keeps only what its devices alone
  make possible.

*Done* (2026-09-29). The contract suite checks query and tool answers
against their declarations, a P280 outlet can feed a device, weather history
is continuous, and the architecture check stays at zero.

---

## 9. Decisions

1. **Which station a plug feeds** is a link between parts of two devices
   (§4.4; between devices until step 35) — a fact about the house that the
   gateway, the energy-flow view and automations all read — not part of
   either device, and not inside one automation.
2. **In-app Bluetooth** is not a special path. It is a connection held by the
   app's node, following the master (step 12; decision 24), and the old path
   is gone.
3. **Unverified station models** are removed. One comes back as its own type,
   reusing the P280's code, when someone with the hardware writes it.
4. **Services** live in `packages/services/*`, found by the same discovery.
   (Changed 2026-10-06: a service is the platform's own type, so it is its
   integration's, in `packages/integrations/*` — PLAN-INTEGRATIONS.md §1.)
5. **Trust:** device types come from this repository only (§5).
6. **Order:** the plugs move before the P280 (§8), unlike the review, which
   moved the P280 first.
7. **Metric keys** stay as stored; standard ids are a mapping on top (§4.2), so
   no history is rewritten.
8. **A device type declares connection methods, not transports and protocols
   separately.** Each method is one protocol over one transport, because not
   every protocol rides every transport. Where a method can run is never
   declared: it follows from which nodes have its transport, and what the
   method needs of the node that holds it (`needs`, decision 24).
9. **The code doesn't know where it runs.** Protocols and device types are
   pure, and all platform code lives in transports, one implementation for
   each place. The server and the app run the same session code.
10. **Setup belongs to the method and is assembled from its layers.** Each
    step runs on the node that will hold it: the broker's list on the node
    that has the broker, the browser's Bluetooth chooser on a browser's node.
11. **A device is its identity, read from the device.** It is never its
    address, because browsers and phones hide or scramble addresses. The same
    station found two ways is one device with two connections.
12. **One connection in use at a time** per device: the reachable one with the
    lowest priority.
13. **Removing a device keeps its history.** Deleting history is a separate,
    confirmed action. Decided after a device removal on 2026-09-27 deleted the
    station's history in production.
14. **Categories are a fixed list in the SDK.** A simulator is never a type
    you can add: every type has one, for tests and "try without hardware".
    Since 2026-09-29 it is reached as a way to add that type — the simulated
    method every type has — rather than by starting the server in a mode.
15. **Local mode stays: the app works with no server.** In the model its
    node is the home's only node, and so its master: it offers the methods
    whose transports it has and whose needs it meets, and keeps the same
    records — devices, connections, their secrets, links — in its own
    database. What it cannot
    do is what only an always-running machine can: history while the app is
    closed, and automations while it is closed. While it runs, it does both
    (decision 22). Adding a server hands the home over to it (decision 23).
16. **A device is made of parts** (2026-09-29), as a Matter node is of
    endpoints: capabilities, metrics, controls and settings belong to a part.
    Nothing is modelled as a name pattern again.
17. **A device's description may come from the device.** A type declares it
    when it can and reads it when it must; the core keeps each device's own.
    This is what lets a standard be one type rather than one per product.
18. **Standards the floor, packages the ceiling.** A standard's generic type
    gives a device working support with no code; a package that refines it
    adds everything its owner knows (§8 step 30).
19. **New capabilities borrow Matter's meaning and name** where a cluster
    exists, and every capability has a projection into Home Assistant and
    Matter (§8 step 23).
20. **Thread is a network, not a protocol:** kraftverk reaches Thread devices
    as Matter over IP through a border router, and runs no radio of its own.
21. **Strict version 1 until there is a production state to protect**
    (2026-09-29, the owner). Nothing is kept backward compatible: no adapter
    between an old shape and a new one, no API or type versions, no migration
    hooks, one database schema rather than a chain of migrations — an older
    database is set aside and a new one started — and no field nullable only
    because older rows lack it. A change to the model is made everywhere at
    once and the architecture stays green. When kraftverk has users whose data
    must survive an upgrade, this decision is replaced by compatibility rules.
    [AGENTS.md](../AGENTS.md) says the same, for agents.
22. **Whatever can run in the app is a package the app can load**
    (2026-10-02, the owner). kraftverk's logic — devices and their sessions,
    the gateway, automations and their language, the configuration
    document, history, attention — is the framework, not the server: it
    lives in shared packages that run in the server, a browser and a phone
    alike, with no platform built-in, behind small ports for what differs (a
    SQLite database, what is installed, secrets at rest). The server is only
    what an always-running machine must be: the HTTP API, accounts, the
    broker, the disk; the app only its screens and its platform. Everything
    the app does with a home is one interface, implemented by the hub in the
    process and over HTTP alike, so the app never branches on where its home
    is. The aim: the app on its own keeps its devices, history and
    automations in its own SQLite and runs them. Logic that is neither the
    server's nor a screen is written in a package; what is in `server/` or
    `client/` now moves out ([PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md)).
23. **The app always keeps the home; one master at a time** (2026-10-02,
    the owner). A person starts with the app alone, and its database is
    their home. A server added beside it extends the home — running while
    the app is closed, reaching what only a server reaches — and becomes
    its master, which every app they use follows; the app keeps a copy,
    shown when the server is away, and holds for the server what it
    reaches itself (decision 2), so one device may be reached through the
    server and from a phone with one history. A server lost, the app's
    copy is the master again. Never two writers: nothing is merged. Where
    things run follows from the ways a device is reached and what an
    automation needs, never from a choice put to a person. In nodes
    (decision 24): the app's node is the master while it is alone; a node
    fitter for it — always on, reached by others — takes the role by a
    hand-over the person sees, and the app's node follows it. The steps:
    [PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md), "Phase 6, from 6f".
24. **Every place is a kraftverk node** (2026-10-02, the owner: where the
    overhaul ends). There is no server and no client as a kind of thing:
    a node is the hub running somewhere, with the ways it can communicate
    there and one home's database. What sets nodes apart is what each
    declares — always on or only while open, reachable by others or only
    reaching out, trusted with what must stay put — and the home's master
    is chosen by those: the node that is always on and the others reach.
    The others follow it, lend it what they reach, and can take its role
    over (decision 23). Built in step 6j: every node is a `node` record,
    by its own id; every connection is held by one; the home names its
    master (`home.master_id`); a connection method says what it `needs`
    of the node holding it (`trusted`, for a vendor account's password);
    the master is the node fittest for it (`shouldLead`), and the others
    are followers (`createFollower`). "Server" is left only for a node's
    HTTP entrance; on screen, people's own words stay, and Connectivity
    lists the home's nodes. Where nodes and devices stand (`place`) is in
    the model; what groups them — a home, or places alone — is decided
    with sharing and the first location feature. The steps:
    [PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md), "Phase 6, the goal".

---

## 10. The architecture is done when…

Ticked where the code does it and a test shows it; what only hardware can show
is said beside it.

- [x] Adding a product means adding one device package, and a platform one
      integration: no edits to `server/src`, `client/src`,
      `packages/api-client` or `packages/ui` — only `npm run gen:devices`,
      which rewrites the app's generated registry. The same for a protocol or
      a transport (`npm run new:integration`, `new:device` and their
      siblings prove it on every run).
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
- [x] Every command goes to a part, through
      `/devices/:id/parts/:part/commands/…`, and every settings write through
      `/devices/:id/attributes`, under the gateway's rules, wherever the
      connection is held; every holder applies the protocol's guard where it
      opens the channel.
- [x] Every device type has its methods, a simulator and a passing contract
      test, and one test checks every installed package
      (`server/src/platform/packages.test.ts`).
- [x] Weather is a service offering `weather.forecast`.
- [x] An automation connecting a forecast to a switch runs end to end, audited
      (step 14). *Against simulated devices; the ATORCH waits on its local key.*
- [x] The app never says extension, plugin, driver, adapter, bind, transport or
      protocol.
