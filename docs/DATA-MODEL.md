# The data model

**Status:** the authority for everything Kraftverk stores, and for every kind of
thing it knows about. Adopted 2026-09-27; [ARCHITECTURE.md](ARCHITECTURE.md)
points here for the model and §8 there says which step builds each part.
Nothing below is built yet unless ARCHITECTURE.md §8 says so.

The diagrams are Mermaid. GitHub, GitLab and VS Code (with a Mermaid preview)
draw them.

This document starts with a person adding a device, screen by screen, because
each thing that screen needs is a record or a definition. The model is what is
left once the flow is right. Part 1 is the flow. Part 2 is the definitions it
uses. Part 3 is the records it leaves behind. Part 4 covers what happens after
a device is added. Part 5 is today's schema and how it gets here.

Two halves, kept apart:

- **Definitions** live in code, in packages. They say what *can* exist: a
  kind of device, a way of reaching one. Supporting a new product means adding
  a package, never a table.
- **Records** live in the database. They say what *does* exist in this house:
  your station, how it is reached, what it measured. A record names a
  definition by its id, a string such as `aferiy.p280`, and never copies it.

---

## 1. Adding a device, screen by screen

```mermaid
flowchart TD
  start([Add]) --> what["1 · What are you adding?<br/>categories · search · found near you"]
  what -->|a category| which["2 · Which one?<br/>the device types in it"]
  what -->|found near you| check
  which --> how["3 · How do you want to connect?<br/>each method, and where it would be held"]
  how --> ready["4 · Get it ready<br/>instructions, if any"]
  ready --> choose["5 · Choose your device<br/>what that transport can see"]
  choose --> creds["6 · Credentials<br/>only if the protocol needs them"]
  creds --> check{"7 · Check it"}
  check -->|a new device| name["8 · Name it"]
  check -->|already yours| another["Add this as another way<br/>to reach Garage P280"]
  check -->|yours before, removed| restore["Bring back Garage P280,<br/>with its history?"]
  check -->|a different model| other["It is a P320: add it as that"]
  check -->|no answer| retry["Try again, or save anyway<br/>if the type allows it"]
  other --> check
  restore --> name
  retry --> name
  name --> links["9 · How is it connected?<br/>only when a link could apply"]
  links --> save[("10 · Save: one transaction")]
  another --> save
  save --> page(["The device's page,<br/>showing its first live reading"])
```

Nothing is stored until step 10. Everything before it is a **draft**. Steps that
run on the server keep their part of the draft there for fifteen minutes,
including any secret a step found. The app sees a placeholder for the secret,
never the secret (see [SECURITY.md](SECURITY.md)).

### 1 · What are you adding?

| | |
|---|---|
| **You see** | Two sections. **Devices** shows *Power stations* and *Smart plugs*. **Services** shows *Weather*: a category is under Services when what is installed in it is services. Each category has its icon and names the products it covers. There is a search box for brand and model ("P280", "ATORCH"). When the server can see something nobody has added, a **Found near you** row sits at the top: "A power station is connected to this server over Wi-Fi". |
| **You choose** | A category, a search result (which goes straight to step 2's item), or something found. |
| **Comes from** | **Category** is a fixed list in the SDK. Each device type names one. **Sightings** come from the server's transports: each one host, with everything it was heard announcing — typed: a broadcast, a Bluetooth advert, a broker client. Each way declares what it is found by; a sighting a way's matchers pick out is confirmed and read by its protocol. A transport that costs nothing to watch (the home network's broadcasts, the broker's clients) is watched all the time, so what turns up waits on Home without anyone opening this screen. |
| **Leaves behind** | Nothing. A category is display only, and a sighting is live state. |

A simulator is never listed as a type. A simulator belongs to every device
type, so a device you can add is always a real product or a real service —
and **Simulated** is one of the ways to add it (step 3), beside Wi-Fi or
Bluetooth: its simulator stands in for the hardware, for "try without
hardware", for a demo, for developing. It is a choice per device, not a mode
of the server, so a simulated lamp and a real station sit side by side.

"Found near you" skips steps 2–6: the sighting already says which transport,
which protocol and which address. If more than one installed type speaks that
protocol, step 7 reads the model and chooses the type. If the model can't be
read, step 2 appears, showing only those types.

### 2 · Which one?

| | |
|---|---|
| **You see** | The device types in the category, each with its picture, name, brand, the models it covers and its support level: *Verified on real hardware*, *Reported working by others*, or *Experimental*. At the bottom: *Don't see yours?*, which links to how support gets added. |
| **You choose** | A device type. |
| **Comes from** | **Device types**, from the installed packages. |
| **Leaves behind** | The draft's type. It becomes `device.type_id`. |

This screen is shown even when a category holds one type. It is where you
confirm the product and learn how well it is supported, and that is worth one
tap.

### 3 · How do you want to connect?

| | |
|---|---|
| **You see** | One row per way this type can be reached, *from where you are*. For a P280, in the phone app, with a server that has a Bluetooth radio:<br/>• **Wi-Fi, through your server** (*Recommended*). "Always on: history and automations keep running. The station needs to be set to use your server."<br/>• **Bluetooth, from your server**. "The station must be within about 10 m of the server."<br/>• **Bluetooth, from this phone**. "Only while this phone is near the station. History records while it is connected; automations can reach it only then."<br/>A row that can't be used here stays visible, greyed, with the reason: "Your server has no Bluetooth radio", or "Firefox can't use Bluetooth: use Chrome or Edge, or the phone app". |
| **You choose** | A **connection method** and **which node holds it**: your server, or this app's own node — this phone or browser. |
| **Comes from** | The type's **connection methods**. Each is one protocol over one transport, and says nothing about where it runs. **Which node can hold it** is worked out: each node reports the transports it has right now, and a method is offered wherever its transport is. |
| **Leaves behind** | The draft's method and the node that holds it. They become `device_connection.method` and `.held_by`. |

If only one row exists, the screen is skipped and the next one says how it will
connect.

Where a method *runs* is never declared by the device author. MQTT through our
broker is only ever offered on the server, because only the server has the
broker. Bluetooth is offered on the server and in the app because both can have
a radio. The P280's code is the same either way.

### 4 · Get it ready

| | |
|---|---|
| **You see** | What to do to the device first, if anything, with your own values filled in. For Sydpower over MQTT: "In BrightEMS, open the station → Settings → Local MQTT broker, and enter `192.0.2.10`, port `1883`." For Bluetooth: "Turn the station on and stay near it." A button: *Done: find it*. |
| **Comes from** | The **protocol**, for how it rides that transport. The **transport** supplies values such as the broker's address. The **device type** may add its own step. |
| **Leaves behind** | Nothing. |

### 5 · Choose your device

| | |
|---|---|
| **You see** | **Held by the server:** a live list of what the server's transport can see and the protocol recognises. Each row has its advertised name, a short id, how recently it was seen and how it was found. Something already added stays in the list, greyed: "Already added as Garage P280". An empty list says what to try while it keeps waiting ("A sleeping station appears when you press its power button"). *Enter it yourself* takes an IP or MAC address when discovery can't work.<br/>**Held by this browser:** a button, *Find my station*, which opens the browser's own Bluetooth chooser. Browsers let only that chooser list devices, and only after a tap. It is filtered to the protocol's Bluetooth service.<br/>**Held by the phone app:** the same live list as the server's, from the phone's own scan. |
| **You choose** | One physical device. |
| **Comes from** | The **transport** of the chosen holder does the finding. The **way** says what it is found by — its `discovery` matchers: a UDP port, a Bluetooth service or name, a broker client's protocol — which is also what the browser's chooser is asked for. Its **protocol** confirms each sighting picked out, and reads what it announced. |
| **Leaves behind** | The draft's address: what the transport knows the device by. That is a MAC, an IP address, or a browser's Bluetooth handle — or, for a device behind a gateway on the home network, the gateway's IP address, `#`, and the device's address there (`192.168.1.20#a4c1380000000001`: a Zigbee plug behind a Tuya gateway). The whole address is the one device, so two devices behind one gateway are two claims. It becomes `device_connection.address`. |

### 6 · Credentials

| | |
|---|---|
| **You see** | Only for protocols that need them. For Tuya local: "Your plug's local key", with *Fetch it with my Tuya account* (the account details are used once and never stored) or *Enter it*. |
| **Comes from** | The **protocol**. |
| **Leaves behind** | The secret, on the node that holds the connection: for one your server holds, in the server's `connection_secret`; for one this app's node holds for it, in the app's own database, sealed with a key the platform keeps — and the server never sees it. |

### 7 · Check it

The device type connects over the chosen method and reads the device once. It
learns two things: the device's **identity** (its own permanent id, read from
the device rather than from the transport) and its **model**. There are five
outcomes:

