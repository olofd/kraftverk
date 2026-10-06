# Integrations: what they are, and how kraftverk does them

A design, 2026-10-06, from the bottom up: the words first, then the database,
then the code's contract, the runtime, the app, the configuration file, and
how Home Assistant's integrations are brought in — by porting them, and by
running them. It ends with the order of work and the decisions left to the
owner.

It builds on what is there ([ARCHITECTURE.md](ARCHITECTURE.md) §1–§4,
[DATA-MODEL.md](DATA-MODEL.md)) and changes it where this says so. Steps 1–5
are built (§12); §1.1 is the model they were simplified to, at the owner's
word, before anything new is added.

**The model, simplified (§1.1):** an **integration** is the one place
kraftverk meets a service or a vendor's system — its protocol, its accounts,
its own screens — and a **device package** is one kind of device built on
an integration. Parts talk by **calls, not messages**: a device behind an
account reads it through a typed link of plain function calls. Accounts
belong to their integration, and are managed on its page, not among the
devices.

**In one screen** (as first written; §1.1 says what changed):

- **An integration is code; a service is something you add.** They are not
  the same thing, and kraftverk should keep both words: an *integration* is
  the installed package that teaches kraftverk a product, a cloud or a
  standard; a *device*, a *service* or an *account* is what a person adds
  with it. Home Assistant blurs the two (§1).
- **What kraftverk lacks is the account.** One sign-in that brings many
  devices — an iCloud account and the family's phones, a NIU account and its
  scooters, a Hue bridge and its lamps, a Home Assistant and everything in it.
  Today each NIU scooter keeps its own copy of the account's password. The
  design makes an account a device of its own, and lets a device be reached
  **through** another: a *bridge* (§3).
- **Two kinds of package: the platform and the product.** An *integration*
  teaches kraftverk a platform — NIU's cloud and signing in to it, Tuya's
  local protocol and its gateways; a *device package* teaches it one product
  — the UQi GT Sport, the ATORCH plug — built on its integration. Few
  platforms, thousands of products, each a small package of its own (§1).
- **Manifests are data.** Thousands can be supported and listed without
  loading one line of their code; discovery matches the catalogue, and code
  is loaded when it is needed (§4).
- **Setup grows the steps Home Assistant's flows have:** asking again (a
  two-factor code), a page elsewhere (OAuth), signing in again when a
  password changes, changing a connection — all as data the app draws (§5).
- **Home Assistant's integrations come in two ways:** ported to TypeScript,
  for the ones that matter (a recipe and a map, §8), and run as they are,
  in a Home Assistant beside kraftverk, through a bridge integration (§9).
  Running their Python inside kraftverk is ruled out, with reasons. The
  bridge to Home Assistant is **not** part of the first work: kraftverk is
  built as its own thing first.
- **The order** (§12): what kraftverk already has is moved onto the model
  first — the packages become integrations, NIU gets its account, the Tuya
  Zigbee gateway becomes a bridge, signing in again and the "needs you" list
  work for them. Then discovery and the opened lists; then the first new
  integrations, iCloud and Apple TV.
- **Better than Home Assistant** where it counts: typed descriptions, no
  integration code doing its own I/O, every physical act through the
  gateway, a simulator and recorded fixtures for every integration, a
  quality level that is measured rather than reviewed, and integrations that
  cannot take the hub down with them (§10).

---

## 0. It runs where the home runs

The one difference from Home Assistant that everything else must keep:
**kraftverk runs whole on a phone or in a browser, with no server.** A home
can be the app alone; a server, when there is one, is a node that is always
on and reachable, not the place the code lives. So:

- **Every integration's code runs on every platform** — `system` (a machine,
  under Bun), `web` (a browser), `native` (a phone). It is pure: no platform
  built-in, held by the architecture check, and bundled for a browser by it.
  An integration that cannot is refused, however good it is.
- **What differs is what a way of reaching a device needs, and it is data.**
  Two declarations, kept apart:
  - **The platform it can run on** comes from its transport (and, for a
    cloud, whether that cloud answers a browser at all): `platforms`. A
    Bluetooth radio is on a phone and a server; a cloud without CORS headers
    is not reachable from a browser's page. A fact about software, never a
    choice.
  - **What the node holding it must be** is the method's `needs`, from the
    node's traits: `alwaysOn` (it must run while nobody looks), `reachable`,
    `trusted` (a vendor password may be kept on it). A choice about safety and
    usefulness, with the reason said.
  NIU's method today says `needs: { trusted: '… NIU's cloud does not answer a
  web page' }`, which mixes the two; the platform half moves to the method's
  platforms (step 5).
- **A phone is a temporary node.** It holds a way while the app is open. A
  method that only *works better* always on — iCloud fetching locations at
  night — does not need `alwaysOn`; it runs on the phone while it is open,
  and the catalogue says what an always-on node would add. Only what is
  useless or unsafe without it needs it.
- **The catalogue says, per integration, where it runs:** "on this phone",
  "in a browser", "needs a server" — worked out from its methods' platforms
  and needs, never written by hand. The add screen offers what this home's
  nodes can hold, and says what a server would make possible.
- **Nothing in this design is server-only by construction.** Setup's page
  elsewhere (OAuth) returns to whichever node runs the flow — a server's
  route, or the app's own link; containment (§6.2) has an implementation for
  every platform; a bridge's members are held wherever the bridge is, a phone
  included.

---

## 1. Integration, service, device: the words

The owner asked whether "service" and "integration" are the same thing.
**They are not**, and the difference is worth keeping.

**How Home Assistant uses the words** (developers.home-assistant.io, read
2026-10-06):

| Home Assistant says | It means |
|---|---|
| *integration* | The code: a folder `homeassistant/components/<domain>/` with a `manifest.json`. About 1,400 in core. |
| *config entry* | One instance of an integration: an account signed in, a hub paired. Holds `data`, `options`, a state machine. |
| *device* | A thing in the device registry, created by a config entry. |
| *entity* | One value or control of a device: `sensor.kitchen_temperature`. |
| *service* — three meanings | A callable `domain.name` (renamed *action* in 2024.8, still `hass.services` in code); `integration_type: service` (an integration for one online service, such as DuckDNS); and `DeviceEntryType.SERVICE` (a device that is really a web service). |

So in Home Assistant, "integration" is both the code and — loosely, on the
integrations page — the instances of it, and "service" is three unrelated
things. Its own developers list the confusion among its weaknesses.

**How kraftverk uses them today:** there is no integration and no account.
Code is a *device type package* (`packages/devices/*`, `packages/services/*`);
what a person adds is a *device*, and a *service* is a device type with
`kind: 'service'` — weather, electricity prices — "a device without
hardware" (ARCHITECTURE.md §1, goal 6). That last idea is right, and Home
Assistant arrived at the same place: a weather service is a device of type
"service" there too.

**What this design proposes:**

| Word | What it is | Kind of thing | Examples |
|---|---|---|---|
| **Integration** | A package that teaches kraftverk one **platform**: a vendor's system, a cloud, a standard — how things on it are reached, signed into and found, apart from any one product. | Code | `tuya`, `niu`, `sydpower`, `icloud`, `open-meteo`, `matter` |
| **Device package** | A package that teaches kraftverk one **product** or product family: what it is. Built on an integration. | Code | `aferiy-p280`, `atorch-s1w`, `niu-uqi-gt` |
| **Device type** | One kind of thing, declared by either: a product by a device package; the platform's own things — an account, a gateway, a service, the generic type for products nobody has described — by its integration. | Code | `aferiy.p280`, `niu.uqi-gt`; `niu.account`, `tuya.plug` |
| **Device** | One thing a person added, of a type. Kind *hardware*. | Instance | "Garage P280", "Living room Apple TV" |
| **Service** | A device without hardware, as today. Kind *service*. | Instance | "Weather here", "Electricity prices", "Phone notifications" |
| **Account** | A device that is a sign-in to someone's cloud. Kind *account*. New. | Instance | "Family iCloud", "NIU account" |
| **Bridge** | Not a kind: a role. A device through which other devices are reached — its *members*. Hardware, a service or an account may be one. | Role | A Hue bridge (hardware), an iCloud account, a Home Assistant (service) |

### Two kinds of package: the platform, and the product

The owner's distinction, and the right one: **logging in with NIU is the
integration; the UQi GT Sport is a device, in a package of its own, that
depends on the NIU integration.** A platform and a product change for
different reasons, are written by different people, and come in very
different numbers — a few hundred platforms, tens of thousands of products.

The layers, each talking only to the one beside it:

| Layer | Knows | Never knows | Examples |
|---|---|---|---|
| **Transport** | Moving bytes or messages, finding what is there | What they mean | `mqtt`, `ble`, `lan`, `https` |
| **Protocol** | A wire format: framing, encryption, message shapes. Pure | Any product or meaning | `sydpower`, `tuya-local`, `niu-cloud` |
| **Integration** | A platform: its ways in (connection methods, ready to use), their setup — signing in, fetching a key, pairing, instructions — its accounts and gateways, its services, the builder its products are made with, the generic type for a product nobody described, and how a thing found on it is matched to a product | Any one product | `sydpower`, `tuya`, `niu`, `open-meteo` |
| **Device package** | A product: its name and models, its layout (datapoints, registers, limits), its pictures, its screens, its own words and recipes, its quirks | How its platform is reached or signed into | `aferiy-p280`, `atorch-s1w`, `tuya-zigbee-plug`, `niu-uqi-gt` |

**The rules:**

- An integration names no product. A device package names the integration
  it is built on, and uses its builder and its ways in.
