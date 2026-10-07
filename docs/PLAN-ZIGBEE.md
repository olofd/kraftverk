# Zigbee, and MQTT made first-class

A plan, 2026-10-07, from the bottom up: the decision first, then the data
model, the contract, the broker and its transport, the integration, the hub,
the app, Docker and the deploy, safety, and the order of work. It builds on
[ARCHITECTURE.md](ARCHITECTURE.md) (the authority), [DATA-MODEL.md](DATA-MODEL.md),
[PLAN-INTEGRATIONS.md](PLAN-INTEGRATIONS.md) (§0 it runs where the home runs,
§1.1 calls not messages, §4.3 bridges, step 13's radios at the edge) and
[BROKER.md](BROKER.md), and changes them where it says so.

**The hardware it is for:** a Sonoff ZBDongle-P (TI CC2652P, Z-Stack
firmware) on the server's host, and, to prove it, four Zigbee plugs, a wall
switch and a temperature and humidity sensor — a plug that meters, a relay,
and a sleepy battery device: the three shapes that matter.

---

## 1. The decision: Zigbee2MQTT at the edge, now; native held open

Two ways to drive the dongle:

| | **Zigbee2MQTT beside kraftverk** | **Native: zigbee-herdsman inside kraftverk** |
|---|---|---|
| What runs | Zigbee2MQTT 2.x in its own container, given the dongle, publishing to kraftverk's broker | A process of kraftverk's on `zigbee-herdsman` and `zigbee-herdsman-converters`, given the dongle |
| Licence | GPL-3.0, but a separate program over a network protocol: nothing of it in kraftverk | MIT, both |
| Runtime | Node, in its own image | Native `@serialport/bindings-cpp`: unverified under Bun (an open crash report; libuv gaps) — in practice a Node process of our own anyway |
| Device support | Everything converters knows (1,592 device files, weekly releases), kept current by upgrading an image | The same converters — but called by our code: `findByDevice`, `fromZigbee`/`toZigbee` per message |
| What we would write | An integration that speaks its MQTT API: ~1–2k lines, pure | Most of Zigbee2MQTT's `lib/`: the device database, interviews, configure and reporting, availability, groups and binds, OTA, coordinator backup, the network map, permit join — then keep it in step with herdsman (majors 8→11 in ten months) |
| Fits the architecture | Exactly the shape step 13 held open: "a radio is a transport; what must sit at the edge is a service of that transport's own … with one narrow connection to the server". Zigbee2MQTT *is* that service, MQTT *is* that connection, and §4.8 already says Zigbee "comes in through Zigbee2MQTT as another generic, self-describing type" | The same shape, with an edge service we write |

**Zigbee2MQTT now.** The hard part of Zigbee is not the radio but the
thousands of devices with quirks, and that part is the same library either
way; Zigbee2MQTT keeps it current for us, and the contract between it and
kraftverk is a documented, typed, stable MQTT API. Native would cost months
to reach where Zigbee2MQTT is today, under a dependency that changes its
major version every quarter, for one gain — one process fewer.

**Native held open, and both possible over time.** Everything kraftverk
keeps is chosen so that a native edge service could replace Zigbee2MQTT
without a device losing its history:

- a Zigbee device's identity is `zigbee:<IEEE address>` — the same whoever
  drives the radio, and the same the Tuya gateway already gives its members;
- what a device is comes from its **exposes** (converters' description of
  it), mapped to kraftverk's model in pure code that a native service would
  reuse as it is;
- the coordinator is a **bridge** and the devices are its members — a
  contract with no MQTT in it.

What would make us revisit it: Zigbee2MQTT's MQTT API breaking us more than
herdsman's churn would; Bun running serialport natively; or a need
Zigbee2MQTT cannot meet (a phone holding a Zigbee radio is not one —
Zigbee radios live on hubs).

**What to depend on, and what to write** (the npm research, 2026-10-07):

- Zigbee2MQTT 2.x as a pinned Docker image. aedes ^1.2 and mqtt-packet, as
  now. Nothing new in any package.
- Written here: the wire types of the slice of its API we use — exposes,
  `bridge/devices`, `bridge/info`, the requests and responses with their
  `transaction` id — about 150 lines, from its documentation, credited in a
  NOTICE; not imported from the `zigbee2mqtt` package (GPL-3.0, and it
  would bring herdsman and serialport with it) nor from converters (23 MB,
  classes that change almost daily). Checked against fixtures recorded from
  the owner's Zigbee2MQTT, every id made up.
- MQTT.js is not needed while the server is the one speaking MQTT; it is the
  candidate when the app speaks MQTT itself (§9).

---

## 2. The data model: nothing new, three things written down

Zigbee fits the tables as they are (DATA-MODEL.md §3):

| Record | For Zigbee |
|---|---|
| `device` | **The coordinator** — a gateway (`kind: 'gateway'`), type `zigbee2mqtt.bridge`, its identity `zigbee:<the coordinator's IEEE address>`. **Each Zigbee device** — a device of a generic type on the right shelf (§5.3), its identity `zigbee:<its IEEE address>`, its description its own (from its exposes), kept with it |
| `device_connection` | The coordinator's: method `mqtt`, transport `mqtt`, held by the node that has the broker, address `zigbee2mqtt` — Zigbee2MQTT's base topic. A Zigbee device's: method `zigbee`, `through` the coordinator, its address its IEEE address (16 hex digits, lower case, no `0x`) |
| `device_kv` | The coordinator's own memory of who is behind it, as the Tuya gateway keeps one |
| `sighting_ignored` | "Not mine" on a member, as for any bridge |

Written down, because they are decisions:

1. **The Zigbee network is Zigbee2MQTT's, not kraftverk's.** Its key, its
   pairings and its device database live in Zigbee2MQTT's volume. kraftverk's
   database can be set aside (strict version 1) without one device pairing
   again; Zigbee2MQTT's volume cannot. It is backed up as the host's data is
   (the homelab's job), and a coordinator backup can be asked of it
   (`bridge/request/backup`) as a tool.
2. **An address is the IEEE address, never the friendly name.** Zigbee2MQTT
   addresses a device by either; a friendly name can change, the IEEE address
   cannot. kraftverk leaves friendly names as Zigbee2MQTT gives them (the
   IEEE address) and keeps the person's name itself.
3. **The configuration document needs nothing new.** A gateway and the ways
   through it are entries it already carries (CONFIG.md, version 7); its
   `kraftverk:` number does not move.
4. **A device can change what it is, and keep its history** (added
   2026-10-07, the owner: "changing device types, and the mapping"). §2.1.

### 2.1 Changing a device's type: its history mapped

ARCHITECTURE.md §4.5 said `type_id` is immutable, "changing what a device
*is* means adding a new one; its history would not mean the same thing".
That protected history from being misread — and lost it whenever the same
thing came to be reached another way. The case that forces it: the NIU
charger is `tuya.plug` behind a Tuya gateway; paired with the dongle it is
the same Zigbee device (`zigbee:<IEEE>`), and its type is
`zigbee2mqtt.plug`. Its history, its name, the station it feeds and the
automations that switch it must come with it.

So a type **changes**, never silently, by a **mapping** a person sees:

- **When.** The check finds the device is yours under another type
  (`outcome: 'yours'` with another `typeId`): the add flow offers *Move it
  here* — "NIU Charger becomes a Zigbee plug: its history, links and
  automations come with it" — beside *Cancel*. And from a device's page,
  *Change what it is*, among the types it could be: those reached through
  the same bridge, and those its identity's protocol reaches.
- **The mapping**, worked out by the hub, shown before anything moves:
  - each **attribute** the device has ever had (`device_attribute`) to one of
    the new description's — by **meaning** on the part that offers the same
    capability first (power to power on the switching part), then by the
    same key, then by the same label and value type; one with no counterpart
    keeps its history under its old key, recorded as no longer reported;
  - each **part** to one of the new parts — by the capabilities it offers,
    then its kind;
  - **history** re-keyed in one transaction (`sample`, `sample_hour`,
    `device_attribute`); a value of another unit is converted (a number's
    unit of the same dimension), one of another type is not carried;
  - **links** re-pointed by the part mapping; one whose end no longer offers
    what its kind needs is removed, and said;
  - **automations' roles** re-pointed by the part mapping; a role whose
    part has no counterpart leaves its automation needing attention, on the
    "needs you" list;
  - its **connections** that the new type has no way for are removed; the
    new one is added; its **device store** is cleared (it is the old type's);
    its config is the new type's defaults; an audit entry says what it was.
- **The same within a family.** When a Zigbee device's exposes change after
  a Zigbee2MQTT upgrade so that it lands on another shelf — a switch found to
  meter — its coordinator says so and the device is offered the move: keys
  are the same, the mapping is the identity.

DATA-MODEL.md and ARCHITECTURE.md §4.5 change to say a type changes only by
this mapping.

---

## 3. The contract: what the SDK gains

### 3.1 A broker policy that serves a bridge (`MessageBrokerPolicy`)

The policy was shaped by one Sydpower station per MQTT client. Changed
everywhere at once (strict version 1):

```ts
export type MessageBrokerPolicy = {
  protocol: string;
  /** The topics it speaks for: every topic under it is this protocol's and no other's. `zigbee2mqtt/`; Sydpower has none (its topics begin with the station's MAC) and matches as now. */
  root?: string;
  /** The client that speaks for this protocol's devices, by the name it signs in as: only it may publish their topics, and only it and the server are sent them. A station cannot sign in; Zigbee2MQTT can (`'zigbee2mqtt'`). */
  signedIn?: string;
  fromDevice(topic: string): { address: string; channel: string } | null;
  subscribedBy(filter: string): string | null;
  commandFor(topic: string): string | null;
  /** Why a command must not be delivered — with its topic, now: for Zigbee2MQTT the topic is what tells a lamp's `/set` from removing a device. */
  refuse(topic: string, payload: Uint8Array): string | null;
  describeCommand(topic: string, payload: Uint8Array): BrokerMessageNote;
  describeMessage(channel: string, payload: Uint8Array): BrokerMessageNote;
  absenceAdvice?: string;
};
```

- The broker's **device** stays what it is — an MQTT client speaking a
  protocol: a station, a coordinator. A Zigbee device is not one; its
  presence is its coordinator's business, told through its link (§5).
- Addresses are kept **as the policy gives them**. The broker stops
  upper-casing (a MAC habit: Sydpower's policy upper-cases its own).
- A topic under a policy's `root` is matched by that policy alone, so a
  friendly name that happened to contain `client/request` can no longer be
  taken for a station's command.

### 3.2 A bridge that devices join (`Bridge.join`)

Pairing is the first thing anyone does with a coordinator, and the most
Zigbee-shaped: it belongs in the contract, not in a tool.

```ts
export interface Bridge<Link> {
  members(): readonly Member[];
  link(member: string, changed: () => void): Promise<Link>;
  /** A bridge new devices join: open for `seconds` (0 closes), and until when it is open now. */
  readonly join?: { open(seconds: number): Promise<void>; until(): string | null };
}

export type Member = {
  key: string; name: string | null; model: string | null; identity: string | null; typeId: string | null;
  /** What it is, in a few words, where the bridge knows: "IKEA E1603 smart plug". */
  about: string | null;
  /** Joining and not yet ready: its bridge is still asking it what it is. */
  joining: boolean;
};
```

Opening the network changes what can join the home, so it is a physical
act: the hub runs it as it runs a tool that writes — refused while
read-only, audited with who asked — under `POST /api/devices/:id/join`.
Every member a bridge reports gains `about` and `joining`; the Tuya gateway
and the NIU account say `null` and `false`.

### 3.3 Retained messages reach a late subscriber (`MessageChannel`)

A channel's `subscribe` is promised MQTT's meaning: what the broker keeps for
a topic (a *retained* message) is delivered to a new subscription. Today it
is not — the server subscribes to everything once, at its start, and a
session opened later never sees Zigbee2MQTT's `bridge/info` or
`bridge/devices`. The fake channel in `device-sdk/testing` keeps retained
messages too, and can deliver what a device says unasked.

---

## 4. The broker and its transport (`packages/transports/mqtt`)

The review of 2026-10-07 found fifteen things; these are fixed, in the
order the work needs them:

| | What is wrong | The fix |
|---|---|---|
| T1 | The server's client drops a message's retain flag; a channel opened late never hears what is retained | The client says `retained`; the bus keeps the last message of every topic it has heard retained (an empty one forgets it) and replays the matching ones to a new subscription |
| T2 | Addresses upper-cased in the broker, its journal, its CLI, the bus and the channel | Kept as the policy gives them, compared as they are |
| T3 | A channel is "connected" if its address was the first segment of a topic heard in two minutes — never true for `zigbee2mqtt/…` | Presence alone: the broker knows for certain, and says so |
| T4 | Every message's journal entry is a synchronous file append, with the whole payload in hex — `bridge/devices` is hundreds of kB | An append stream; hex capped at the source; the level asked before the summary is built |
| T5 | Every info entry is republished to the server and printed | Lifecycle kinds and warnings only; a device's messages stay in the file |
| T6 | The server's own publishes that are not commands (`/get`) journalled as unknown traffic, at info | At debug |
| T7 | One ring of 4,000 entries, sized for one station | Lifecycle entries in a ring of their own |
| T8 | `command.undelivered` says "the device is not connected" when what is missing is the client serving the topic | Said so |
| T9 | Any client may publish a device's topics, and a second connection takes its presence | A policy that wants it (`signedIn`) accepts its device topics only from a client that signed in; the first such client holds them while connected |
| T10 | Only the server can sign in | Named client credentials, kept as the broker keeps the server's token: `zigbee2mqtt` gets one, generated on first use, handed to Zigbee2MQTT by the deploy |
| T11 | A protocol that fails to load stops the broker for every protocol | Unchanged on purpose: a broker that forwards commands it cannot judge is the one way round every guard (policy.ts). The deploy recreates the broker when a policy changed (§7), so a new protocol is never half-loaded |
| T12 | The CLI and BROKER.md still say "station" where they mean any device | Words fixed |
| T13 | Every message is matched against every channel's every filter | Not needed: a coordinator is one channel, and its devices read it through links |

Not changed: one connection is one broker device (a coordinator is one; its
members are not broker devices — §3.1), QoS 0, MQTT 3.1.1. aedes 2's MQTT 5
is still a beta.

---

## 5. The integration: `@kraftverk/integration-zigbee2mqtt`

### 5.1 Its protocol (`src/protocol/`, pure)

- **Topics:** `zigbee2mqtt/bridge/{state,info,devices,event,response/…}`,
  `zigbee2mqtt/<device>` (its state, JSON),
  `zigbee2mqtt/<device>/availability`, and the commands
  `zigbee2mqtt/<device>/{set,get}` and `zigbee2mqtt/bridge/request/<what>`,
  each request with a `transaction` id its response carries back.
- **Its broker policy:** root `zigbee2mqtt/`, `signedIn`. Every topic is the
  coordinator's (address `zigbee2mqtt`). Commands — `…/set`, `…/get`,
  `bridge/request/…` — only from the server, and of the bridge's requests
  only those §5.5 uses — `permit_join`, `health_check`, `backup`,
  `device/remove`, `device/interview`, `device/configure`,
  `device/options`, `device/ota_update/check` and `…/update`, and the
  `group/…` requests: the rest (`options` — its network key among them —
  `restart`, `install_code`, `touchlink/*`, `extension/*`, …) refused to
  everyone, the server included, as register 68 is refused for a station.
- **Exposes → a description** (`exposes.ts`), the heart of it:

  | Expose | Becomes |
  |---|---|
  | `switch`, `light`, `fan` (with an endpoint, one each) | A part — `switch`, `switch.l1`, `light` — of kind `outlet`, `light`, `fan`; its `state` the attribute `<part>.on` (meaning `on`), offering `switch` when it can be set |
  | a light's `brightness`, `color_temp`, `color` (composite `x`/`y` or `hue`/`saturation`) | Attributes of its part that can be written: brightness as a percentage, colour temperature in mired with its range, colour as an object value of its own shape |
  | `lock`, `cover`, `climate` | A part of that kind, its features its attributes: a cover's `position` and `state` (open, close, stop), a thermostat's `local_temperature` and setpoints, a lock's `state` — the setpoint and the lock `dangerous` |
  | `action` (an enum, published only) | Not a value but **events**: a button's `single`, `double`, `hold` — each an event of the device, raised as it comes, so an automation starts on a press |
  | `composite` | An object value of its fields' types; settable as a whole |
  | `list` | A list value of its item's type |
  | `numeric` with a unit kraftverk knows | A number in that unit; `power`/W, `voltage`/V, `current`/A, `energy`/kWh, `temperature`/°C, `frequency`/Hz take their standard meaning; `humidity`, `illuminance` their quantity; on the one switching part when the device has one (a plug's meter), else on `main` |
  | `numeric` with a unit it does not know (ppm, hPa) | A number without one, its unit in its label |
  | `binary` | A boolean (`occupancy`, `contact`, `water_leak`), mapped from its `value_on`/`value_off` |
  | `enum`, `text` | An enum of its values; a string |
  | `category: config` / `diagnostic` | The same category; `battery`, `linkquality`, `device_temperature` are diagnostic whatever it says |
  | settable (access bit 2) outside a switching part | An attribute that can be written (`access: 'write'`): written through the gateway, as `{property: value}` to `/set` |

  Attribute keys are the expose's property, under its part — stable for as
  long as converters keeps a property's name, which is its own contract.
- **Readings** from a state message, by the same table, `null` for what it
  did not say; **commands** (`switch.set`) and **writes** as `/set` payloads.

### 5.2 The coordinator (`zigbee2mqtt.bridge`, kind gateway)

One session over its MQTT channel, subscribed to `zigbee2mqtt/#`:

- **Health:** connected while the broker has Zigbee2MQTT's client and
  `bridge/state` says `online`; "Zigbee2MQTT is not running" when it says
  `offline` (its last will); the coordinator's type and firmware, the
  network's channel and how many devices, in its sentence.
- **Readings:** devices, routers, whether it lets devices join and until when,
  Zigbee2MQTT's version.
- **Members:** `bridge/devices`, the coordinator left out; each with its
  name (a friendly name that is not its address), model, `about` (vendor,
  description), `joining` (interviewing, not yet supported), and its type
  — the generic type of its shelf (§5.3) — so it is offered as what it is.
- **Links:** each member reads its own state and availability through its
  link and is told when they move; asks `/get` for what it can be asked
  when it is linked and has said nothing yet (a state is not retained by
  default, and is lost when the server restarts); and sets through it.
- **Join:** `bridge/request/permit_join {"time": n}`, answered on its
  response topic, `until` from `bridge/info`.
- **Tools:** a coordinator backup; removing a device from the network (it
  cannot be undone: confirmed by a person).
- **Identify:** waits for the retained `bridge/info` (five seconds): proven
  when Zigbee2MQTT is on this broker, its identity the coordinator's.
- **Found** when Zigbee2MQTT connects to the broker: a client heard speaking
  `zigbee2mqtt` is offered under "Found near you".
- **Simulator:** a coordinator with a plug that meters, a switch and a
  sensor behind it, devices joining when the network is opened.

### 5.3 The devices behind it: one implementation, a type per shelf

A device lands on the shelf a person looks on, so the generic type is one
per category, all one implementation (`defineZigbeeType`), each reached
`through: ['zigbee2mqtt.bridge']`, the coordinator choosing which from the
exposes:

| Type | Shelf | When |
|---|---|---|
| `zigbee2mqtt.plug` | Smart plugs | Switches, and measures power |
| `zigbee2mqtt.switch` | Switches and relays | Switches |
| `zigbee2mqtt.light` | Lights | Has a light |
| `zigbee2mqtt.sensor` | Sensors | Anything else — and the fallback (`bridge.fallback`) |
| `zigbee2mqtt.climate`, `.lock`, `.cover` | Heating and cooling, locks, blinds and doors | Has one |

Each describes itself (decision 17): its session's `description()` is its
exposes', kept with the device. Its health is its availability, and its
coordinator's: "The coordinator is not running" is said of every device
behind it. A product's own package — a plug someone knows by heart — is a
device package built on this integration, with a way through the
coordinator and the models it covers (§12 step 30's refinement, when built).

### 5.4 Groups

A Zigbee group is a set of devices that take one command together — one
radio message, every lamp in the room at once, with no popcorn. Zigbee2MQTT
keeps them (`bridge/groups`, retained: each group's id, friendly name, its
members by IEEE address and endpoint, its scenes), publishes a group's state
(`zigbee2mqtt/<group>`), and takes its commands (`zigbee2mqtt/<group>/set`).

- **A group is a member of the coordinator**, key `group:<id>`, of type
  `zigbee2mqtt.group` (its shelf the members': lights, switches). Its
  description is what its members can do, as Zigbee2MQTT works it out (§5.6):
  a light group's `on`, and brightness or colour where any member has them,
  its colour temperature the range all share, offering `switch` — so an
  automation switches "the living room" as one part, through the gateway, and
  the gateway verifies it from the group's state.
- **Made and changed in kraftverk**, on the coordinator's page: *New group*,
  name it, pick its members from the devices behind it (each by its endpoint
  when it has several); add, remove, rename, delete — each a bridge request
  (`group/add`, `group/members/add`, …) the broker policy allows, audited.
- **Its members stay devices of their own**: a lamp is in a group and still
  switched alone. A group is listed with what it is made of; a device's page
  says which groups it is in.
- **Scenes** (`scene_store`, `scene_recall`) come after groups: a scene is a
  group's saved state, recalled as one command — offered as a capability of
  the group when built.

### 5.5 Everything Zigbee2MQTT does, planned

What it can do, and where each lands in kraftverk — so nothing is designed
into a corner. **Now** is this work; **next** follows it; **later** waits on
a need.

| Zigbee2MQTT | In kraftverk | When |
|---|---|---|
| Devices, exposes, state, `/set`, `/get` | Generic types per shelf, descriptions from exposes, the gateway (§5.1–5.3) | Now |
| Availability | Each device's health; "the coordinator is not running" for all | Now |
| Permit join, interview | `Bridge.join`; *Joining…* until it is interviewed (§3.2) | Now |
| `action` | Events of the device (§5.1) | Now |
| Groups | `zigbee2mqtt.group` members, made on the coordinator's page (§5.4) | Now |
| Remove a device (`device/remove`, `force`) | A coordinator tool, confirmed; offered when a Zigbee device is removed in kraftverk | Now |
| Coordinator backup (`backup`) | A coordinator tool: the network's backup, downloaded | Now |
| Health check, bridge info | The coordinator's readings and health | Now |
| **Software updates (OTA)** — `device/ota_update/check`, `…/update`, the `update` property (`state: available / updating / idle`, `progress`, `remaining`, `installed_version`, `latest_version`), and its scheduled check | Each device's `update` attribute group: *Firmware* — installed, latest, *Update available*. *Update* is a tool of the device's that writes, confirmed by a person (a battery device may take an hour; a failed update can leave a device to be re-paired), with progress shown live from its state; never run by an automation. The coordinator's page lists every device with an update. Zigbee2MQTT's own periodic check stays its own (`ota.update_check_interval`); *Check now* is a tool | Next |
| Device options (`device/options`: `retain`, `debounce`, `transition`, `qos`, a device's own — a plug's `power_calibration`, a sensor's `temperature_precision`) | A device's settings, from its definition's `options`, written through the gateway as `device/options` — not `/set` | Next |
| Structured settings (a composite or list a device can set: an S60ZBTPF's `overload_protection`, `inching_control_set`) | Left out of a description until written (a setting kraftverk cannot write is no setting); then a settings form from the composite's features, written by `/set` through the gateway | Next |
| Rename (`device/rename`) | Not used: kraftverk keeps the name, Zigbee2MQTT the IEEE address (§2) | — |
| Reconfigure (`device/configure`), re-interview | Coordinator tools, per device: for a device that stopped reporting | Next |
| Binding (`device/bind`, `unbind`) — a switch that drives a lamp with no hub in between | A link kind of its own (`controls`), made on the switch's page; Zigbee2MQTT binds | Later |
| Reporting (`device/configure_reporting`) | A device's advanced settings: how often and on how much change it reports | Later |
| Scenes | A capability of a group (§5.4) | Later |
| Network map (`networkmap`) | A view on the coordinator's page: routers, links and their quality | Later |
| Touchlink (scan, identify, factory reset) | Refused at the broker now (§5.1); coordinator tools when a need comes | Later |
| Install codes | Refused now; a pairing option when a device needs one | Later |
| Zigbee2MQTT's settings (`options`), restart, extensions, external converters | Refused to everyone at the broker: the deploy configures Zigbee2MQTT, never kraftverk at run time | Never |
| Zigbee2MQTT's own upgrades | The pinned image, raised in a commit: its release notes read, the recorded fixtures re-checked | Each release |

### 5.6 What Zigbee2MQTT's own Home Assistant mapping teaches

Home Assistant has no Zigbee2MQTT integration: Zigbee2MQTT publishes Home
Assistant's MQTT discovery itself (`lib/extension/homeassistant.ts`, read in
2.14.2 for knowledge — GPL-3.0, nothing copied). What it knows that this
plan must too:

- **Read a binary by its `value_on`/`value_off`, never by its name.** A
  `contact` has `value_on: false`: open is "on". kraftverk's attribute is
  *Open*, true when the value is `value_on`.
- **A battery's voltage is `voltage` too** — in mV, diagnostic. A standard
  meaning is taken only where the unit is the meaning's own and the
  attribute is not diagnostic.
- **A group can do what any member can** (a union), its colour temperature
  the range all share (an intersection); only lights, switches, locks and
  covers. §5.4 follows it; the gateway's verification of a group reads the
  group's state, which Zigbee2MQTT works out optimistically from its members.
- **Availability is off unless asked for** (`availability.enabled`): with no
  availability topic a device's reachability is unknown, never offline.
- **Nothing of a device's state is retained by default**: `/get` on link,
  and Zigbee2MQTT's own cached state, are what a session starts from.
- **An interview may fail and still count as done**; `interview_state`
  (`PENDING`, `IN_PROGRESS`, `SUCCESSFUL`, `FAILED`) replaces the old flags.
  A device with no `definition` is joining; one whose definition's `source`
  is `generated` is offered, said to be guessed.
- **Exposes change** — after an option, an update, a re-interview or an
  upgrade — so a device's description is taken again on every
  `bridge/devices`, and its shelf with it (§2.1).
- **Endpoints**: `state_l1` is the property; `/set` with `{"state_l1":"ON"}`
  reaches the endpoint. Commands go to `zigbee2mqtt/0x<IEEE>/set`, which
  Zigbee2MQTT resolves as it resolves a friendly name.
- **Requests carry a `transaction`** echoed in their response
  (`{data, status, error?, transaction}`); an OTA update answers only when it
  is done — minutes to an hour — so its progress is read from the device's
  `update` state, not awaited.
- **`action`** is an event, published in the device's state; its values may
  name a button (`button_1_single`), and `action_*` properties beside it are
  the event's data.
- **`output: json`** is assumed (`attribute` is refused by Zigbee2MQTT with
  Home Assistant, and by kraftverk).

### 5.7 Tests

A Zigbee2MQTT played from fixtures recorded on the owner's (ids made up):
the coordinator found, its members offered by shelf, a plug switched and
metered, a sensor's readings, availability lost and back, joining, the
refused requests at the policy, and the retained replay at the transport.
The contract suite for every type.

---

## 6. The hub and the app

**Hub:** `POST /api/devices/:id/join` (run as a writing tool is: read-only
refuses it, the audit names who); members on offer carry `about` and
`joining`. Nothing else: the rest is bridges as they are.

**The coordinator's page** (an integration's own, under Integrations):

- its health and readings — the page shows a gateway's readings and tools,
  which it does not today, for every gateway;
- **Pair a device**: opens the network for four minutes with a countdown,
  says what to do ("hold the plug's button until it blinks"), and shows each
  device as it joins — "Joining…", then what it is, then **Add** — in the
  *Through it* list that is already there; *Stop* closes it early;
- its tools: a backup, and removing a device from the network.

**Adding a Zigbee device** from "Add a device": a plug's shelf offers
*Zigbee plug (Zigbee2MQTT)*; its way *Through Zigbee2MQTT* asks for the
coordinator — set up first if there is none (the hand-back built for Tuya,
2026-10-07) — and its *choose your device* step lists the members not yet
added, with *Pair a new one* opening the network right there.

**A Zigbee device's page** is the generic one, drawn from its description:
nothing new.

---

## 7. Docker, the deploy and the NUC

- `docker-compose.yml`: the `zigbee2mqtt` service behind the `zigbee`
  profile — the image pinned to a version, the dongle by its
  `/dev/serial/by-id/` path (`KRAFTVERK_ZIGBEE_ADAPTER`), `zstack`
  (`KRAFTVERK_ZIGBEE_ADAPTER_TYPE`), signed in to the broker with its
  credential (T10), availability on, device state retained, no frontend and no
  Home Assistant discovery, its data in its own volume.
- The deploy recreates the broker when the fingerprint of the installed
  policies changed — not on every deploy, as now (it drops the station) —
  and the manual **Broker** workflow stays.
- The NUC (the homelab repository): the profile and the dongle's path in the
  deploy's environment; the dongle's path never in this repository.
- DOCKER.md gains *Zigbee*; DEPLOY.md, BROKER.md and HANDOFF.md say what
  changed.

---

## 8. Safety

- Every physical act on a Zigbee device goes through the action gateway:
  `switch.set` and writes become `/set` only in the device's session, and
  the gateway verifies the `on` it sets from the state Zigbee2MQTT reports
  back.
- Opening the network and removing a device are audited and refused while
  read-only; removing is confirmed by a person.
- At the broker: no one but the server commands a Zigbee device; no one but
  Zigbee2MQTT, signed in, speaks for one; and the bridge requests that could
  change the network itself are refused to everyone (§5.1).
- A lock's state and a thermostat's setpoint are `dangerous`: a person
  confirms them, an automation never changes them.

---

## 9. Without a server (PLAN-INTEGRATIONS §0)

The protocol, the exposes mapping and every type are pure and run anywhere.
What ties Zigbee to the server today is the `mqtt` transport, whose only
implementation is the server's. A home that is only the app reaches
Zigbee2MQTT when the app can reach its messages; two ways, decided when
someone needs it:

| | MQTT over WebSocket | Zigbee2MQTT's own WebSocket |
|---|---|---|
| What | The broker (aedes) listens for MQTT over WebSocket; the app's `mqtt` transport, for `web` and `native`, signs in as a client of its own | The app connects to Zigbee2MQTT's frontend socket (`/api?token=…`): the same topics and payloads, everything retained replayed on connect |
| For | Every MQTT device, not only Zigbee: first-class MQTT everywhere | Zigbee2MQTT alone |
| Cost | A WebSocket listener and a client role in the broker; an MQTT client in the app (MQTT.js, 105 kB, or ours over mqtt-packet) | No broker change; but an interface Zigbee2MQTT documents for its own page, not as an API |

Recommended, when it comes: MQTT over WebSocket, because it makes MQTT a
transport like the others — on every platform — rather than a server's.

---

## 10. Better than Home Assistant, here

- A Zigbee device is **one device with one history** whichever coordinator
  drove it — a plug moved from a Tuya gateway to the dongle keeps its history
  (the same identity).
- **Typed and checked:** exposes become a description that is validated, with
  units and meanings automations can rely on (`charger.power`), not entity
  strings.
- **Every act through one gateway**, verified by what the device reports
  back; at the broker, only the server commands, and network-changing
  requests are refused outright.
- **A simulator** of a whole Zigbee network, so the app, the tests and an
  automation can be tried with no dongle.
- **Pairing where you are:** from the coordinator's page and from inside
  "Add a device", the device offered as what it is the moment it has joined.

---

## 11. The order of work

Built in bulk, then hardened together (the owner, 2026-10-07: "build a lot,
and then we test it and make sure it's solid"): the pieces below are written
one after the other with typecheck and their own tests, and the full suite,
the end-to-end run and the deploy come once, at the end.

1. **MQTT made sound** (T1–T12; §3.1, §3.3). *Done 2026-10-07*: retained
   replay to a late subscriber, addresses as given, presence alone, the
   policy's root, topic and `signedIn`, the broker's signed-in clients, the
   journal's cost and noise, words. T13 was not needed: a coordinator is one
   channel, its devices are links.
2. **The contract and the hub**: `Bridge.join`, a member's `about` and
   `joining`, `POST /api/devices/:id/join`; changing a device's type with its
   mapping (§2.1) — the store's re-keying, the hub's mapping and move, the
   save's *move* mode, the API.
3. **The integration**: wire types, exposes (§5.1), readings, payloads and
   events, the broker policy; the coordinator, the generic types per shelf,
   groups (§5.4), removing and backing up; the simulator; tests from
   fixtures.
4. **The app**: the coordinator's page — readings, tools, pairing, groups;
   pairing in "Add a device"; *Move it here* and *Change what it is*.
5. **Docker and the deploy**: the `zigbee2mqtt` service, its credential, the
   broker recreated when its policies change; the NUC's environment.
6. **Hardened together**: the full suite, the end-to-end suite with a
   simulated coordinator at 320 px, the deploy; then on the NUC the four
   plugs, the switch and the sensor paired and added, the NIU charger moved
   from its Tuya gateway with its history, a group of plugs switched by an
   automation through the gateway.
7. **Documents**: BROKER.md, DOCKER.md, DEPLOY.md, HANDOFF.md,
   DATA-MODEL.md and ARCHITECTURE.md (§3's packages, §4.5's type change, step
   13's radios at the edge), the integration's README.

Next, after this work: software updates, device options, reconfigure (§5.5).
Later: binding, reporting, scenes, the network map, the app speaking MQTT
(§9), a device package refining a Zigbee product, a native edge service if
§1's reasons change.

---

## 12. Decisions for the owner

Decided 2026-10-07, each as recommended:

1. **Zigbee2MQTT now, native held open** (§1).
2. **A generic type per shelf** (§5.3).
3. **Pairing in the contract** (`Bridge.join`, §3.2), in "Add a device" too.
4. **The app speaks MQTT itself later**, over WebSocket (§9).