| Outcome | You see | What happens |
|---|---|---|
| New | "Found it: AFERIY P280. Battery 87 %, charging 120 W." | On to step 8. |
| Already yours | "This is your **Garage P280**. Add *Bluetooth, from this phone* as another way to reach it?" | No second device. The draft becomes a new connection on the existing one, and it is saved. |
| Yours before | "You had this station before: **Garage P280**, removed on 3 August. Bring it back with its history?" *Bring it back* or *Start fresh*. | Bringing it back clears `removed_at` and adds the new connection. Starting fresh makes a new device; the old one stays removed with its history. |
| Different model | "This is a P320, not a P280." *Add it as a P320* if that type is installed, otherwise "Not supported yet". | Back to this step, with the right type. |
| No answer | "It didn't answer." *Try again*. If the type allows it, *Save anyway* too, with the type's reason ("A sleeping station connects when it wakes"). | Saved without an identity. The first successful connection fills it in. If that identity belongs to another device, the connection is refused and the device's page says why. |

The identity is what makes "the same station, found by the server or by your
phone" one device. It can't be the address: a browser's Bluetooth handle is
private to that browser, and phones hide MAC addresses.

### 8 · Name it

Pre-filled from what the device calls itself, or from the model: "AFERIY P280".
If a device already has that name, a number is added: "AFERIY P280 2". Stored
as `device.name`.

### 9 · How is it connected?

Asked only when a **link kind** could join a part of this device to a part
of one you already have. For a smart plug when you own a station: "What is
plugged into this?", with *Garage P280 — Mains* or *None of these*, and what
it changes: "Kraftverk checks the target sees mains come and go whenever the
source is switched." For a station, the question is asked once for each of
its outlets ("AC outlets: what is plugged into this?"), and the other way
round for its mains input. It can be skipped, and changed later on either
device's page. Stored as a `device_link` between the two parts.

### 10 · Save

One transaction writes, or restores, the `device`, its `device_connection` and
its `connection_secret` rows, and its `device_link`. The holder then opens the
session, and the app opens the device's page, which shows the first live
reading.

### A service goes the same way

*Weather* → *Open-Meteo* → step 3: its web API, held by the server (or
Simulated) → no instructions → *Where?* (search a place, or use this phone's
location) → check: fetch one forecast → name → save. The place is
`device.config`; the API is its connection. A weather service that needs a key
keeps it in `connection_secret`, like any other credential.

---

## 2. Definitions: what code declares

```mermaid
classDiagram
  direction LR

  class Category {
    id
    label
    icon
  }
  class DeviceType {
    id
    kind
    category
    describe(config)
    config
    connections
    tools
    identify(connection)
    createSession(ctx)
    createSimulator(ctx)
  }
  class ConnectionMethod {
    id
    label
    protocol
    transport
    reach
    recommended
    extraSteps
  }
  class Protocol {
    id
    bindings per transport
    recognise(sighting)
    instructions
    credentials
    encode and decode
  }
  class Transport {
    id
    exclusive
    server implementation
    web implementation
    native implementation
    discover() or choose()
    open(address)
  }
  class Node {
    the hub, running somewhere
    transports available now
    always on · reachable · trusted
    where it stands
  }
  class Capability {
    id
    attributes by meaning
    commands and what makes one consequential
    queries and their answers
    events
  }
  class LinkKind {
    id
    fromCapability
    toCapability
    evidence
    consequential
  }

  DeviceType "*" --> "1" Category : is listed under
  DeviceType "1" *-- "1..*" ConnectionMethod : can be reached by
  ConnectionMethod "*" --> "1" Protocol : speaks
  ConnectionMethod "*" --> "1" Transport : over
  Protocol "*" --> "1..*" Transport : has a binding for
  Node "*" --> "*" Transport : has
  DeviceType "*" --> "*" Capability : its parts offer
  LinkKind "*" --> "2" Capability : joins parts offering
```