- The platform's own things are the integration's types: an **account**
  (`niu.account`), a **gateway** (`tuya.gateway`), a **service**
  (`open-meteo.weather` — a weather forecast is the platform's, not a
  product), and the **generic** type a product falls back to when no device
  package describes it (`tuya.plug`, `niu.scooter`): the floor. None of these
  is a product.
- A product is a device package's type: `aferiy.p280`, `niu.uqi-gt`,
  `atorch.s1w`. Mostly data on its integration's builder — the UQi GT is a
  name, its models and pictures over `defineNiuScooter`; the Zigbee plug a
  datapoint layout over `defineTuyaSocket`.
- When an account or a gateway finds something — a scooter on the account,
  a plug behind the gateway — its model is matched to the device package
  that claims it; with none, the integration's generic type takes it.
- Nothing about this is stored. The database knows devices and their types,
  wherever a type was declared; an account is a device (D3). Integrations
  and device packages are code.

**The code already splits this way.** Today's packages mix the two, but
their insides do not: `defineTuyaSocket` and `defineNiuScooter` are
platform builders that the product packages already use; the P280's two
ways in — Wi-Fi through the broker, Bluetooth — are how any Sydpower station
is reached. The division follows the seam that is there.

**Better than Home Assistant here.** Home Assistant has no product package:
everything a product is lives inside its integration, so its Tuya
integration carries every Tuya category's mapping, and adding a product
means changing the integration. Its Zigbee integration had to split product
knowledge out into a separate library of "quirks" for exactly this reason;
Homey's apps and drivers, and openHAB's bindings and thing types, are the
same split. Kraftverk has it from the start: a product is a small package,
mostly data, added without touching its platform — which is how a catalogue
grows to thousands.

**What a product reached two ways is.** A product a person can reach through
two platforms (a plug both by its vendor's local protocol and by Matter)
is one device package naming two integrations, one per way, and one device
with two connections. Not needed yet; the rules leave room for it.

Why not call integrations "services": a service is already something you
*add* — the weather here, the prices in your area — and notifications will be
services too (`notify.send`, PLAN-AUTOMATION-LANGUAGE.md). One integration
often brings several kinds of thing: iCloud brings an account, the phones
behind it, and could bring a calendar service. Calling the code a service
would make the word mean two things on the same screen, which is exactly
Home Assistant's mistake.

**Account, the word.** [ACCOUNTS.md](ACCOUNTS.md) uses *account* for a
person's account in kraftverk. A vendor's account is a different thing, and
on screen it is always qualified by whose ("your iCloud account", "the NIU
account") under *Accounts* in a home's devices, while a person's own is under
*You*. In code the kind is `'account'` and nothing else is called an account
but `users`. If the owner wants no overlap at all, *sign-in* is the
alternative (decision D2, §13).

**Retired words stay retired:** no *plugin*, *extension*, *adapter*,
*driver* or *provider* (ARCHITECTURE.md §2). *Integration* is not retired;
it is the word everyone who knows Home Assistant already has.

### 1.1 The model, simplified

Built as first written, steps 1–5 showed where the design was more than it
needed to be: a protocol package beside every integration, used by nothing
else; a scooter that heard its account through topics and JSON on a
pretend transport; an account shown among the devices. The owner's word,
2026-10-06: integrations are the one point where kraftverk meets a service
or third-party code; devices build on them; no publish/subscribe between
parts. So:

**Three kinds of package**, each talking only to the one beside it:

| Package | Is | Holds | Never knows |
|---|---|---|---|
| **Transport** — `packages/transports/<id>` | How this machine reaches anything: a radio, a socket, HTTPS, the broker. One implementation per platform | A channel to an address; finding what is there | What anything means |
| **Integration** — `packages/integrations/<id>` | The one place kraftverk meets a service or a vendor's system | The code that speaks to it — its **protocol**, in `src/protocol/`: framing, encryption, API calls, pure; its ways in and their setup; its **accounts** and **gateways**; its services; the generic type a device nobody described falls back to; its file migrations; **its own screens** — its page, an account's; and the **typed API** its devices are built with: builders, and the link a device behind an account reads | Any one product |
| **Device package** — `packages/devices/<id>` | One kind of device, on one integration | What it is: models, layout, pictures, **its device screens**, words, recipes, what only it does | How the service is reached or signed into |

**The rules:**

- A device package imports its integration and the SDK — nothing else, no
  protocol, no other integration. What it needs of the wire, its
  integration exports (`@kraftverk/integration-sydpower/protocol`).
- An integration imports the SDK, and the transports' contract only through
  it. Its protocols are declared in its manifest, each with an id that is
  the integration's or begins with it (`niu-cloud` is NIU's): what a
  connection and a device's identity name.
- When two integrations need the same wire code — Modbus, say — it becomes a
  library both import, which is not an integration. None does yet, so there
  is none.
- An **account** and a **gateway** are an integration's own types, never a
  device package's.

**Calls, not messages.** Between packages, between the core and an
integration, and between a bridge and the devices behind it, everything is a
typed function call on an interface the SDK or an integration declares:

- **A device behind a bridge reads it through a link** — an object of the
  integration's own, with plain methods (`report()`, `raw()`), handed to the
  device's session when it opens. When what the link reads has moved, the
  bridge calls the one function it was given; the session reads again and
  tells its holder, as any session does. No topics, no in-process value
  turned into bytes and back, no request faked as two messages (§4.3).
- **Where a device's own wire is publish/subscribe** — the P280 talks MQTT
  to the broker — it stays inside the transport and the integration that
  speaks it, behind calls: the station's link reads registers; nobody above
  it sees a topic.
- **Notification is one thing, with one shape:** the live stream — readings
  moved, health, a device's events, what changed — that the app and
  automations listen to. It tells; nothing asks or commands through it, and
  nothing waits on who else listens. The timeline is the log.

**Accounts belong to their integration.** Underneath, an account is held as
a device is — a record, a way in, its secrets, a node that holds it — so
§0's rules apply to it unchanged, and a device behind it is held wherever
it is. But a person meets it on its **integration's page**, not among the
devices: Integrations → NIU → "Olof's NIU account": sign in again, change
the password, the scooters on it. An integration may bring screens of its
own for that page (`kraftverk.integration.ui`). A device's page stays the
device's — the scooter's says "Through Olof's NIU account" and links there.
When the app has tabs — devices, the home, people, integrations — this is
already the division.

**Worked: iCloud, and a family member's phone on it.**

```
packages/integrations/icloud/          the integration
  src/protocol/      Apple's sign-in (SRP, two-factor) and the Find My service: pure, over https
  src/account.ts     icloud.account: kind account, a bridge — one fetch for every device on it
  src/link.ts        export interface FindMyLink extends MemberLink {
                       device(): FoundDevice;               // what Find My says of it now
                       playSound(): Promise<void>;
                     }
  src/device.ts      icloud.device: the generic device Find My knows
  ui/                its page: the account, signing in again, two-factor
packages/devices/icloud-family-phone/  a device on it
  src/type.ts        a family member's phone through icloud.account: where it is, its battery; play a sound
  ui/                its device screens
```

The device package writes `linkOf<FindMyLink>(ctx.connection)` and calls
it; it never sees a password, a token or an HTTP request.

---

## 2. What Home Assistant does, and what to take from it

In brief: the complete account is in the research notes this design
was made from, and the sources are listed at the end (§14).

**An integration** is a Python package with a `manifest.json`: `domain`,
`name`, `integration_type` (`device`, `hub`, `service`, `helper`, `virtual`,
…), `iot_class` (`local_push`, `local_polling`, `cloud_push`,
`cloud_polling`, `assumed_state`, `calculated`), `requirements` (pip
packages), `dependencies`, `codeowners`, `quality_scale`, and discovery
matchers — `zeroconf`, `ssdp`, `dhcp`, `bluetooth`, `usb`, `homekit`,
`mqtt`. A build step (`hassfest`) compiles every manifest's matchers into
generated tables, so Home Assistant knows all ~1,400 integrations, offers
them, and matches discoveries **without importing any of them**. Code is
imported only when an instance exists or a discovery is followed. Brands
group integrations (Apple: Apple TV, iCloud, HomeKit…); *virtual*
integrations name a brand served by another integration or a standard.

**A config entry** is one instance: `entry_id`, `domain`, `title`, `data`,
`options`, `unique_id`, `version`/`minor_version` (with
`async_migrate_entry`), `disabled_by`, `subentries` (2025: one account, many
locations), `runtime_data`, and a state machine — `not_loaded`,
`setup_in_progress`, `loaded`, `setup_error`, `setup_retry` (with backoff,
from `ConfigEntryNotReady`), `migration_error`, `failed_unload`.
`ConfigEntryAuthFailed` starts a **reauth** flow.

**A config flow** is code: a class with `async_step_<id>` methods, each
returning a form (voluptuous schema with *selectors*), a menu, an external
step (OAuth), a progress step, an abort, or `create_entry`. Reserved steps
handle discovery (`zeroconf`, `dhcp`, …), `reauth` and `reconfigure`; an
*options flow* edits options later. A `unique_id` set in the flow is what
stops the same device being added twice.

**Registries:** the device registry (`identifiers`, `connections` such as
MACs, manufacturer, model, versions, `via_device_id`, area) and the entity
registry (stable `unique_id`, user-renamable `entity_id`, `entity_category`,
`device_class`, disabled/hidden). In 2026 a device became owned by exactly
one config entry, and *child devices* arrived for logical parts of one
product — while `via_device_id` stays for separate products behind a hub.

**Entities** are of ~45 platforms (`sensor`, `switch`, `light`, `climate`,
`media_player`, `device_tracker`, `button`, `number`, `select`, `event`,
`update`, `notify`, …). State is a **string** of at most 255 characters,
with attributes as an untyped JSON bag. Sensors carry a `device_class`, a
`native_unit_of_measurement` and a `state_class`. Data comes through a
`DataUpdateCoordinator`: one fetch for many entities, with `UpdateFailed`,
backoff and `ConfigEntryAuthFailed`.

**Actions** (formerly services) are registered per domain with a schema and
may return a response. **Diagnostics** (redacted downloads), **repairs**
(issues a person can fix), **system health**, **translations**
(`strings.json`), **icons**, and a **quality scale** (bronze → platinum, about
50 rules, recorded per integration in `quality_scale.yaml`, reviewed by
people) round it off.

**Libraries:** Home Assistant requires protocol code to live in a separate
PyPI library (pyicloud, pyatv). All requirements are installed into **one**
Python environment, at run time for custom integrations.

### What to take

- **The manifest as data, compiled into tables.** This is how thousands are
  supported cheaply. Kraftverk already generates its installed list; it grows
  into a catalogue.
- **Discovery matchers declared, matched without code.**
- **The instance with a state machine:** retrying with backoff, needing a
  person to sign in again, failed — as states the core owns, not as each
  integration's reconnect loop.
- **Reauth, reconfigure and options** as first-class flows.
- **One fetch for many things** (the coordinator), and the **hub with
  devices behind it** (`via_device`).
- **Brands and virtual integrations** for finding things.
- **Diagnostics, repairs, translations, a quality scale.**
- **Protocol code apart from integration code** — kraftverk already has it,
  stricter (protocols are pure).

### What not to take

- **Stringly-typed state and attribute bags.** Kraftverk's values are typed,
  with units and meanings.
- **`entity_id` as identity**, renamable and breaking automations. Kraftverk
  addresses parts and attributes by stable keys.
- **Entity and device as two systems.** Kraftverk has devices with parts.
- **Integration code doing its own I/O.** Home Assistant integrations open
  sockets, run blocking calls on the event loop, and crash the core. Kraftverk
  integrations get channels.
- **One Python environment** with conflicting pins, installed from the
  internet at first start.
- **Config flows as code only.** They cannot be drawn ahead of time, tested
  as data or said in words.
- **A quality scale kept by review.** Kraftverk measures what it can.
- **The vocabulary confusion** (§1).

---

## 3. What kraftverk has, and what is missing

What is there, and good:

- **Three layers:** a transport moves bytes and finds devices; a protocol is
  pure code over a channel; a device type knows what values mean
  ([connection.ts](../packages/device-sdk/src/connection.ts)). A type cannot
  open a socket: it is handed a channel, and an HTTP channel reaches only its
  address and the origins the protocol names. This is the property everything
  in §6 rests on.
- **Connections apart from devices,** with failover across the nodes that
  hold them; a device *is* its identity.
- **Every physical act through the gateway,** checked, confirmed where it is
  consequential, verified and audited.
- **Descriptions as data:** parts, attributes with meanings and units,
  capabilities like Matter clusters, declared events.
- **Setup assembled from the layers,** drawn by the app from data
  ([setup.ts](../packages/device-sdk/src/setup.ts)).
- **A simulator for every type.**
- **Packages found by folder,** and the installed list generated for the app.

What is missing, found in this review:

1. **No account.** A NIU scooter's connection keeps the account and its
   password itself (`niu-cloud` credentials: `account`, `password`, `serial`),
   so two scooters keep two copies, sign in twice, and a changed password is
   changed twice. An iCloud account with five family phones cannot be
   modelled at all.
2. **No bridge.** The Tuya Zigbee plug is reached through a Tuya gateway by
   writing both into one address (`ip#cid`): two facts in one string.
3. **No platform apart from its products.** What every NIU scooter or Tuya
   socket shares — the builder, the generic type, the ways in — lives in one
   product's package that the others depend on (`niu-uqi-gt` on
   `niu-scooter`, `atorch-s1w` on `tuya-plug`); the P280's ways in are
   Sydpower's, written into the P280; services sit in a folder of their own
   for no reason the code needs.