| Definition | What it is | Lives in | Examples |
|---|---|---|---|
| **Category** | What a person would call the thing: a shelf on the add screen, with a label and an icon and no prose about any product. For finding things, never for behaviour. Which section it is listed in comes from its types' `kind` (hardware or service). A fixed list, so two types can't spell the same category two ways. | `device-sdk` | `power-station` "Power stations", `smart-plug` "Smart plugs", `weather` "Weather" |
| **Transport** | How bytes or messages reach a device. It does all the I/O and the finding, and has no idea what the bytes mean. It ships one implementation for each place it can run. It is **exclusive** when an address means one physical thing, so only one device may claim it. There are few transports, and they are rarely added. | `packages/transports/*` | `mqtt`: our broker, server only, exclusive. `ble`: server (its radio), web (Web Bluetooth), native (phone); exclusive. `lan`: TCP and UDP on the home network, server and native; exclusive. `https`: the internet; server, web and native; not exclusive. |
| **Protocol** | The language spoken over a transport: framing, encryption, message shapes. It has one **binding** for each transport it rides: the MQTT topic names, the Bluetooth service and how frames are split. It **recognises** its own devices among sightings, and says what instructions and credentials setup needs. Pure code: no I/O, no Node or Bun built-ins, no product knowledge. Part of its integration. | `packages/integrations/*/src/protocol/` | `sydpower`: MODBUS-style frames, bindings for `mqtt` and `ble`, and the rule that register 68 is never written 0. `tuya-local`: encrypted frames, a binding for `lan`, the local-key credential. |
| **Integration** | A platform: a vendor's system, a cloud or a standard — its ways in and their setup, its accounts, gateways and services, the builder its products are made with, the generic type a product nobody described falls back to. Names no product. Pure code. | `packages/integrations/*` | `sydpower`: its two ways in. `tuya`: the socket builder, the generic plug. `open-meteo`: the weather service. |
| **Device type** | One product or product family: what its values *mean*. It **identifies** a device (its identity and model) over any of its connection methods. Models of one family are *profiles*, as data, not separate types. Pure code too, because it runs wherever its connection is held. A product's type is a **device package**'s, built on its integration; the platform's own — a service, the generic type — its integration's. | `packages/devices/*`, `packages/integrations/*` | `aferiy.p280`, `atorch.s1w`, `tuya.plug` (one profile per socket), `open-meteo.weather` |
| **Connection method** | One (protocol, transport) pair a type supports, what it **reaches** beyond the home network (`local`, `cloud-at-setup` — the vendor's cloud once, to fetch a key — or `cloud`), an optional *recommended* flag and any extra setup steps of its own. It says nothing about *where* it runs. A type declares pairs, not two separate lists, because not every protocol rides every transport. | inside the device type | P280: `wifi` = sydpower over mqtt, local; `bluetooth` = sydpower over ble, local. ATORCH: `lan` = tuya-local over lan, cloud at setup. Open-Meteo: `api` = open-meteo over https, cloud. |
| **Node** | A kraftverk node: the hub running somewhere — an always-on machine on the network, a phone, a browser — that holds connections. It reports the transports it has *now*, and why one is missing, and declares what it is: **always on** (runs while nobody looks), **reachable** (others connect to it), **trusted** (what must stay put — a vendor account's password — may be kept on it). One node is the home's **master** (`home.master_id`): the one always on and reachable, when there is one; the others follow it, an always-on one too — a Raspberry Pi beside a station, holding its Bluetooth for the master. One master per home; a master per place is a door left open. Setup offers a method wherever a node of the home has its transport. | runtime, and the `node` record | A NAS: `mqtt`, `ble`, `lan`, `https`; always on, reachable, trusted. Chrome on a laptop: `ble`, `https`. Firefox: `https` ("no Bluetooth in Firefox"). |
| **Place** | Where something is, physically, with its position and clock: what weather, sun times and an automation's clock would be read from. Not in the schema: what groups things — a home, or places alone — is still the owner's to decide (PLAN-SHARED-CORE.md, 6j), and a table nothing writes was taken out until it is. A weather service has its own position; an automation its own clock. | — | "Home", 59.33 N 18.07 E, Europe/Stockholm; "The cabin" |
| **Value** | One type system for everything a device reports, is told, answers or asks for: number (unit, range, step, precision), boolean, enum, string, **timestamp**, and a **list** or an **object** of values for structure. `null` is "not known". A config field is a value type with a title and a **presentation** (`secret`, `host`, `multiline`, `slider`). | `device-sdk` (`values.ts`, `schema.ts`) | A forecast: a list of objects `{at: timestamp, temperature: °C, cloudCover: %, …}`; a local key: a string presented as a secret |
| **Description** | What a device is: its **parts** (`main`, and whatever it has several of — each of a curated **kind** with an icon, or one of the type's own, namespaced, and an optional **energy role**), their **attributes** (what they report, and what they remember and can be told), its **events**, and any capabilities of its own. An attribute's key begins with its part (`pack.1.soc`); it says how long a value stays **current** (`currentFor`). A type declares it for a device's config; a session may report its own. | `device-sdk` (`description.ts`) | A P280: `main`, `input.ac` (`input.ac.present`), `input.solar`, `outlet.ac`/`dc`/`usb` (`outlet.ac.on`), and `pack.1` when a pack is plugged in |
| **Capability** | What a part can do or report, declared like a Matter cluster: attributes bound to standard meanings (Matter's names), commands with typed arguments, what each sets and **what makes it consequential**, queries with the **type of their answer**, and events. The library is shared; a package may declare its own, namespaced by its type, in the same shape. | `device-sdk` | `switch` (off while drawing more than the home's `loadWatts` is consequential), `powerMeter`, `battery`, `acInput` (raises `mains.lost`), `weather.forecast` (answers a list of hours) |
| **Tool** | Something a kind of device can do beyond its capabilities — a register dump, a raw frame — **declared as data**: what it asks for, what it answers, whether it writes. The holder checks both ways. | inside the device type | P280: `registers`, `scan`, `raw`; a Tuya plug: `datapoints` |
| **Link kind** | A physical fact between **parts** of two devices: which capability each end needs, what on the target proves a command on the source did something, and whether being its source makes a command consequential. | `device-sdk` | `feeds`: from a part with `switch` to a part with `acInput`, proven by `mainsPresent` following `on`; consequential |

### A method's setup is assembled, not written

A device author declares "sydpower over mqtt" and gets its steps from the layers
underneath. Improving a layer improves every device that uses it.

| Step | Supplied by |
|---|---|
| 4 · Get it ready | the protocol's binding for that transport, filled in with the transport's values, plus any step the type adds |
| 5 · Choose your device | the holder's implementation of the transport, filtered by the protocol |
| 6 · Credentials | the protocol |
| 7 · Check it | the device type's `identify`, then one read |
| 8, 9, 10 | the core |

### One chain, end to end

```mermaid
flowchart LR
  subgraph P280["Garage P280: sydpower over mqtt, held by the server"]
    direction LR
    T1["transport mqtt<br/>the broker on :1883<br/>client AABBCC001122 connected"] --> P1["protocol sydpower<br/>topic AABBCC001122/device/response/04<br/>a read of holding registers 0–79"] --> D1["device type aferiy.p280<br/>register 56 → charge = 87 %"]
  end
  subgraph PLUG["Heater plug: tuya-local over lan, held by the server"]
    direction LR
    T2["transport lan<br/>UDP broadcast from 192.0.2.41<br/>TCP 192.0.2.41:6668"] --> P2["protocol tuya-local<br/>v3.4 session, AES with the local key<br/>dps: 1 = true, 19 = 1520"] --> D2["device type atorch.s1w<br/>dp 19 ÷ 100 → power = 15.2 W"]
  end
  subgraph PHONE["Garage P280: sydpower over ble, held by Olof's iPhone"]
    direction LR
    T3["transport ble, native<br/>peripheral 5F2C…, the iPhone's handle"] --> P3["protocol sydpower<br/>the same frames, split for Bluetooth"] --> D3["device type aferiy.p280<br/>the same code as on the server"]
  end
```

Each layer talks only to the one next to it. The server and the app import none
of them by name: the server finds them at start-up, and the app's build lists
them. Each holder starts only the transports that its installed device types
need.

---

## 3. Records: what the database holds

```mermaid
erDiagram
  device ||--o{ device_connection : "is reached by"
  device_connection ||--o{ connection_secret : "needs"
  node ||--o{ device_connection : "holds"
  device ||--o{ device_connection : "is the bridge of"
  node |o--|| family : "is the master of"
  family ||--o{ place : "names"
  place ||--o| home : "is"
  home ||--o{ home_setting : "keeps"
  home ||--|{ space : "is a tree of"
  space |o--o{ space : "holds"
  space ||--o{ opening : "meets another at"
  space ||--o| floor_plan : "is drawn by"
  space ||--o{ placement : "is where stood"
  opening |o--o{ placement : "is watched by"
  device ||--o{ placement : "has stood"
  label ||--o{ labelled : "is on"
  device ||--o{ labelled : "has"
  space ||--o{ labelled : "has"
  automation ||--o{ labelled : "has"
  person |o--o{ script : "last changed"
  home }o--o| media : "is pictured by"
  device }o--o| media : "is pictured by"
  person ||--o{ person_key : "signs with"
  person ||--o{ person_identity : "linked"
  person ||--o| member : "is in the family as"
  person ||--o{ invitation : "made, or took"
  person ||--o{ shortcut : "keeps"
  automation ||--o{ shortcut : "is started from"
  person }o--o| media : "is pictured by"
  home ||--o{ automation : "is the clock of"
  device ||--o{ device_kv : "remembers"
  device ||--o{ device_reading : "last said"
  device ||--o{ sample : "recorded"
  device ||--o{ sample_hour : "rolled up"
  device ||--o{ sample_change : "changed"
  device ||--o{ track : "has been"
  device ||--o{ device_attribute : "has had"
  device ||--o{ device_event : "raised"
  device ||--o{ device_link : "is the source of"
  device ||--o{ device_link : "is the target of"
  device ||--o{ device_switch : "was switched"
  device ||--o{ device_write : "was written"
  automation ||--o{ automation_role : "is filled by"
  device ||--o{ automation_role : "fills"
  automation ||--o{ automation_role : "is started by"
  automation ||--o{ automation_group_part : "goes through"
  device ||--o{ automation_group_part : "is one of"
  automation ||--o{ automation_world : "is filled by"
  person ||--o{ automation_world : "fills"
  automation ||--o{ automation_memory : "remembers"
  automation ||--o{ automation_trigger : "watches with"
  automation ||--o{ automation_run : "ran"
  automation_run |o--o{ automation_run : "started"
  automation_run ||--o{ automation_run_device : "used"
  automation_run_device ||--o{ automation_run_role : "filled"
  automation_run_device ||--o{ automation_run_key : "gave"
  automation_run_key ||--o{ automation_run_reading : "read"
  automation_run_device ||--o{ automation_run_reach : "could be reached"

  device {
    text id PK "d-3f9a2c61b0e43f9a"
    text key "garage-p280 · its name in configuration · one device you have to a key"
    text type_id "aferiy.p280 · a DeviceType id · changed only by a move that maps its history"
    text identity "sydpower:AABBCC001122 · read from the device · null until first read"
    text name "Garage P280"
    json config "{} · the type's own choices · tuya.plug: {profile: atorch-s1} · Open-Meteo: {lat, lon}"
    json description "{parts: [...], attributes: [...], events: [...]} · the latest, the type's or its own"
    text description_source "type · device · whose word the description is"
    json info "{manufacturer: AFERIY, model: P280, firmware: {...}} · null until it has said"
    int picture_type "1 · one of its type's pictures, by number"
    text picture_id FK "a media id · a photo of its own · both null: its type's first"
    text added_at "2026-09-27T19:40:00Z"
    text paused_at "null · set by Pause · kept, not reached"
    int track_days "null · 30 · how long where it has been is kept · its owner's choice"
    text removed_at "null · set by Remove · history kept"
  }
  device_connection {
    text id PK "c-8e1d44a0f2b78e1d"
    text device_id FK "d-3f9a2c61b0e43f9a"
    text method "wifi · a ConnectionMethod id of the device's type"
    text transport "mqtt · copied from the method, for the address rule"
    text held_by FK "n-51d0e7a2c9f351d0 · the node that holds it: the master, or a node that follows it · null through a bridge"
    text through FK "null · d-7c2e… · the bridge it goes through, held wherever that is; then transport is bridge"
    text address "AABBCC001122 · 192.0.2.41 · a browser's Bluetooth handle · a member's key within its bridge"
    int priority "0 = preferred · 1 = the fallback"
    json config "{} · the method's own choices · {protocolVersion: 3.4}"
    int secrets_exportable "0 · 1: its secrets may leave in plain text, its owner's choice"
    text created_at "2026-09-27T19:40:00Z"
    text last_connected_at "2026-09-27T21:02:10Z"
  }
  connection_secret {
    text connection_id PK "c-2b7e05d9a1c42b7e"
    text field PK "localKey"
    text value "encrypted with KRAFTVERK_SECRET_KEY"
    int encrypted "1"
  }
  family {
    text id PK "f-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB · made once, with its database"
    text name "The Examples · what the people in it call it"
    text kind "family · household · friends · other: only the words on screen"
    text locale "en-GB · what is said to all of it"
    text master_id FK "n-… · the node whose database is the family's: the one writer"
    text created_at "2026-10-02T08:00:00Z"
  }
  place {
    text id PK "h-… a home · z-… a zone"
    text kind "home · zone"
    text key "home · lake-cabin · its name in configuration"
    text name "Home · Lake cabin"
    real latitude "59.33 · null: a home that has not said"
    real longitude "18.07"
    real radius "150 · metres: its geofence"
    text time_zone "Europe/Stockholm · a home's always"
    text country "SE"
    text removed_at "null · set when left: history kept"
  }
  home {
    text id PK FK "the place it is"
    text type "house · apartment · cabin · boat · caravan · office · other"
    text picture_id FK "a media id · null: none"
    real bearing "0 · degrees: where its floor plans sit on the globe"
    int position "0 · its order among the family's homes"
  }
  space {
    text id PK "s-… · a home's site, made with it, is the root"
    text home_id FK "h-… · with parent_id, one home: a parent is of the same home"
    text parent_id FK "s-… · null only for the site"
    text key "kitchen · unique in its home among those not archived · site: the home itself"
    text kind "site · building · floor · room · area · stairs · outdoor"
    text purpose "kitchen · bedroom · … · null: none said"
    text name "Kitchen"
    int position "0 · its order among its siblings"
    int level "0 · a floor's: 0 the ground floor · null for any other"
    real elevation "0 · a floor's: metres above the ground"
    real height "2.4 · metres floor to ceiling"
    real frame_x "null · its frame's origin in its parent's, metres, with frame_y and frame_turn"
    real frame_turn "null · degrees clockwise from its parent's frame"
    text outline "null · a GeoJSON Polygon in metres, in its own frame"
    text removed_at "null · set when removed: what stood there is history"
  }
  floor_plan {
    text space_id PK "s-… · a floor"
    text media_id FK "the drawing: a media id"
    real scale "0.02 · metres a pixel"
    real x "where its top-left corner falls in the floor's frame, with y"
    real turn "0 · degrees about that corner"
  }
  opening {
    text id PK "o-…"
    text home_id FK "h-…"
    text key "front-door · unique in its home"
    text from_id FK "s-… · a space of the home"
    text to_id FK "s-… · null: the outside"
    text kind "door · opening · stairs · window · gate · garage-door · elevator"
    text name "Front door · null: its kind"
    text shape "null · a GeoJSON LineString in metres, in from's frame: where in the wall"
    text removed_at "null · set when removed, or with a space it joins"
  }
  placement {
    text id PK "pl-…"
    text device_id FK "d-…"
    text part "main · a part placed apart from its device"
    text space_id FK "s-… · the site: in the home, room not said"
    text opening_id FK "o-… · one it watches, of that space · null: none"
    real x "null · metres in the space's frame, with y and z"
    real facing "null · degrees"
    text role "stands · based: where one that moves belongs"
    text since "2026-10-08T12:00:00Z"
    text until "null: now · one open row per device and part"
    text actor_kind "person · … · who placed it, with actor_id and actor_name"
  }
  person {
    text id PK "p-01J… · made where they signed up · the same in every family"
    text name "Anna Example · as their chain says · Someone who left, erased"
    text short_name "Anna · null: their name"
    text picture_id FK "the media it is · null"
    text locale "sv-SE · null: the family's"
    text managed_by FK "p-… · an admin who keeps them · null"
    json chain "their signed statements · null: no key of their own yet"
    text updated_at "their profile's own time: a newer copy replaces an older"
    text erased_at "null · set when forgotten: the id alone stays"
  }
  person_key {
    text id PK "k-… · the key's thumbprint"
    text person_id FK "p-…"
    text kind "device · recovery"
    json public_key "a P-256 JWK"
    text device_name "Anna's iPhone · null for a recovery key"
    text added_with FK "k-… · the key that signed it in · null: their first"
    text vouched "null: their chain says it · provider:apple · an admin's p-…"
    text revoked_at "null"
  }
  person_identity {
    text provider PK "apple"
    text subject PK "what the provider calls them"
    text person_id FK "p-…"
    text email "null · when they let it be given"
  }
  member {
    text person_id PK "p-…"
    text role "admin · member · child · at least one admin, always"
    text nickname "Mum · what this family calls them · null"
    text color "#10b981 · one each, among those in it"
    text joined_at "2026-10-08T12:00:00Z"
    text invited_by FK "p-… · null"
    text left_at "null · set when they leave: the row stays for history"
  }
  invitation {
    text id PK "i-…"
    text role "admin · member · child"
    text for_name "Grandma · null: anyone with it"
    text secret_hash "SHA-256 of its secret: the secret is never kept"
    int needs_approval "1: an admin lets them in"
    text made_by FK "p-…"
    text expires_at "a day to thirty after it was made"
    text used_by FK "p-… · null: not taken"
    text approved_by FK "p-… · null"
    text revoked_at "null"
  }
  shortcut {
    text person_id PK "p-… · a person's own, never the family's"
    text automation_id PK "a-…"
    int position "0 · its place on their home page"
  }
  script {
    text id PK "sc-01JA9… · a prefix and a ULID"
    text key "feels-like · unique: its name in configuration"
    text name "Feels like"
    text source "the TypeScript as written · at most 64 KB · the one thing kept"
    text created_at "2026-10-09T10:00:00Z"
    text updated_at "2026-10-09T10:05:00Z"
    text updated_by_kind "person · agent · automation · who last changed it"
    text updated_by_id "p-01JA8…"
    text updated_by_name "olof · as they were called then"
  }
  label {
    text id PK "l-…"
    text key "heating · unique: its name in configuration"
    text name "Heating · unique, as a person reads it"
    text color "#f76b15 · null"
    text icon "null"
  }
  labelled {
    text label_id FK "l-…"
    text device_id FK "d-… · exactly one of device, space and automation"
    text space_id FK "s-…"
    text automation_id FK "a-…"
  }
  media {
    text id PK "the SHA-256 of its bytes: one picture kept once"
    text type "image/webp · image/jpeg · image/png"
    int bytes "184 320"
    int width "2048"
    int height "1536"
  }
  node {
    text id PK "n-51d0e7a2c9f351d0 · made by the node itself, once: every home's database knows it by it"
    text name "Garage NAS · Chrome on Windows · This iPhone"
    text platform "system · web · native · what its transports' entries are for"
    int always_on "1 · runs while nobody looks"
    int reachable "1 · others connect to it"
    int trusted "1 · what must stay put may be kept on it"
    json transports "[mqtt, ble, lan, https] · what it reaches devices over, as it last said"
    text account_id "u-2a9c40e1b7d8 · the server account it joined for · null: this node, or no accounts"
    int self "1 · the node this database belongs to: one"
    text created_at "2026-09-27T19:30:00Z"
    text last_seen_at "2026-09-27T21:05:00Z"
  }
  device_kv {
    text device_id PK "d-3f9a2c61b0e43f9a"
    text key PK "sim.settings"
    text value "{acChargingWatts: 800}"
  }
  device_reading {
    text device_id PK "d-21e89beca7573685"
    text key PK "temperature"
    text value "23.2 · JSON, any shape a reading has"
    text at "2026-10-07T20:23:11Z · when the device said it"
  }
  device_link {
    text id PK "l-0c7f3e19a2b80c7f"
    text kind "feeds · a LinkKind id"
    text source_device FK "d-5b2e90c4a1d35b2e · Heater plug"
    text source_part "main"
    text target_device FK "d-3f9a2c61b0e43f9a · Garage P280"
    text target_part "input.ac"
    int one_per_source "1 · as its kind declares: a plug feeds one thing"
    text created_at "2026-09-27T19:45:00Z"
  }
  sample {
    text device_id PK "d-3f9a2c61b0e43f9a"
    text part "main · pack.1 · the part the key begins with"
    text key PK "soc · the type's own key · means charge"
    text at PK "2026-09-27T19:41:00Z"
    real value "87 · a number, or on/off as 1/0"
    text text "charging · an enum or text instead of a value"
  }
  sample_hour {
    text device_id PK "d-3f9a2c61b0e43f9a"
    text part "main"
    text key PK "soc · a numeric attribute"
    text hour PK "2026-09-27T19:00:00Z"
    real min "81"
    real avg "84.5"
    real max "88"
    int n "60 · the samples it was rolled up from"
  }
  sample_change {
    text device_id PK "d-3f9a2c61b0e43f9a"
    text part "outlet.ac"
    text key PK "outlet.ac.on · an on/off or an enum"
    text at PK "2026-09-27T14:02:13Z · when the device observed it"
    real value "0 · on/off as 1/0"
    text text "eco · an enum instead"
  }
  track {
    text device_id PK "d-5b0e7c2a91f45b0e"
    text at PK "2026-10-08T07:12:40Z · when it was located there"
    real latitude "59.3293"
    real longitude "18.0686"
    real accuracy "12 · within how many metres · null when it did not say"
  }
  device_attribute {
    text device_id PK "d-3f9a2c61b0e43f9a"
    text key PK "pack.1.soc"
    text part "pack.1"
    json spec "{label: Pack 1 charge, value: {type: number, unit: %}, means: charge}"
    text first_seen "2026-09-27T19:41:00Z"
    text last_seen "2026-09-29T10:02:00Z"
  }
  device_event {
    int id PK "88"
    text device_id FK "d-3f9a2c61b0e43f9a"
    text part "main"
    text event "overload · declared in its description"
    text level "warn"
    json data "{watts: 2400}"
    text at "2026-09-28T18:12:40Z"
  }
  automation {
    text id PK "a-71c2d0e5f9a371c2"
    text key "start-charging-the-scooter · its name in configuration · unique"
    text name "Sunny heater · Start charging the scooter"
    json rule "{roles, params: {fields: {}}, when, if, then, otherwise} · its own, checked before it is kept"
    text made_from "standard.start-charging · the recipe it was copied from · null: built from nothing"
    text time_zone "Europe/Stockholm · the owner's clock"
    text mode "off · watch · act"
    text acting_for FK "p-01JA8… · the person whose yes it acts on: what its scripts do, they do for them · null: nobody's"
    int recheck_minutes "10 · null: never; how often a condition that still holds keeps things so"
    text looked_at "when it last looked again · null: not yet"
    text created_at "2026-10-15T08:00:00Z"
  }
  automation_role {
    text automation_id PK "a-71c2d0e5f9a371c2"
    text role PK "charger"
    text device_id FK "d-3f9a2c61b0e43f9a · null: another automation fills it"
    text part "main · outlet.ac"
    text starts FK "a-0c9d1e2f3a4b0c9d · the automation a step starts · null: a part fills it"
    text script_id FK "sc-01JA9… · the script a role names · exactly one of part, starts and script"
  }
  automation_group_part {
    text automation_id PK "a-71c2d0e5f9a371c2"
    text role PK "chargers · a group a for each goes through"
    int place PK "0 · its order in the group"
    text device_id FK "d-3f9a2c61b0e43f9a"
    text part "main · outlet.ac"
  }
  automation_world {
    text automation_id PK "a-71c2d0e5f9a371c2"
    text role PK "children"
    int place PK "0 · its order among the people"
    text kind "person · people · everyone · place"
    text person_id FK "p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB · null: a place or everyone"
    text place_id "h-1 · a home, a zone or a space · null: a person"
    text place_kind "home · zone · space"
  }
  automation_memory {
    text automation_id PK "a-71c2d0e5f9a371c2"
    text name PK "timesCharged"
    text value "3 · JSON, in its field's unit"
  }
  automation_trigger {
    text automation_id PK "a-71c2d0e5f9a371c2"
    text trigger PK "low · its id · or #2, its place in its rule's when"
    int holds "1"
    text held_since "2026-10-16T05:00:12Z"
    int fired "1"
  }
  automation_run {
    text id PK "r-5b2e90c4a1d3f7e2"
    text automation_id FK "a-71c2d0e5f9a371c2"
    text started_at "2026-10-16T17:02:00Z"
    text ended_at "2026-10-16T17:03:41Z · null: running now, one at a time"
    text outcome "acted · failed · stopped · interrupted · running · …"
    text started_by_kind "person · agent · null: its own triggers"
    text started_by_id "null until people have ids"
    text started_by_name "olof · as they were called then"
    text started_by_run FK "r-9a8b7c6d5e4f3a2b · the run whose step started it · null: none"
    text why "Started by olof"
    text summary "Scooter plug: Power 238 W, after 2 tries"
    json detail "{saw, conditions, steps: [{kind, depth, within, what, outcome, detail, at, endedAt, until}]}"
  }
  automation_run_device {
    text run_id PK "r-5b2e90c4a1d3f7e2"
    text device_id PK "d-5b2e90c4a1d35b2e · no reference to device: a log outlives its device"
    text name "Garage station · as it was named then"
    text type_id "acme.station"
  }
  automation_run_role {
    text run_id PK "r-5b2e90c4a1d3f7e2"
    text role PK "charger"
    text label "The charger’s plug"
    text device_id FK "d-9a8b7c6d5e4f9a8b"
    text part "main"
  }
  automation_run_key {
    text run_id PK "r-5b2e90c4a1d3f7e2"
    text device_id PK "d-9a8b7c6d5e4f9a8b"
    text key PK "watts · outlet.ac.watts"
    text part "main · outlet.ac"
    text label "Power · AC outlets draw"
    text kind "number · boolean · enum · text"
    text unit "W · null: none"
    text quantity "power · null: none"
    json words "{true, false} · [{value, label}] · null"
  }
  automation_run_reading {
    text run_id FK "r-5b2e90c4a1d3f7e2"
    text device_id FK "d-9a8b7c6d5e4f9a8b"
    text key FK "watts"
    text at "2026-10-16T17:02:07.300Z · when the device took it"
    text heard_at "2026-10-16T17:02:07.302Z · when the run saw it"
    json value "297 · true · null: the device has not said"
  }
  automation_run_reach {
    text run_id FK "r-5b2e90c4a1d3f7e2"
    text device_id FK "d-9a8b7c6d5e4f9a8b"
    text at "2026-10-16T17:02:00.010Z"
    int reachable "0 · 1"
    text detail "Its gateway cannot reach it: is it plugged in?"
  }
  device_switch {
    text device_id PK "d-5b2e90c4a1d35b2e"
    text part PK "main · outlet.ac"
    text switched_at "2026-10-16T17:02:10Z · what the dwell counts from"
    text by_kind "person · agent · automation · who switched it"
    text by_id "a-71c2… · the automation's id; null for a person until W3"
    text by_name "olof · Morning · as they were called then"
  }
  device_write {
    text device_id PK "d-5b2e90c4a1d35b2e"
    text attribute PK "afterPowerCut"
    text written_at "2026-10-16T17:05:00Z"
    text by_kind "automation"
    text by_id "a-71c2…"
    text by_name "Morning"
  }
  audit {
    int id PK "4812"
    text at "2026-09-27T19:51:12Z"
    text kind "device.control"
    text actor_kind "person · agent · automation · node · integration · system"
    text actor_id "a-… · n-… · null where there is no id"
    text actor_name "olof · Morning · Garage NAS · as it was called then: no reference, so history is never rewritten"
    text resource_kind "device · node · automation · account · transport · null with resource"
    text resource "d-3f9a2c61b0e43f9a · not a foreign key: it outlives the device"
    text summary "Switched the AC outlets off"
    json detail "{part: outlet.ac, capability: switch, command: set, args: {on: false}}"
  }
  home_setting {
    text home_id PK FK "the home whose values these are"
    text key PK "policy.values · only these: nothing about one device or automation"
    text value "{loadWatts: 10, reserveSoc: 20}"
    text updated_at "2026-09-01T10:00:00Z"
  }
  node_setting {
    text key PK "family.moved · family.kept · what this node settled about the family it keeps"
    text value "2026-10-02T08:00:00Z"
    text updated_at "2026-10-02T08:00:00Z"
  }
  sighting_ignored {
    text transport "lan · ble · bridge"
    text through FK "null · d-7c2e… · the bridge a member was found behind"
    text address "192.0.2.41 · lamp-0001"
    text ignored_at "2026-10-06T19:00:00Z"
  }
  transport_kv {
    text transport PK "ble · matter · mqtt"
    text key PK "bond.AABBCC001122"
    text value "what the transport keeps between runs"
  }
  meta {
    text key PK "schema_hash · created_at · created_by_version"
    text value "1843021779 · 2026-09-29T12:00:00Z · 0.1.0"
  }
```

**A server's own tables.** Logins are the server's: a phone or a browser
keeping a family has none, so they are not in the schema every node
carries. The server keeps them in a database of its own, `node.db` beside
the family's ([`server/src/auth/schema.ts`](../server/src/auth/schema.ts)),
set aside only when its own schema changes — and then it hands `login` to
the new one, never `login_session` (§5). A family's database set aside
signs nobody out. Each login names the person it is; a person's own device
signs in by its key, with no login at all.

```mermaid
erDiagram
  login ||--o{ login_session : "opened"
  login {
    text id PK "u-2a9c40e1b7d8"
    text person_id "p-… · the person it is, in the family's database"
    text username UK "olof · unique regardless of case"
    text password_hash "argon2id"
    text created_at "2026-08-01T12:00:00Z"
    text created_by "null for the first login"
    text password_changed_at "2026-08-01T12:00:00Z"
    text last_login_at "2026-09-27T19:30:00Z"
  }
  login_session {
    text token_hash PK "sha-256 of the cookie · the token is never stored"
    text person_id "p-… · who is signed in"
    text login_id FK "u-2a9c40e1b7d8 · null: their own key opened it"
    text created_at "2026-09-27T19:30:00Z"
    text last_seen_at "2026-09-27T21:05:00Z"
    text expires_at "2026-10-27T19:30:00Z"
    text client_ip "the address it last came from"
    text user_agent "Safari on iOS"
  }
```

A node's `account_id` names one of these where the master is a server — the
account it joined for — and deleting the account forgets the nodes it
joined; elsewhere it is plain text, null. A person forgotten takes their
logins and sessions with them.

**What a device keeps of its own accounts.** The personal store
([`packages/store/src/personal.ts`](../packages/store/src/personal.ts)) is
a third database, on each device that runs the app, never on a server's
behalf: `me` — each account on this device, its chain, the id of this
device's key for it (whose private half the platform keeps), what the
device is called, whether its recovery words were checked, and the one it
opens as — and `my_family`, the families each account is in and where
each one's master is: this device, or a server by its address.

### What each table is for, traced to the flow

| Table | Why it exists | Filled in at |
|---|---|---|
| `device` | The thing you added, and the key its history hangs on. | step 10 |
| `device.identity` | So the same physical device is recognised however it was found, and so re-adding a removed one can bring its history back. | step 7, or at the first connection after *Save anyway* |
| `device.paused_at` | So a device away, or being mended, is kept as it is and not reached — nor anything through it — without removing it. | Pause, Resume |
| `device.removed_at` | So Remove doesn't destroy years of history. | Remove |
| `device.track_days`, `track` | Where a device that says where it is has been — a phone, a scooter — kept only when its owner turns it on, for a day to a year (docs/PLAN-MAPS.md). A point when it has moved, or each hour it stays; let go after its days. Turning it off, or removing the device, forgets it at once; it is never in an export, only that it is kept and for how long. | its settings, or its own screen; then by the sampler, as it is located |
| `device_connection` | A device can be reached more than one way, from more than one place. Your station over Wi-Fi from the server *and* over Bluetooth from your phone is one device with two connections. A way is held by a node, or goes **through** a bridge — another device, such as an account its scooters are reached through — and is then held wherever that device is, its address the member's key within it (PLAN-INTEGRATIONS.md §4.3). Never both. | step 10, or *Add another way to reach it* |
| `connection_secret` | Credentials belong to a way of reaching the device (the Tuya local key is part of *tuya-local over lan*), not to the device. | step 6 |
| `family` | The family this database is — one: the people who share its devices, nodes and homes, and its master (docs/PLAN-WORLD-MODEL.md). | when the database is made |
| `place`, `home` | The family's homes — each a place with its geofence, its clock and its address, and what a home has more: its type, its picture, its order. The first is made with the family; one left is archived. Zones come with presence. | with the family; then in App settings › Homes |
| `space`, `opening` | A home's buildings, floors, rooms, areas, stairs and outdoors, as a tree from its site — the home itself, made with it — and the doors, stairs and windows where they meet, or meet the outside. Removed, a space is archived with what is inside it and its openings; what stood in it moves out to its parent. A space may be drawn — an outline in a frame of its own, an opening's place in the wall — and a floor have a drawing (`floor_plan`) rooms are traced over: the home's map in its frame. | on a home's page and its map; from a file |
| `placement` | Where a device stands — or, one that moves, where it is based — as intervals: placing it closes the open row and opens the next in one transaction, so a reading is the room's it was read in, and a space's history is what stood there while it stood there. | a device's *Where it is*; from a file |
| `person`, `person_key`, `person_identity` | A person as their own chain says: their profile, the keys they sign with — each device's, and the recovery key their twelve words make — and the sign-in providers they linked. Kept by every family they are in, a newer copy replacing an older; checked statement by statement. Erased, only the id stays. | founding a family, taking an invitation, showing a newer copy |
| `member` | Being in this family: a role, what it calls them, their colour. Left, the row stays for the history that names them. | founding, an invitation taken or let in; the People page |
| `invitation` | A one-time secret in a link and a QR code — kept as its hash — taken once by someone showing who they are, in its role at once or once an admin lets them in. | the People page, by an admin |
| `shortcut` | Each person's own shortcuts on their home page, in their order: an automation's place is never everyone's. | an automation's page; from a file, under each person |
| `label`, `labelled` | The family's own groupings, on devices, spaces and automations; the home screen filters by one, a label on a space being on what stands in it. Removed, it comes off everything. | App settings › Labels; a device's settings; from a file |
| `script` | The family's scripts in TypeScript (docs/PLAN-SCRIPTS.md), each by key: its source as written, and who last changed it. Kept only when this place's engine reads it without a problem. What it compiles to and what it declares are read from the source again — as the hub starts, and when it changes — and never kept. | Automations › Scripts; from a file |
| `sharing` | What each person shares of where they are — precise, places, home-away or off, paused for a while — and how many days their stays are kept: their own to set, an admin's for a child. By the person, so one waiting to be let in has chosen already; none, the family's default (places, 90 days). | joining or founding; People; from a file |
| `notification`, `push_endpoint` | What each person was told — by an automation, a device, a person — read or not, kept 90 days; and where each of their apps is woken with it: a browser's push subscription, per node, a secret in effect. A push its service says is gone forgets the app. | `hub.notify`; App settings › Notifications |
| `presence_stay` | Where people have been: stays at a home or in a zone, and in a room, as intervals — the open ones are where each is now. Worked out from the freshest position of what each carries: arriving inside a geofence, leaving after five minutes out of it; at one home at a time, zones overlapping. A room from a carried device's spot on its own map (a watch a room's beacons hear), anchored where that device is placed: the innermost drawn room it falls in, one at a time, ended when the spot is two minutes old; kept at `places` and above. Kept only as far as each shares (homes alone at home-away, nothing at off) and as long as each says; never on the timeline or in the file. | as positions arrive (`packages/hub/src/presence`) |
| `mode`, `home_mode`, `home_mode_said` | A home's modes on two axes — presence (home, away, vacation) and the day (day, evening, night) — and the family's own on either, by key; and what set each home's, with who: a setting for good from a time (until the next for good), or one planned from a time until another — a vacation from Saturday — after which the setting for good in force then is again. A setting for good leaves what is planned ahead as it is; set while one planned lasts, it ends it. Every home is in a mode on each axis: home and day until something says otherwise. Which mode was last said on the bus, per home and axis, so what began while nobody listened is said when someone does. Kept two years; the family's own modes in the file, never which a home is in. | the home screen, App settings › Modes, automations (`packages/hub/src/modes`) |
| `variable`, `variable_value` | A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md): each by a key in camelCase unique among the home's not let go, its kind — toggle, number, choice, text, time, counter — and its field (title, unit, range, options, what it starts as) as JSON, in its order; let go, archived. What each holds now, beside it: the value as JSON, when and by whom it was set — none, what it starts as. Only the last value is kept; the file carries what each is, never what it holds. | the home screen, App settings › Variables, automations and scripts (`packages/hub/src/variables`) |
| `occupancy`, `occupancy_evidence` | Whether a space has someone in it, whoever they are, as intervals, with the devices that said so: a radar while it says so; motion, and five minutes after unless a radar there says nobody is; a count above nought, the most counted its peak; a closed room — every way in a door whose contact says it is shut — with motion that began after the last shut, until a door opens; a person's room stay, by no device (who it was is theirs). Times are when a value changed, never when a device last spoke; just started, nothing is ended for the length of a hold. A floor, a building and the site are occupied while a space within is, a counter there counting what is within. Each change said on the bus. Kept 30 days; never on the timeline or in the file. | as sensors report (`packages/hub/src/occupancy`) |
| `device_person` | Who a device is with, as intervals: who carries it — its position is theirs, what presence goes by — its usual driver, whose it is, who uses it. One carrier and one driver at a time; one who leaves the family is with none of its devices. | a device's settings; from a file |
| `place` (zones) | A zone is a place as a home is, with no home beside it: school, work — always somewhere, a circle by its radius, archived when let go. | App settings › Zones; from a file |
| `home_setting`, `node_setting` | A home's values (its policy), by home; and what this node settled about the family it keeps — moved to a server, a server's copy brought in. | when set |
| `media`, `media_data` | Pictures, kept by their content: a home's, a device's own photo. Let go when nothing names one. | when one is added |
| `node` | Every kraftverk node of the home — the hub running somewhere: the one this database belongs to (`self`), the home's master, and the nodes that follow it, the always-on machine among them. Each declares what it is — always on, reachable, trusted — which is how the master is chosen, and what a connection's holder names: "Bluetooth, from Olof's iPhone". | when the database is made (its own); when another joins |
| `device_link` | Facts about the house, between parts — which plug feeds which station's mains input, which station's outlet feeds another — that the gateway, the energy view and automations all read. | step 9, or later on the device's page |
| `device_kv` | What a session keeps between runs: a simulator's settings, a plug's detected protocol version. | by the session |
| `device_reading` | What each device last said of each attribute, and when — what it shows, as it was, after a restart until it says again (a sensor that speaks hourly, a broker recreated). Never current: the gateway reads only what the session says now. A simulator's are not kept. | by the holder, as devices say what changed |
| `device.description`, `device_attribute` | What the device is — so a closed or removed device is still described — and every attribute it ever had, so history keeps its labels after a part is gone. | step 10, then whenever it changes |
| `device.description_source` | Whether the description is the type's, for its config, or the device's own — a station that reports its packs. | step 10, then whenever it changes |
| `sample` | History: every attribute the description says to keep, with its part, while its value is current. | continuously, by the holder |
| `sample_hour` | Each numeric attribute's hours rolled up — lowest, mean, highest and how many — kept for two years, so a chart of a year reads hours, not minutes. | each hour, by the sampler |
| `sample_change` | Every change of an on/off or an enum, when it happened: what a timeline draws ("AC outlets off 14:02–14:19"), where minute samples would blur a switch flicked between them. Two years, and each key's latest beyond. | as readings move, from the server's sessions and from apps' uplinks |
| `last_heard` | In an app with a server: what the server last said, by what was asked — its devices, its automations, the home's values — with when. What the app shows, read only and saying so, while the server cannot be reached. Empty on a server. | as the server answers |
| `send_queue` | In an app holding ways for a server: what it owes the server — readings, events, timeline entries, what a session kept — in order, kept across a restart and gone once the server has it. Empty on a server. | as the app's sessions and gateway work |
| `sighting_ignored` | What a person said not to offer again: something a transport sees, or a member behind a bridge. Named as a connection names a device — transport, bridge, address — and listed apart, where it can be offered again. | *Not mine* on something found |
| `transport_kv` | What a transport keeps between runs — a Bluetooth bond, a Matter fabric — its own and no other's. | by the transport |
| `meta` | What the database is: the schema it was made with, when, and by which version — what the set-aside message reports. | when the database is made |
| `audit.resource_kind` | What an entry is about, as a kind and an id together, so the timeline can be asked for one device's, one automation's, one account's. | with every entry |
| `device_event` | What devices said happened, beside their history. | when a device raises one |
| `device.picture` | Which picture a device shows: its owner's pick, the same in every app. | on its page |
| `device_switch`, `device_write` | The gateway's memory of each part and setting: when it was last switched or written, and by whom — what the dwell counts from, so a restart is no way around it, and what lets an automation that keeps things so leave what another automation set. A part never switched has no row: its first switch through a consequential link is confirmed. | by the gateway, at each switch and write |
| `automation`, `automation_role` | An automation: its own rule, the recipe it was copied from, its clock, mode and place on the home page; and what fills each role — a part of a device, or another automation a step starts — a row each, so a device's page asks which automations it can start; an automation deleted takes with it the roles that would start it, and those that did say they have nothing to start. | made, changed |
| `automation_group_part` | The parts of each group a `for each` goes through, in order, each once: a device's page asks this too. | made, changed |
| `automation_world` | Who and where fills each role of the family's world: a person, some people in order, everyone, or a place — a home, a zone, a space of the automation's home. | made, changed |
| `automation_memory` | What each automation remembers, by name: the value a run last left it, kept across runs, restarts and changes to it. | as a run remembers |
| `automation_trigger` | Each `becomes` trigger's state, so a restart continues a hold and never fires one twice. | as its conditions are looked at |
| `automation_run` | Every run, with each step it took; the unended one is running now, written at every step — one at a time, held by a unique index. A restart ends it as interrupted (docs/SEQUENCES.md). | as it runs |
| `automation_run_device`, `automation_run_role`, `automation_run_key` | A run's log, as the run saw its world: each device it used (its name and type then), which part of which device filled each role, and what each value it kept is (part, label, kind, unit, quantity, the words for on/off and options) — so a log stays whole when a device is renamed, re-described or removed, or a role filled by another. | as a run that takes steps begins, and as a value is first seen |
| `automation_run_reading`, `automation_run_reach` | Every reading each device a run uses gave while it ran — each time its value or time changed, at the time the device took it and the time the run heard it — and each change in whether it could be reached, and why not. Heard as each device says it on the live bus, whenever a step judges or a switch is made, and every second; at most 20 000 readings a run, gone with its run. What a run's log page draws, and what a run is debugged from. | as devices speak while it runs |

### Rules the schema and the code enforce

- **One device per identity.** There is a unique index on `device (identity)`
  where `removed_at IS NULL`. A removed device keeps its identity, so re-adding
  that device finds it (step 7, *Yours before*).
- **One connection per device, method and node.** There is a unique index on
  `(device_id, method, held_by)`.
- **An exclusive address belongs to one device.** For transports that declare
  themselves exclusive (`mqtt`, `ble`, `lan`), two connections the same node
  holds, of different devices, may not share a `(transport, address)`. Step 5 greys such a
  sighting out, and the save refuses it. `https` is not exclusive: two weather
  services can use the same API.
- **`type_id` changes only by a mapping a person sees.** When the check finds
  a device you have under another type (`outcome: 'yours'` with a `move`),
  saving with `mode: 'move'` keeps the device and maps its history: each
  `device_attribute` onto the new description by meaning, key or label,
  `sample`, `sample_change` and `sample_hour` re-keyed (converted where a unit
  changed), links and automation roles re-pointed by part, the ways the new
  type has none for removed, `device_kv` and `device_reading` cleared (docs/PLAN-ZIGBEE.md §2.1).
- **`method` must be one of that type's methods,** checked on write against
  the installed definitions. Each `config` is validated against the schema
  its definition declares: the type's for `device.config`, the method's for
  `device_connection.config`. Neither ever holds a secret.
- **A connection's secrets stay on the node that holds it.** In each
  database, `connection_secret` holds only the secrets of connections its own
  node holds, sealed; a connection another node holds has none there.
- **Links join parts, and a kind may allow one target per source part.**
  `feeds` does — a plug feeds one thing — so a second replaces the first.
  The row says so (`one_per_source`, from its kind), and a partial unique
  index on `(kind, source_device, source_part)` holds it: no concurrent add
  or direct write can give a source part two. The same link twice is refused
  by a unique index on all its ends.
- **What an audit entry is about is a kind and an id together, or neither,**
  checked by the table.
- **The audit log is never cascaded,** so it still says what happened to a
  device after the device is gone.

### What is not stored

| Live state | Example | Held by |
|---|---|---|
| **Sighting**: something a transport sees that no connection claims | the broker has client `AABBCC001122` connected | each holder's transports. It feeds "Found near you" and step 5, and is gone after a restart. The broker also keeps a file of stations it has seen, so they reconnect quickly. That file is the broker's own. |
| **Setup draft** | type, method, holder, address and a placeholder for the key, part-way through the flow | the app, plus the server for server-run steps; fifteen minutes |
| **Active connection**: which of a device's connections is in use | Garage P280 is using `wifi`; `bluetooth` from the iPhone is standing by | the session manager (§4) |
| **Latest reading** | battery 87 % observed at 21:04:58 | the session. `sample` holds history at the sampler's resolution, for as long as each value stays current. |
| **Definitions** | categories, types, methods, protocols, transports, capabilities, link kinds | the installed packages |

---

## 4. After a device is added

### Its connections

Each device's page has a **Connections** section, and it is where
`device_connection` shows on screen:

> **Wi-Fi, through your server**: in use · connected 3 min ago
> **Bluetooth, from Olof's iPhone**: standing by · last connected yesterday
> *Add another way to reach it* · *Make preferred* · *Remove*

- **One connection is in use at a time.** It is the connection with the lowest
  `priority` that can be reached right now. A station takes one Bluetooth
  connection at a time, and two holders writing to one device would race. A
  connection lower in the list takes over only while every one above it is
  unreachable, and gives the device back when they return.
- **Adding another way to reach a device** runs steps 3–7 with the type
  already chosen. Step 7 must find the *same identity*; a different device is
  refused ("That's a different station").
- **The last connection can't be removed.** You remove the device instead.

### When another node holds the connection

- The session runs **on that node** — this app's, for a server — with the
  same device-type and protocol code the master would run.
- **Readings are sent to the master** while that node has it, so history
  records. Anything not yet sent is queued and uploaded later.
- **The same safety rules apply.** The protocol's guards (register 68) and the
  gateway's rules (confirmation, dwell time, verification) are shared code that
  runs in the holder. The audit entry is sent to the master, and queued if
  offline.
- **Automations can reach the device only while that node has it.**
  The device's page says so, and an automation that can't reach it records why.
- The session's store (`device_kv`) stays with the master. The node reaches
  it through the API and keeps a copy for when it is offline.
- **What the app keeps, it keeps in its own database** (docs/PLAN-SHARED-CORE.md,
  phase 6): the device as the server has it, by the server's ids, with the
  way it holds (`held_by` its own node, `self` there); that way's secrets, sealed
  with the app's key; the session's store; the gateway's memory; and what
  it owes the server (`send_queue`). With the server away it still reaches
  the device, and sends what it owes when the server is back.

### Removing a device

| Action | What it does | Undo |
|---|---|---|
| **Remove** | Sets `removed_at`, closes the session, deletes its connections and their secrets (which frees their addresses) and its links. Its history, store and identity stay. | Add the same device again: step 7 offers to bring it back. |
| **Delete history** (on a removed device) | Deletes the row. Its samples and store go with it by `ON DELETE CASCADE`, after typing the device's name to confirm. | The copy the server makes before each migration, and backups. |

### Forgetting a node

Forgetting a node deletes its `node` row and the connections it held.
A device left with no connection shows "Nothing can reach this device" on its
page, with *Add a way to reach it*.

---

## 5. One schema

The database is one definition, `packages/store/src/schema.ts` — not a chain
of migrations (ARCHITECTURE.md §4.5, decision 21: strict version 1 while
kraftverk is in research and development). A database made by any other schema
is set aside beside itself, untouched, and a new one is started; history from
an older schema is not carried over. The fingerprint also covers the
configuration document's version (CONFIG.md): a home held as an older version
holds it — a way an integration has since moved, an account not yet a device
— so its database is set aside too, and the home carried over through the
file kept beside it, whose migrations bring it up to date. That file is never
written over with a home that does not check against what is installed.
The server's accounts are not in that file. They are read from the database
before it is set aside, and written into the new one: the columns both have,
unless the new table requires one the old lacked. In that case none are
carried. Sign-ins are never carried
(`server/src/platform/database.ts`).
When there is a production state to
protect, this section becomes the rules for changing a schema that holds it.

---

## 6. Local mode: no server

The app can run with no server at all (ARCHITECTURE.md, decisions 15 and
22): it keeps a home of its own — the same hub, the same schema, every record
above — in its own SQLite: expo-sqlite on a phone, SQLite's WebAssembly build
in a browser's worker (docs/PLAN-SHARED-CORE.md, phase 6). Its connections
are held by its own node — the only node of the home, its master — its
secrets sealed with a key the platform keeps.
It keeps history and runs automations while it is open.

Adding a server offers to move this home to it, as an import the person
sees first: the server takes the devices, links, automations and values,
and holds every way but one over a radio (`nearby`: Bluetooth), which this
app's node holds for it (`held_by` that node), its key staying there. History the app
recorded stays with the app. Leaving a server offers the reverse: the copy
the app kept of the server's home becomes its own, the server's history
staying with the server (docs/PLAN-SHARED-CORE.md, phase 6h).

---

## 7. Families, homes, and what comes next

A database is one **family** (docs/PLAN-WORLD-MODEL.md): the people who share
its devices, nodes and homes, its master the one writer. A family has
**homes** — each a place with its own clock — and every automation is for one
of them, or the family's. What comes next — rooms and where devices stand,
people and their keys, who carries what — is planned table by table in
[PLAN-WORLD-MODEL.md](PLAN-WORLD-MODEL.md), and built in the order of
[PLAN-WORLD-MODEL-WORK.md](PLAN-WORLD-MODEL-WORK.md).