4. **Setup cannot ask again.** No two-factor code after a password, no page
   elsewhere (OAuth), no "sign in again" for a device already added, no
   pairing PIN loop.
5. **Sessions cannot keep a token.** A session can write `device_kv`, which
   is not secret; a refresh token or a trust token has nowhere to go.
6. **Health has no "needs you".** A session that needs a person to sign in
   again looks like one that is offline.
7. **Discovery knows only what transports see by their own filters.** No
   mDNS, SSDP or DHCP matchers declared by packages.
8. **Everything installed is loaded.** Fine for eight packages, not for a
   thousand.
9. **Closed lists** — categories (5), quantities (15), link kinds, event
   levels, support levels — that a large catalogue outgrows
   (ARCHITECTURE.md step 32 already names this).
10. **Everything runs in the hub's process,** so packages must be trusted
    code from this repository (ARCHITECTURE.md §5).
11. **Poll or push is not declared,** so the add screen cannot say it.

---

## 4. The design, from the bottom

### 4.1 The database

Five changes, and one table for later. A schema change sets the database
aside, and the home comes back from its configuration (strict version 1).

**1. A connection may go through another device.** A member of a bridge is
reached through the bridge's session, on whichever node holds the bridge. Its
connection names the bridge instead of a transport and a holder:

```sql
CREATE TABLE device_connection (
  id                 TEXT PRIMARY KEY,
  device_id          TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  method             TEXT NOT NULL,
  /* Reached directly: by a transport, held by a node. */
  transport          TEXT,
  held_by            TEXT REFERENCES node (id) ON DELETE CASCADE,
  /* Or reached through a bridge: held wherever the bridge is. */
  through            TEXT REFERENCES device (id) ON DELETE CASCADE,
  /* The transport's address, or the member's key within its bridge. */
  address            TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  config             TEXT NOT NULL DEFAULT '{}',
  secrets_exportable INTEGER NOT NULL CHECK (secrets_exportable IN (0, 1)),
  created_at         TEXT NOT NULL,
  last_connected_at  TEXT,
  CHECK ((through IS NULL) = (transport IS NOT NULL AND held_by IS NOT NULL)),
  CHECK (through IS NULL OR through <> device_id)
);
CREATE UNIQUE INDEX device_connection_once ON device_connection (device_id, method, coalesce(held_by, through));
```

The nulls mean something: "not reached that way". A device can have both —
a phone found through iCloud, and later seen on the LAN — in one ordered list
of ways, with failover between them. That is the gain over Home Assistant,
where a device belongs to one config entry.

**2. Secrets a session writes.** `connection_secret` stays; a protocol
declares which of its secret fields a session may write (a token, a
session cookie, a trust token), and the session writes them through its
connection (§5.4). One column records whose they are:

```sql
CREATE TABLE connection_secret (
  connection_id TEXT NOT NULL REFERENCES device_connection (id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  value         TEXT NOT NULL,
  encrypted     INTEGER NOT NULL,
  /* Given by a person while setting it up, or kept by its session: a token. */
  source        TEXT NOT NULL CHECK (source IN ('person', 'session')),
  written_at    TEXT NOT NULL,
  PRIMARY KEY (connection_id, field)
);
```

**3. What a person chose not to add.** Discovery and bridges offer things;
"not this one" is remembered (Home Assistant's *ignore*):

```sql
CREATE TABLE sighting_ignored (
  /* A transport's id, or the bridge device's id. */
  source_kind TEXT NOT NULL CHECK (source_kind IN ('transport', 'bridge')),
  source      TEXT NOT NULL,
  key         TEXT NOT NULL,
  ignored_at  TEXT NOT NULL,
  PRIMARY KEY (source_kind, source, key)
);
```

**4. The device's kind gains `account`.** Kind is the type's, not stored.
Nothing in the schema changes for it; `device_kv`, history, events and links
work for an account as they do for any device.

**5. `audit.resource_kind` gains `integration`,** for an integration loaded,
refused, or (later) uploaded.

**Later: integrations from outside the repository** (§11):

```sql
CREATE TABLE integration_package (
  id          TEXT PRIMARY KEY,          -- its namespace: 'acme-heater'
  version     TEXT NOT NULL,
  sha256      TEXT NOT NULL,             -- of the bundle on disk
  origin      TEXT NOT NULL,             -- 'upload' | 'npm:<name>' | 'folder:<path>'
  contract    INTEGER NOT NULL,          -- the SDK contract it was built for
  trust       TEXT NOT NULL CHECK (trust IN ('contained', 'trusted')),
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  added_at    TEXT NOT NULL,
  added_by    TEXT NOT NULL
);
```

**What is not stored, on purpose:** the catalogue of integrations (it is
code, generated); health and the "needs you" list (live, recomputed by
sessions on every start); sightings and members not yet added (live).
Integrations in the repository need no row: being in the image is being
installed.

### 4.2 Integration packages and device packages

Two folders: `packages/integrations/<platform>/` and
`packages/devices/<product>/`. `packages/services/` goes: a service is the
platform's own type, so it is its integration's. Transports stay where they
are; a protocol is part of its integration (§1.1).

```
packages/integrations/niu/            the platform
  package.json        the manifest: data only (below)
  README.md           the four headings; how NIU is reached and signed into
  NOTICE              where anything was ported from, and those licences
  src/
    index.ts          the builder (defineNiuScooter), the ways in, setup
    protocol/         how NIU's cloud is spoken to: sign-in, the calls, pure
    link.ts           ScooterLink: what a scooter reads through its account
    account.ts        niu.account: kind account, a bridge (step 5)
    scooter.ts        niu.scooter: the generic scooter, the floor
  ui/                 the generic scooter's screens, which products reuse; the integration's page
  test/

packages/devices/niu-uqi-gt/          a product on it
  package.json        "kraftverk": { "device": { "integration": "niu", … } }
  README.md           what this model is, what is mapped of it
  src/type.ts         defineNiuScooter({ id: 'niu.uqi-gt', models, … })
  assets/             its pictures
  test/
```

**Manifests** are data, saying only what finding the code needs.
An integration's:

```jsonc
{
  "name": "@kraftverk/integration-niu",
  "kraftverk": {
    "integration": {
      "id": "niu",
      "name": "NIU",
      "types": [                                  // the platform's own: may be none
        { "id": "niu.account", "entry": "./src/account.ts" },
        { "id": "niu.scooter", "entry": "./src/scooter.ts", "ui": "./ui/index.ts" }
      ]
    }
  }
}
```

A device package's:

```jsonc
{
  "name": "@kraftverk/device-niu-uqi-gt",
  "kraftverk": {
    "device": {
      "integration": "niu",                       // the platform it is built on: a dependency by name
      "types": [
        { "id": "niu.uqi-gt", "entry": "./src/type.ts", "ui": "@kraftverk/integration-niu/ui", "images": ["./assets/image-1.png"] }
      ]
    }
  }
}
```

Everything else the catalogue says is **worked out from the code** when the
catalogue is generated, never written twice: each type's kind, category and
whether it is a bridge; each method's platforms, needs, reach, updates and
discovery matchers; and from those, where the integration runs (§0). The
catalogue is what is read without importing code — a thousand integrations
cost one generated JSON file — and a check holds it current, as the
generated registry is held today.

A **brand** is a small record of its own (`packages/brands/<id>.json`: name,
logo, the integrations that serve it, and the standards its products speak —
Matter, Zigbee). The add screen searches brands and products, so a person
looking for "Apple" finds iCloud, Apple TV and "Apple products that speak
Matter".

**Each type's entry** default-exports its `defineDeviceType` (or what its
integration's builder makes), as a type package's does today; what a type
brings to automations stays an entry beside it (`automation`). A type's id is
the manifest's — a check refuses a package where they differ — and is unique
among everything installed. An integration's own types begin with its id
(`niu.account`); a product's with its brand (`aferiy.p280`, `atorch.s1w`),
which may be the platform's when the vendor makes both (`niu.uqi-gt`).

**Today's packages, divided:**

| Today | Integration (the platform) | Device package (the product) |
|---|---|---|
| `devices/aferiy-p280` | `sydpower`: the Wi-Fi-through-the-broker and Bluetooth ways in, their setup | `aferiy-p280`: the P280 |
| `devices/tuya-plug` | `tuya`: the socket builder, the generic plug (`tuya.plug`), later the gateway | — |
| `devices/tuya-zigbee-plug` | — | `tuya-zigbee-plug`: the 16 A Zigbee plug, on `tuya` |
| `devices/atorch-s1w` | — | `atorch-s1w`, on `tuya` |
| `devices/niu-scooter` | `niu`: the scooter builder, the generic scooter and its screens, later the account | — |
| `devices/niu-uqi-gt` | — | `niu-uqi-gt`, on `niu` |
| `services/open-meteo` | `open-meteo`: the weather service and its recipes | — |
| `services/elprisetjustnu` | `elprisetjustnu`: the price service | — |

Every type id stays as it is, so no device, database row or configuration
file changes with the division.

### 4.3 The contract: accounts and bridges

**An account** is a device type with `kind: 'account'`. It has one method
(the cloud's API, held by a trusted node), credentials from its protocol,
an identity read at check time (the account's own id — never the email, which
can change), and a description like any device: what it reports about
itself (last fetched, how many members, quota) and what it can do.

**A bridge** is any type that declares `bridge` (as built, §1.1):

```ts
// device-sdk
export type BridgeSpec = {
  /** The type a member nobody claims becomes: the integration's generic one. */
  fallback?: string;
};

/** What a bridge's session offers the devices behind it. */
export interface Bridge<Link extends MemberLink = MemberLink> {
  /** Who is behind it now: live, never stored — each a sighting until a device claims it. Read again whenever its session says it changed. */
  members(): readonly Member[];
  /** A link to one member, for its session and its check: `changed` is called whenever what it reads has moved. */
  link(member: string, changed: () => void): Promise<Link>;
}

/** What every link has; the rest is the integration's own interface. */
export type MemberLink = { close(): void };

export type Member = { key: string; name: string | null; model: string | null; identity: string | null; typeId: string | null };
```

**A member's method** names a bridge instead of a transport and a protocol:

```ts
connections: [
  { id: 'account', label: 'Through your NIU account', through: ['niu.account'], reach: 'cloud' },
]
```

`ConnectionMethod` is a union — over a transport with a protocol, or
through a bridge — and so is `OpenConnection`: a channel, or a link. The
compiler makes every place that opens one handle both; `channelOf` and
`linkOf` narrow it for a type, with a sentence when it is the wrong one.

**How a member is held.** The holder that holds a bridge's active
connection opens the bridge's session, then each member's session with
`bridge.link(member.key, changed)`. If the bridge moves to another node, its members
move with it. If the bridge is down, its members are offline, and say why
("iCloud needs you to sign in again").

**One fetch for many.** A bridge session fetches once and each member reads
its part through its link: Home Assistant's coordinator, without a class to inherit. iCloud's
account fetches every device's location in one call, on an interval the
account works out (shorter while someone is moving, longer at home — the
logic of Home Assistant's `_determine_interval`, ported).

**Which nodes.** A bridge's method `needs` (trusted, always on) apply to its
members too: they are where it is.

### 4.4 Discovery

Each method declares what it is found by, as data beside its transport,
compiled into the catalogue:

```jsonc
"discovery": [
  { "via": "lan", "mdns": { "type": "_companion-link._tcp" } },
  { "via": "lan", "mdns": { "type": "_airplay._tcp", "txt": { "model": "AppleTV*" } } },
  { "via": "lan", "dhcp": { "hostname": "airgradient_*" } },
  { "via": "ble", "advert": { "manufacturerId": 2409 } },
  { "via": "lan", "ssdp": { "st": "urn:schemas-upnp-org:device:MediaRenderer:1" } }
]
```

A transport reports sightings with typed facts (an mDNS service and its TXT
records, a DHCP host name and MAC, a Bluetooth advert); the hub matches them
against the catalogue **without loading any integration**, then loads the
matching one and asks its protocol's `recognise` to confirm. One device
announcing many services (an Apple TV announces seven) is gathered by host
before it is offered. A found device not yet added is a "found" item for
the person (§7), unless ignored.

The `lan` transport gains an mDNS browser and an SSDP listener; DHCP
watching needs raw packets and comes last.

### 4.5 The closed lists

A catalogue of hundreds outgrows them. Decided in step 32 and made concrete
here:

| List | Becomes |
|---|---|
| `CATEGORIES` (5) | A reviewed taxonomy grown here toward Home Assistant's breadth: phone, media player, speaker, light, sensor, climate, lock, cover, vacuum, camera, vehicle, account, notifications… An integration names one per type. |
| `Quantity` (15) | A declared record — unit dimension, formatting, chart — kept in the SDK; adding one is a row. Position (latitude, longitude, accuracy) is the first new one. |
| Capabilities | The library grows by Matter's clusters: `mediaPlayback`, `contentLauncher`, `keypadInput`, `audioOutput` (volume), `location`, `notify`; a package may still declare its own, namespaced. |
| `SupportLevel` (3) | A level computed from the quality checklist (§10). |

### 4.6 Poll or push

`updates: 'push' | 'poll' | 'both'` on each method, beside `reach`, so the
add screen says "Updates arrive as they happen" or "Checked every few
minutes", as Home Assistant's `iot_class` does. Unlike Home Assistant it is
checked: a type that says `push` and schedules a poll faster than a minute
fails the package check.

---

## 5. Setting up, signing in again, and keeping a token

### 5.1 What setup has, and lacks

Setup is a plan of steps assembled from the layers — get it ready, find it,
credentials, the type's own steps, check, name, link — drawn by the app from
data, with **actions** inside steps that run where the connection will be
held. That is better than Home Assistant's code-only flows for drawing and
testing. It lacks the turns their flows can take.

### 5.2 Asking again, inside a step

An action's result may **ask** for more instead of finishing:

```ts
export type SetupActionResult =
  | { ok: true; detail: string; choices?: readonly SetupChoice[]; suggestedConfig?: ConfigValues }
  | { ok: false; detail: string }
  /** Not done: ask this, then run `action` with the answer. */
  | { ask: { title: string; detail?: string; schema: ConfigSchema; action: string; carry: ConfigValues } }
  /** Not done: a person does something elsewhere — scan, confirm on the device. Exists today as `waiting`. */
  | { waiting: SetupWaiting }
  /** Not done: open this page; the answer comes back to the server's callback. OAuth. */
  | { open: { url: string; detail: string; carry: ConfigValues } };
```

`carry` is what the next turn needs (Apple's session id), kept by the server
with the flow, never sent to the app when it holds a secret. Chained asks
give every branch Home Assistant's flows have, and the plan stays a straight
line of steps the app can draw as a progress bar:

- **iCloud:** credentials → *sign in* → `ask` "Apple sent a code to your
  devices" → *verify* → (legacy accounts) `ask` "which device should get the
  code?" first → choices of the family's devices.
- **Apple TV:** found → *pair* → for each protocol the TV supports, `ask`
  "Enter the code shown on the TV" → done.
- **OAuth** (a cloud with an app registration): `open` the vendor's page →
  the vendor returns to the node running the flow — a server's callback
  route, or the app's own link on a phone — and that completes the action → tokens are
  secrets with `source: 'session'`.

### 5.3 The same flow, again, for a device you have

A flow runs with a **purpose**: `add` (today), `sign-in` (the credentials
step and check, against an existing connection: Home Assistant's *reauth*),
or `change` (a connection's settings: *reconfigure*). A device's own
settings are edited on its page as today: Home Assistant's *options flow* is
not needed as a separate thing. Signing in again keeps the device, its
identity, history and automations; the check refuses a different identity
("this is a different Apple account").

### 5.4 Sessions that keep a token

`OpenConnection.secrets` gains `set(field, value)`, allowed only for fields
the protocol declares `kept: 'session'`. The holder seals and writes them
(`source: 'session'`). They travel in the configuration file like other
secrets — sealed, unless the owner made them exportable — so a reset of the
database does not force another two-factor code.

### 5.5 Sessions that need a person

A session's health gains states the core owns, instead of every integration
writing its own retry loop (as Home Assistant's Apple TV and iCloud do):

| State | Meaning | What the core does |
|---|---|---|
| `opening` | Starting | — |
| `ready` | Working | — |
| `retrying` | Could not reach it; tries again at a time it says | Backoff from 15 s to 5 min, with jitter; `retryAfter` from the session honoured (a rate limit) |
| `needs-person` | Cannot go on without someone: `sign-in`, `pair`, `update` (firmware too old), `confirm` | Stops trying; shows it in the "needs you" list (§7) with the flow that fixes it |
| `failed` | Something no person can fix here | Shows why; tries again on restart |
| `paused` | Turned off by its owner | Nothing |

A session says which by throwing typed errors from the SDK —
`NeedsSignIn`, `NotReachable({ retryAfter })` — the way Home Assistant's
`ConfigEntryAuthFailed` and `ConfigEntryNotReady` work, but for every kind of
device and in one place.

---

## 6. Running integrations: loading, and keeping them apart

### 6.1 Loading on demand

The catalogue is generated from manifests (`gen:devices` becomes
`gen:catalogue`): one JSON for the server and the app with every
integration's name, brands, types, kinds, categories, reach, updates, needs
and discovery matchers. The add screen and the integrations page read it.

An integration's code is imported when it is needed: a device of its types
exists, a discovery matched it, or a person starts adding one. The
registries (`DeviceTypeRegistry`, `ProtocolRegistry`) become lazy, with a
shared import per integration. The app's generated list becomes dynamic
imports; which integrations the app carries at all is a build choice, as
the app holds only what is near it (Bluetooth) and what runs in a browser.

### 6.2 Three ways an integration runs

| | In the hub's process | Contained | Beside kraftverk |
|---|---|---|---|
| **What** | Integrations in this repository | An integration from outside it | Home Assistant's own integrations, in Home Assistant |
| **Isolation** | None; reviewed code | A realm of its own — a WebAssembly engine, or the platform's worker — no built-ins, channels by message, limits on memory and time | A container |
| **Speaks** | The SDK, directly | The SDK, over messages | Home Assistant's WebSocket API, through the `home-assistant` integration |
| **When** | Today | Later | Later |

**Contained** is possible because of the seam kraftverk already has: a
type's code does no I/O of its own. It is handed channels, a clock, a store
and a logger. Every one of those can cross a process boundary as messages,
so running an integration in a realm of its own — with no `fetch`, no
file system, its channels opened by the hub and passed in, under a memory
limit and a watchdog — needs no change to the integration. The architecture
check that forbids built-ins in device code (`scripts/architecture.mjs`)
already enforces the rule that makes this work. Home Assistant cannot do
this: its integrations open their own sockets.

The sandbox is one port, `IntegrationSandbox`, and it has an
implementation on **every** platform, as everything else does (§0): a
phone-only home runs contained integrations too. So the choice (decision
D5) is between **QuickJS in WebAssembly** — the same everywhere, the
strongest isolation, slower, the engine the script step will use — and each
platform's own **worker** (a Bun worker, a Web Worker, a JavaScript context
on a phone), faster, with three implementations to keep honest. An operating
system's process alone is not enough: a phone has none to give. A crash or a hang takes down only the integration; the hub
marks its devices `failed` and starts it again with backoff.

---

## 7. In the app

- **Integrations** (Settings): every integration in the catalogue, searchable
  by brand and product; which are in use, with their devices; each with its
  reach, how it updates, its quality level, where it came from, and its
  README as its page.
- **Add:** the catalogue, not only installed types; brands first. "Found on
  your network" at the top: discovered devices, and members of your
  bridges not yet added.
- **An integration's page** (§1.1): reached from Integrations; its
  accounts, each with its state and what is on it ("Family iCloud — 5
  devices"), signing in again and changing a password there; its gateways;
  where it runs; the devices you have on it; and its own screens. Accounts
  are not listed among the devices on Home.
- **Needs you:** one list of what needs a person — sign in again, pair
  again, a found device, an update — each with the button that fixes it. The
  phone's notifications (ntfy, push) send the same items when they come.
- **A device behind a bridge** says so: "Through Family iCloud". Its page
  shows the way it is reached like any connection, with failover beside it.

---

## 8. Porting a Home Assistant integration

The short-term goal: point at an integration in
`home-assistant/core/homeassistant/components/` and have it ported to
TypeScript, as a kraftverk integration, in one sitting.

### 8.1 The map

| Home Assistant | Kraftverk |
|---|---|
| `components/<domain>/` | `packages/integrations/<id>/`, and a device package per product it knows by name |
| `manifest.json` | `package.json` → `kraftverk.integration` |
| a table of models or product keys inside the integration | device packages, each claiming its models |
| `integration_type: device / hub / service` | a type of kind hardware / an account or hardware type with `bridge` / a type of kind service |
| `iot_class` | `reach` + `updates` |
| `requirements` (a PyPI library) | the integration's **protocol** (`src/protocol/`), ported from the library: pure, over a channel. Or a maintained MIT TypeScript library, vendored, when one exists |
| discovery keys (`zeroconf`, `dhcp`, …) | `discovery` matchers + the protocol's `recognise` |
| `config_flow.py` `async_step_user` | the setup plan: the protocol's credentials, the method's steps |
| a two-factor or PIN step | an action that returns `ask` |
| OAuth / `application_credentials` | an action that returns `open` |
| `async_step_reauth` / `reconfigure` | the same plan run with purpose `sign-in` / `change` |
| options flow | the device's settings |
| `unique_id` | the device's identity (read at check) |
| `ConfigEntry.data` | connection config + connection secrets |
| `async_setup_entry` | `createSession` |
| `runtime_data` | the session object |
| `ConfigEntryNotReady` / `ConfigEntryAuthFailed` | `NotReachable` / `NeedsSignIn` |
| `DataUpdateCoordinator` | the session's `ctx.schedule`; for a hub, the bridge's one fetch |
| `DeviceInfo` (manufacturer, model, versions) | `DeviceInfo` |
| `via_device` | a connection `through` a bridge |
| child devices | parts |
| `SensorEntityDescription` list | attributes in the description: key, meaning, unit, state class |
| `device_class` + native unit | meaning + unit |
| `entity_category: diagnostic / config` | an attribute's presentation: diagnostic; a setting |
| `switch`, `light`, `media_player`, … platforms | capabilities |
| `button` | a command without arguments |
| `number` / `select` / `text` (config) | settings, written through the gateway |
| `event` entities, bus events | declared events |
| actions (`services.yaml`) | capability commands; with a response: queries |
| `diagnostics.py` | the diagnostics bundle (ARCHITECTURE.md step 32), redaction declared by `secret` fields |
| `strings.json` | words in the type; translations later |
| `quality_scale.yaml` | measured (§10) |
| tests with `MockConfigEntry` and mocks | simulator + recorded fixtures replayed |

### 8.2 The recipe

1. **Read** the manifest, `config_flow.py`, the coordinator, every platform
   file and `services.yaml`; and the library's client. Write down: what is
   signed into, what is found, what is fetched how often, every value and
   its unit, every command and what it changes.
2. **Protocol:** port the library's calls into the integration's pure protocol over
   the channel its transport gives (HTTPS for a cloud; TCP for a LAN
   device). No I/O of its own; secrets in, typed values out.
3. **Integration:** the platform's ways in, their setup, its accounts and
   gateways, its services, a builder for its products and the generic type
   for a product nobody described.
4. **Device packages:** one per product the Home Assistant integration knows
   by name or model, each mostly data on the builder. Values become
   attributes with standard meanings; controls become capabilities; anything
   that changes something physical declares its consequence; actions become
   commands or queries.
5. **Setup:** the flow's steps become the plan; two-factor and PIN steps
   become `ask`; the `unique_id` becomes the identity.
6. **Simulator** that behaves like the device, and **fixtures** recorded or
   written from the library's own tests.
7. **README** with the four headings, the device table, and what is not
   supported; **NOTICE** with the origin and licences.
8. **Checks:** typecheck, tests, the architecture check, the quality
   checklist.

### 8.3 Licences

Home Assistant's core is Apache-2.0: translating its integration code is a
derivative work — keep the licence, say in the files that they were changed,
keep attribution. Its libraries vary: pyicloud and pyatv are MIT (keep the
copyright notice), but some are GPL and must be checked before porting. The
package's `NOTICE` holds this, and `portedFrom` in the manifest says it as
data. Using a vendor's private web API is a question of its terms, not of
copyright; the README says so where it applies.

### 8.4 iCloud, worked through

- **What it gives:** the location and battery of every device in Find My
  for the account **and its Family Sharing members**; play a sound; lost
  mode. People's locations from Find My *Friends* are not on the web any more
  (removed by Apple in 2023): only family members' devices. With Advanced
  Data Protection, web access must be allowed on the account; Find My is
  expected to work, to be tested.
- **Protocol `icloud-web`** over `https` with Apple's sign-in hosts as
  `alsoOrigins`: SRP-6a sign-in (Apple moved to it in October 2024), two-factor
  by trusted device or SMS, the trust token kept by the session (`kept:
  'session'`), and the `findme` service. `icloudjs` (MIT, TypeScript) is the
  starting point, pyicloud the reference. Apple changes this several times a
  year; pyicloud's issue tracker is the early warning.
- **The integration `icloud`:** `icloud.account` (account, bridge; needs
  trusted; identity: Apple's account id) and `icloud.device`, the generic
  device Find My knows (hardware, through the account; parts `main`;
  attributes position, battery charge, charging, owner; commands
  `alert.playSound`, `findMy.lostMode` — consequential: it locks someone's
  phone). Not `alwaysOn`: on a phone alone it fetches while the app is open
  (§0).
- **Device packages, when wanted:** an iPhone, an iPad, AirPods — each its
  pictures and what only it reports, claiming its model names.
- **The interval:** shorter while a device moves away from home, longer at
  home or on low battery — ported from Home Assistant's `account.py`.
- **What it needs first:** bridges (steps 3-5), `ask` and kept tokens (steps 9-10), the
  `location` capability and a position quantity (step 14). Presence in
  automations — "when Alex's phone gets home" — follows from the position and
  the home's own location, already kept: `distance(phone.position, home) <
  200 m`. Places beyond the home wait on the owner's open decision about
  homes and places.

### 8.5 Apple TV, worked through

- **Protocols:** Companion (power, apps, keyboard), MRP tunnelled in AirPlay 2
  (now playing, playback), pairing by HAP (SRP with the PIN shown on the TV,
  then Ed25519/X25519 and ChaCha20-Poly1305). `node-appletv-remote` (MIT,
  TypeScript, no native code) already speaks these; it is vendored behind the
  integration's protocol rather than ported line by line from pyatv.
- **Transport:** `lan` with TCP and mDNS discovery (step 13).
- **The integration `apple-media`:** Apple's Companion, MRP and AirPlay
  ways in and their pairing — the platform an Apple TV and a HomePod share.
- **The device package `apple-tv`:** `apple-tv.tv`, hardware; discovered by `_companion-link._tcp` and
  `_airplay._tcp` with `model=AppleTV*`; capabilities `onOff`,
  `mediaPlayback`, `contentLauncher`, `keypadInput`, `audioOutput`; pairing
  credentials per protocol as connection secrets; push updates.
- **What it needs first:** `ask` (step 9), mDNS (step 13), the media capabilities
  (step 20).

### 8.6 A first port to prove the recipe

Before iCloud, a small integration that needs nothing new: a local or cloud
polling sensor with no account (Home Assistant's `airgradient`, rated
platinum, is the model of a clean one). It proves the map, the recipe and the
package shape in a day, and the owner chooses which one they have.

---

## 9. Running Home Assistant's integrations as they are

The owner asked whether kraftverk could execute Home Assistant integrations
in a sandbox. Researched, with this result:

| Way | Verdict |
|---|---|
| **A small Python `hass` imitation**, running one integration in a subprocess | **No.** An integration leans on config entries, flows, the entity platform, both registries, the dispatcher, storage, a shared HTTP session and zeroconf: thousands of lines to imitate, of an API that changes every month (about 50 developer-blog changes in 2026 so far; Python 3.14 required). The two projects that tried both ended up running real Home Assistant core. |
| **Python in WebAssembly** (Pyodide) | **No.** No UDP or multicast, experimental TCP in Node only, and not on Bun: no LAN integration could run. |
| **A real Home Assistant beside kraftverk**, without its UI, reached over its WebSocket API | **Yes,** as an integration of its own. Every one of its integrations works unchanged, and Home Assistant fixes them when vendors change things. |

**The `home-assistant` integration:**

- **Home Assistant** is a service-kind type and a bridge, reached over
  WebSocket with a long-lived token (the `https` transport gains a WebSocket
  channel). It runs in its own container, beside kraftverk's, with host
  networking for discovery and nothing else shared.
- **Its members** are Home Assistant's devices, each a generic
  self-describing type, `home-assistant.device`: entities become parts and
  attributes. A sensor with a device class and unit gets a meaning and a
  unit; `switch` and `light` become capabilities; `media_player` the media
  capabilities; `device_tracker` a position. What does not map is shown,
  read only — openHAB's binding for Home Assistant (2026) does the same.
- **Commands** go through kraftverk's gateway, with its checks and
  confirmation, and become `call_service`.
- **Adding one of its integrations from kraftverk:** the catalogue includes
  Home Assistant's integration list (its generated `integrations.json`),
  marked "through Home Assistant", offered when a home has one. Its config
  flow is driven over the REST flow API, and each step's schema — its
  selectors — is drawn as a kraftverk form. So adding "Airthings" in
  kraftverk runs Home Assistant's own flow, and the device arrives in
  kraftverk.
- **The other direction**, kraftverk's devices shown in Home Assistant by
  MQTT discovery, is step 31 of ARCHITECTURE.md, and stays.

This makes the honest promise: anything Home Assistant supports works in
kraftverk through Home Assistant, today; what matters to the owner is ported
and becomes first-class.

---

## 10. Better than Home Assistant — and at least as good

### Where kraftverk leads

| | Home Assistant | Kraftverk |
|---|---|---|
| Values | Strings of ≤255 characters; attributes an untyped bag | Typed values, units and meanings, checked |
| Identity | `entity_id`, renamable, breaking automations | Stable keys; a device is its identity |
| I/O | Each integration opens its own sockets, may block the loop | Channels handed in; HTTP held to declared origins |
| Isolation | Everything in one process and one Python environment | Reviewed code in the process; outside code contained; Home Assistant itself in a container |
| Physical acts | A service call does what it does | One gateway: checked, confirmed, verified, audited |
| Ways to a device | One config entry owns it | Several connections, across nodes and bridges, with failover |
| Setup | Code; cannot be drawn or tested as data | Data the app draws; actions where the connection is held |
| Without hardware | Mocks per test | A simulator for every type; recorded fixtures |
| Retrying | Each integration writes its own loop | The core's states and backoff |
| Quality | A scale kept by review | A checklist measured by `check:integrations` |
| The file | `.storage` JSON, not meant to be read | Every device, account and bridge in `kraftverk.yaml`, secrets sealed |
| Where it runs | One server | The same code in the server, a browser and a phone |

**The measured checklist** (each item a check, the level its sum):
it has a simulator; fixtures replay; every attribute has a meaning or is
diagnostic; every command declares what makes it consequential; every
secret is a `secret` field (so diagnostics redact it); setup is tested;
an integration with credentials supports signing in again; discovery is
declared where the device announces itself; reach and updates are declared
and agree with the code; the README has its headings and its device table.

### What kraftverk must match before it can say "as good"

Discovery (mDNS, SSDP, Bluetooth; DHCP later) with "found" items; signing
in again; changing a connection; OAuth; kept tokens; a "needs you" list;
diagnostics downloads; brands; per-integration pages; the coordinator's
one-fetch-for-many; hubs with devices behind them; ignoring a found device;
turning an integration's device off without removing it (`paused`);
translations, later. Each is in a phase below.

---

## 11. Integrations from elsewhere, later

Written down now so the first steps do not close the door:

- **The bundle:** one ESM file built by the SDK's own command, with its
  manifest, its hash, and the contract it was built for.
- **Installed** by upload or by a `kraftverk.packages.json` naming npm
  packages or folders (ARCHITECTURE.md step 32), into `integration_package`
  and a folder on the server's disk. Nothing is downloaded from a screen
  without the owner saying so.
- **Always contained** (§6.2): code from outside never runs in the hub's
  process. Its dependencies are bundled in; none are installed at run time.
- **Namespaces** are claimed: an uploaded integration cannot declare a type
  in a namespace the repository owns.
- **Contract versions:** the server says "written for contract 1, this is
  2" and offers what it can, the one place strict version 1 bends, as it does
  for the configuration file.

---

## 12. The order of work

Three rules shape it:

- **Kraftverk on its own first.** The bridge to Home Assistant (§9) is not
  part of this work. Kraftverk is built to be a hub that has integrations,
  not a front end to another hub.
- **What kraftverk has comes first.** Every existing package is moved onto
  the model — integrations, NIU's account, the Tuya gateway as a bridge,
  signing in again, "needs you" — before anything new is added. The new
  integrations then arrive on a model already proven by the old ones.
- **Each step is green and pushed**, as the automation language's were, and
  its documents are made true in the same step (ARCHITECTURE.md,
  DATA-MODEL.md, CONFIG.md, the package READMEs). The database resets where
  the schema changes; the configuration file gains a version where its shape
  changes, with a migration and a kept fixture, so the home kept on the
  server comes back after each.

### Part A — What kraftverk has, on the model

**Step 1 · Integrations and devices, two kinds of package.**
The manifests' types in the SDK (`kraftverk.integration`,
`kraftverk.device`). Today's eight packages divided as §4.2's table says:
five integrations — `sydpower`, `tuya`, `niu`, `open-meteo`,
`elprisetjustnu` — and four device packages — `aferiy-p280`, `atorch-s1w`,
`tuya-zigbee-plug`, `niu-uqi-gt` — each on its integration. The P280's ways
in move to `sydpower`; the Tuya and NIU builders and generic types are their
integrations'; `packages/services` goes. The hub installs integrations, each
with its own types and the device packages built on it, and knows which
platform every type is on. The server's discovery
(`server/src/platform/packages.ts`) and the generated lists read the
manifests; the architecture check holds the new rule — an integration names
no product and imports no device package; a device package imports its
integration, the SDK and the language — and the product-word ratchet with it;
`new-package` makes either. ADDING-A-DEVICE.md says how a platform and a
product get in. Type ids, protocols, transports, the database and the file do
not change.
*Done when* the same devices run as before, each of today's packages is on
one side of the line, and the checks hold the line.
**Done 2026-10-06.** The P280's ways in became `SYDPOWER_WAYS`; a product
speaks only protocols its integration depends on; the scaffolds make a
protocol, a platform and a product on it that pass every check as made.

**Step 2 · The catalogue and the integrations page.**
Brands as records; `gen:catalogue` in place of `gen:devices`, one catalogue
for the server and the app, listing platforms and products; `GET
/api/integrations`; an *Integrations* page in Settings — each platform, the
products known on it, its reach, where it runs (this phone, a browser, a
server: worked out from its methods, §0), the devices using it, its README
as its page.
*Done when* the page lists the five platforms, each with its products and the
devices that use them.
**Done 2026-10-06, simpler than written.** The platforms and where each type
runs (`source`, `placements`) came into the one list the add screen already
reads (`GET /api/device-types`), rather than a second endpoint; brands stay
each type's `meta.brand`, and a generated catalogue waits for loading on
demand (step 15), which is what needs it. A README shown in the app waits for
a way to ship text with the app.

**Step 3 · Bridges in the contract and the database.**
`kind: 'account'`; `BridgeSpec`, `BridgeSession` and `Member`; a connection
method reached by a transport or through a bridge, the compiler holding
every place that opens one to both; `device_connection.through` with its
checks; `sighting_ignored`; where a member is held worked out from where its
bridge is (`packages/store/src/holding.ts`). A bridge type's simulator brings
simulated members, as the contract requires a simulator of every type.
*Done when*, in the hub's tests, a simulated bridge's two members open
through it, go offline with it, and follow it to another node.
**Done 2026-10-06.** A member rides a transport of its own, `bridge`, which
is no package: its bridge's open session (`BridgeHost`) opens its channel,
and its protocol rides that by a binding, guarded, as over any transport. A
connection record is held by a node or goes through a bridge — a union the
compiler holds every reader to, and the schema each row. Sync opens in
rounds, so a member opens with its bridge in one pass. `sighting_ignored`
moved to step 4, where members are offered. *Since step 5½:* no channel
and no protocol through a bridge — the member's session links to it
(`Bridge.link`), and reads it by the integration's own calls.

**Step 4 · Bridges in the app and the API.**
Members not yet added are offered on the add screen ("Found through …");
adding one makes a connection through its bridge; one can be ignored; Home
gains an *Accounts* section; an account's page lists its members; a member's
page says how it is reached; removing a bridge says what becomes of its
members. The file gains `through:` on a connection: version 5, migrated from
4 (no entry changes), with a fixture.
*Done when* a simulated account and its members are added end to end, in the
app's tests on the fast clock.
**Done 2026-10-06, end to end in the hub's tests.** Setup through a bridge
reads a member over the bridge's session (a reach of its own beside hardware
and simulated); members are found near you, can be ignored and offered again
(`sighting_ignored`, named as a connection is: transport, bridge, address);
the file writes `through:` and imports a bridge before what goes through it.
The app's own run of it waits for a real account to add: step 5's NIU.

**Step 5 · NIU on an account.**
`niu.account`, the NIU integration's: kind account, a bridge; the account
and password asked once; its session signs in once, lists the scooters as
members and fetches each one's state. A scooter found is matched by its
model to the device package that claims it — the UQi GT's — or else is the
generic `niu.scooter`; both are reached through the account. The
protocol splits into signing in and listing, which the account speaks, and
a scooter's state and commands, which its members speak. NIU's cloud not
answering a browser becomes a fact of the method's platforms, apart from
what it needs of its node (§0). The file goes to version 6: a scooter that carries its own account becomes an account entry —
one per distinct account — and the scooter through it.
*Done when* two scooters on one account sign in once and keep one password,
and the configuration kept on the server comes back as an account with its
scooter.
**Done 2026-10-06, with three things learnt.** The kept file did hold a NIU
scooter, and a migration in the core would have named NIU; so an integration
may name its own file migrations (`FileMigration`, CONFIG.md), run after the
core's step, finding its entries by what is installed. A way may name the
platforms it can be held on (`platforms`), so "NIU's cloud answers no
browser" left the trust reason. And a way through a bridge carries no
credentials of its own: its setup has none, the file names none. One rule
now matches a reported model to a type, for the check and for members alike
(`coversModel`).

**Step 5½ · The model, simplified (§1.1).** Before anything new: each
protocol package moved into its integration, and device packages import
only their integration; bridges hand their members a typed link of calls,
and the NIU account's topics go; an integration's page in the app, with its
accounts — signed into again and changed there — and its own screens, and
accounts no longer listed among the devices.
**Done 2026-10-06.** Protocols live in `src/protocol/`, declared in the
manifest (`protocols`), each id the integration's or beginning with it; a
way speaks only its own integration's protocol, and a device package's only
import of the wire is `@kraftverk/integration-<id>/protocol`. A bridged way
names its bridges and nothing else; its session links with
`linkOf(connection, changed, why)`, the holder lets go of every link when
the device closes (`closingOnce`). NIU's scooter reads `ScooterLink`. The
app: Home → Integrations → an integration's page (accounts, its own page
piece, your devices on it, what it knows) → an account's page (its panel —
NIU's says how NIU is asked — what is through it, signing in again, rename
and remove); a device page of an account goes there. An integration ships
its screens by `kraftverk.integration.ui` (`IntegrationUi`: `page`,
`account`), bound into the app as `INTEGRATION_UI`. *Learnt:* a link's
callback can come before the session holds the link — a session reads it
once linked, and ignores a call before.

**Step 6 · The Tuya gateway as a bridge.**
`tuya.gateway`, the Tuya integration's: hardware, a bridge, reached by `tuya-local` over `lan` with
the gateway's own key; one connection to the gateway for all its Zigbee
plugs; its members are the sub-devices it reports, by their Zigbee address.
`tuya.zigbee-plug` is reached through it, and the `ip#cid` address goes. The
file goes to version 7: a Zigbee plug entry becomes a gateway entry — one per
gateway — and the plug through it. Tuya's Smart Life sign-in stays what it is:
used once, at setup, to fetch a key, and never kept (D8).
*Done when* two Zigbee plugs behind one gateway share one connection, and no
address in the code or the file holds two things.
**Done 2026-10-06**, on the simplified model (§1.1). `tuya.gateway` holds one
`TuyaLink` in gateway mode — each request names the device by its Zigbee
address, a push says which device it is of — and hands each plug a
`ZigbeeLink`. Its members are what it reports reachable and what has been
linked, kept in its store; a Zigbee device's identity is `zigbee:<address>`,
the same whichever integration reaches it. A socket type says its `ways`:
`tuya.plug` both, the Zigbee plug `gateway` only. The Smart Life sign-in
offers the gateway — with the key Tuya hands its plugs — never a plug
behind it. File version 7, by Tuya's migration. *Learnt:* a gateway says
nothing of a device it does not have, so silence about one device is told
apart from a gateway gone by a heartbeat before giving up the connection.

**Step 7 · Health the core owns.**
`NeedsSignIn` and `NotReachable({ retryAfter })` in the SDK; the states
`opening`, `ready`, `retrying`, `needs-person`, `failed` and `paused`; backoff
in the holder, from 15 s to 5 min with jitter; a member takes its bridge's
state, and says why. A device can be paused by its owner without being
removed (`device.paused_at`). NIU says `NeedsSignIn` when its password is
refused and `NotReachable` when it is rate-limited; Tuya says `NotReachable`.
*Done when* a refused NIU password shows "needs you to sign in" on the
account and on its scooters, and nothing retries it in a loop.
**Done 2026-10-06**, kept close to what was there: the health statuses gain
`needs-you` and `paused` beside `connected`, `connecting`, `offline`, `unconfigured` and
`error` (a rename to the plan's six bought nothing). `NeedsSignIn` and
`NotReachable(retryAfterMs)` in the SDK; the holder never tries what needs
you until a person acts — a deliberate close, as giving its secrets anew
does, clears it — tries what said when then, and the rest on 15 s → 5 min
with a fifth of jitter. A member through a bridge that needs you, or is
paused, says so as its own. `device.paused_at`, paused and resumed from a
device's (or an account's) page, kept in the file (version 8). NIU's
refused password is never tried again by its client; 429 is `NotReachable`.
Tuya's wrong key is `needs-you`.

**Step 8 · The "needs you" list.**
One list from the hub: connections that need a person, and members of a
bridge not yet added. Served by the API, shown on Home with a count, each
item opening what fixes it.
*Done when* a refused NIU password and a new scooter on the account both
appear in it, each with its button.
**Done 2026-10-06.** `needsYou()` (`GET /needs-you`): each device or account
whose own health is `needs-you` — a member that only takes it from its
bridge is not listed again — and each device found behind a bridge of yours.
Home shows what to act on first ("Needs you"), each row opening the page
that fixes it — an account's under its integration — and what is found
stays under "Found near you", beside it.

**Step 9 · Setup that asks again, and runs again.**
Actions that answer `ask`, with what the next turn needs (`carry`) kept by
the server; flows with a purpose — `add`, `sign-in` or `change` — run
against a connection already saved, refusing a different identity; the app
draws an ask as a form inside its step. NIU signs in again from "needs
you"; a Tuya plug paired again in the vendor's app, whose key has changed,
fetches its new key the same way.
*Done when* a changed NIU password is fixed without removing anything, and a
re-paired Tuya plug gets its new key the same way.
**Done 2026-10-07.** An action may answer `ask: { schema, carry }`: the app
draws the form inside the step and runs the action again with what is
given; `carry` stays in the draft for that one next turn and never reaches
the app. `setup.again({ deviceId, connectionId })` sets one of a device's
own ways up again — its credentials and the way's own steps, never finding
it again, then a check that refuses a device answering as another — and
saving changes that way and nothing else: secrets given anew, the device
closed on purpose (what it waited on forgotten) and opened with them. The
app: "Sign in again" on an account's page, "Set … up again" on a device's
connection, both the add flow's own steps.

**Step 10 · Secrets a session keeps.**
Fields a protocol declares `kept: 'session'`; `secrets.set` on the open
connection; `connection_secret.source` and `written_at`; carried sealed in the
file. NIU keeps its sign-in token for as long as NIU honours it.
*Done when* restarting the server does not make NIU sign in again.
**Done 2026-10-07.** A secret field may say `kept: 'session'`: never asked
(`personFields` leaves it out of every form), refused from a person
(`checkSecretFields`), written by the session through
`connection.secrets.set` — any other field is refused there — and kept with
`connection_secret.source = 'session'` and `written_at`. What a person gave
alone decides a reopen, so a renewed token reopens nothing. The check step
keeps what it signs in with in the draft, saved as the session's; the file
carries it sealed, and an import keeps it as the session's, never asking
for it. NIU keeps its tokens as `session`, starts from them, and forgets
them when its password is refused.

**Step 11 · Quality measured, updates declared.**
`updates` (push, poll, both) on each method, checked against the code;
`check:integrations` runs the checklist (§10) over every integration and
writes its level into its README; `SupportLevel` is computed from it. The
six are brought up to what they can reach.
*Done when* every integration has a measured level, and the add screen
states how far each reaches and how it updates.
**Done 2026-10-07.** Every way declares `updates` (`push`, `poll`, `both`) beside
`reach`, validated; the add screen says both in words (`waySaid`).
`npm run check:integrations` measures each integration and the device
packages on it — the contract with its simulator, meanings, secrets, ways,
discovery declared where a device announces itself, tests, its READMEs — and
writes "Quality, measured" into its README; the architecture check fails a
README that says other than what is measured. `meta.support` stays its
author's word: a check cannot say a device was in someone's hands. "Agree
with the code" for `updates` is not measured yet.

### Part B — Ready for new integrations

**Step 12 · Discovery by declaration.**
Sightings carry typed facts; methods declare matchers, compiled into the
catalogue; the hub matches sightings without loading an integration, and
gathers one device's many announcements by host; a found device is a "needs
you" item until added or ignored. Tuya's own broadcast discovery moves onto
it.
*Done when* a Tuya plug on the network is offered as found without anyone
opening the add screen.

**Step 13 · mDNS and SSDP.**
An mDNS browser and an SSDP listener in the `lan` transport, on Bun, checked
in the container on the server — host networking or a reflector, decided
then.
*Done when* a device that announces itself by mDNS is found.

**Step 14 · The lists opened.**
Categories grown toward Home Assistant's breadth; quantities as records, with
position the first new one; the `location` capability; `distance` in the
automation language, measured from the home's location.

**Step 15 · Code loaded on demand.**
Lazy registries in the server, dynamic imports in the app.
*Done when* the server starts without importing an integration no device
uses.

**Step 16 · The porting guide, and a first port.**
`docs/PORTING-FROM-HOME-ASSISTANT.md`, a current document: §8's map, recipe
and licences, kept true. Then a small integration the owner has (D7), ported
by it, to prove it.

### Part C — The first new integrations

**Step 17 · iCloud's protocol.** SRP sign-in, two-factor by `ask`, the trust
token kept, Find My with the family's devices; tested against recorded
exchanges with made-up data.

**Step 18 · iCloud's account and devices.** `icloud.account` as a bridge,
`icloud.device` as its members: position, battery, play a sound, lost mode
(consequential), and the interval that shortens while someone moves.
*Done when* the family's devices are on their pages, and an automation
starts when a phone gets home.

**Step 19 · Apple TV's protocol and pairing.** The maintained library behind a
protocol package; pairing by `ask`, protocol by protocol; its credentials
kept.

**Step 20 · Apple TV as a device.** Found by mDNS; on and off,
playback, apps, the remote's keys, volume; updates pushed.
*Done when* an automation pauses an Apple TV, through the gateway.

OAuth (`open`, §5.2) is built with the first integration that needs it.

### Later, not in this work

- **Contained integrations and uploads** (§6.2, §11): they matter when code
  comes from outside the repository.
- **Home Assistant beside kraftverk** (§9).
- **Translations.**

---

## 13. Decisions for the owner

Before step 1:

- **D1. Integration and service are different words** (§1): *integration*
  for the code, *service* for a device without hardware. Recommended.
- **D2. The vendor's account is "account"**, qualified on screen, beside a
  person's account in kraftverk; or *sign-in*. Recommended: account.
- **D3. An account is a device** (of kind `account`), not a table of its
  own. Recommended: it gets connections, secrets, holders, health,
  history and automations for free, and Home Assistant's own move to "one
  device, one owner, children for parts, via for hubs" is the same shape.
- **D4. Two kinds of package** (the owner's, §1): an integration per
  platform in `packages/integrations/<id>`, a device package per product in
  `packages/devices/<product>` built on one; `services/` folded into the
  integrations whose services they are. Decided.

Later:

- **D5. How contained integrations are contained:** QuickJS in
  WebAssembly, or each platform's own worker — on every platform either way
  (§0). Measured, when that work starts.
- **D6. Home Assistant beside kraftverk:** run and updated by the
  deployment, as a container kraftverk connects to. Kraftverk does not
  supervise containers itself. Recommended, when that work starts.
- **D7. The first port** (step 16): which small integration the owner has,
  to prove the recipe before iCloud.
- **D8. Tuya keeps no account.** The Smart Life sign-in fetches a key at
  setup, and again when a plug is paired anew (step 9), and is not kept.
  Keeping it would let kraftverk fetch a changed key by itself, at the price
  of keeping a vendor password. Recommended: not kept.
- **Open, and not decided here:** people and places — who a phone belongs
  to, and places other than the home — wait on the decision about homes and
  places already open. Presence at home works without it.

---

## 14. Sources

Home Assistant developer documentation, read 2026-10-06:
[manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/),
[config entries](https://developers.home-assistant.io/docs/config_entries_index/),
[config flows](https://developers.home-assistant.io/docs/config_entries_config_flow_handler),
[data entry flows](https://developers.home-assistant.io/docs/data_entry_flow_index),
[setup failures](https://developers.home-assistant.io/docs/integration_setup_failures),
[fetching data](https://developers.home-assistant.io/docs/integration_fetching_data),
[device registry](https://developers.home-assistant.io/docs/device_registry_index/),
[entity registry](https://developers.home-assistant.io/docs/entity_registry_index/),
[entities](https://developers.home-assistant.io/docs/core/entity/),
[actions](https://developers.home-assistant.io/docs/dev_101_services/),
[the library rule](https://developers.home-assistant.io/docs/api_lib_index),
[brands](https://developers.home-assistant.io/docs/creating_integration_brand),
[quality scale](https://developers.home-assistant.io/docs/core/integration-quality-scale/),
[WebSocket API](https://developers.home-assistant.io/docs/api/websocket/);
the developer blog on
[one config entry per device](https://developers.home-assistant.io/blog/2026/07/21/device-registry-single-config-entry/)
and [child devices](https://developers.home-assistant.io/blog/2026/08/19/device-registry-websocket-api-changes/).
Core source, `dev` branch: `homeassistant/loader.py`, `config_entries.py`,
`components/icloud`, `components/apple_tv`, `components/airgradient`.

On running integrations outside Home Assistant:
[hass-remote-integration](https://github.com/trailro/hass-remote-integration),
[openHAB's Home Assistant binding](https://github.com/openhab/openhab-addons/pull/21752),
[home-assistant-js-websocket](https://github.com/home-assistant/home-assistant-js-websocket),
[Pyodide 314](https://blog.pyodide.org/posts/314-release/).

On iCloud and Apple TV:
[pyicloud](https://github.com/timlaing/pyicloud),
[icloud.js](https://github.com/foxt/icloud.js),
[the SRP change](https://github.com/home-assistant/core/issues/128830),
[pyatv's protocols](https://pyatv.dev/documentation/protocols/),
[node-appletv-remote](https://github.com/energee/node-appletv-remote).
