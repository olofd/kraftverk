# Integrations: what they are, and how kraftverk does them

A design, 2026-10-06, from the bottom up: the words first, then the database,
then the code's contract, the runtime, the app, the configuration file, and
how Home Assistant's integrations are brought in — by porting them, and by
running them. It ends with the order of work and the decisions left to the
owner.

It builds on what is there ([ARCHITECTURE.md](ARCHITECTURE.md) §1–§4,
[DATA-MODEL.md](DATA-MODEL.md)) and changes it where this says so. Nothing
here is built yet.

**In one screen:**

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
- **An integration is one package with a manifest that is data.** Thousands
  can be supported and listed without loading one line of their code;
  discovery matches their manifests, and code is loaded when it is needed
  (§4).
- **Setup grows the steps Home Assistant's flows have:** asking again (a
  two-factor code), a page elsewhere (OAuth), signing in again when a
  password changes, changing a connection — all as data the app draws (§5).
- **Home Assistant's integrations come in two ways:** ported to TypeScript,
  for the ones that matter (a recipe and a map, §8), and run as they are,
  in a Home Assistant beside kraftverk, through a bridge integration (§9).
  Running their Python inside kraftverk is ruled out, with reasons.
- **Better than Home Assistant** where it counts: typed descriptions, no
  integration code doing its own I/O, every physical act through the
  gateway, a simulator and recorded fixtures for every integration, a
  quality level that is measured rather than reviewed, and integrations that
  cannot take the hub down with them (§10).

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
| **Integration** | An installed package that teaches kraftverk one product, family, cloud or standard. What contributors write; what the integrations page lists. It declares one or more device types. | Code | `icloud`, `apple-tv`, `tuya`, `aferiy`, `open-meteo`, `home-assistant` |
| **Device type** | One kind of thing an integration knows, as today. | Code | `icloud.account`, `apple.device`, `tuya.plug` |
| **Device** | One thing a person added, of a type. Kind *hardware*. | Instance | "Garage P280", "Living room Apple TV" |
| **Service** | A device without hardware, as today. Kind *service*. | Instance | "Weather here", "Electricity prices", "Phone notifications" |
| **Account** | A device that is a sign-in to someone's cloud. Kind *account*. New. | Instance | "Family iCloud", "NIU account" |
| **Bridge** | Not a kind: a role. A device through which other devices are reached — its *members*. Hardware, a service or an account may be one. | Role | A Hue bridge (hardware), an iCloud account, a Home Assistant (service) |

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
3. **No unit above the type.** A product family is several packages
   (`niu-scooter`, `niu-uqi-gt`); devices and services sit in two folders
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

### 4.2 The integration package

One folder, `packages/integrations/<id>/`, replacing `packages/devices/*`
and `packages/services/*`. Protocols and transports stay where they are:
they are shared by many integrations.

```
packages/integrations/icloud/
  package.json        the manifest: data only (below)
  README.md           the four headings, then what it supports and how
  NOTICE              where it was ported from, and those licences
  src/
    account.ts        defineDeviceType: icloud.account (kind account, a bridge)
    device.ts         defineDeviceType: apple.device (kind hardware, a member)
    index.ts          export default defineIntegration({ types: [...] })
  ui/                 pictures; screens of its own, rarely
  test/
    fixtures/         recorded exchanges, replayed in tests
```

**The manifest** is the `kraftverk.integration` section of `package.json`. It is
**data**, read without importing code, so the catalogue of a thousand
integrations costs a JSON file:

```jsonc
{
  "name": "@kraftverk/integration-icloud",
  "kraftverk": {
    "integration": {
      "id": "icloud",                       // the namespace: every type id begins with it, or with a brand it claims
      "name": "iCloud",
      "brands": ["apple"],
      "contract": 1,                        // the SDK contract it is written for
      "entry": "./src/index.ts",
      "types": [                            // what the catalogue shows before loading
        { "id": "icloud.account", "kind": "account", "category": "account", "bridge": true },
        { "id": "apple.device", "kind": "hardware", "category": "phone", "through": ["icloud.account"] }
      ],
      "reach": "cloud",                     // the most it needs: local | cloud-at-setup | cloud
      "updates": "poll",                    // push | poll | both: said on the add screen
      "needs": { "trusted": "your Apple account password stays at home", "alwaysOn": "family locations are fetched while nobody looks" },
      "discovery": [],                      // matchers: see 4.4
      "protocols": ["icloud-web"],
      "portedFrom": { "homeAssistant": "icloud", "at": "2026.10", "library": "pyicloud 2.6.5" },
      "docs": "README.md"
    }
  }
}
```

A **brand** is a small record of its own (`packages/brands/<id>.json`: name,
logo, the integrations that serve it, and the standards its products speak —
Matter, Zigbee). The add screen searches brands and products, so a person
looking for "Apple" finds iCloud, Apple TV and "Apple products that speak
Matter".

**Several types, one integration.** `tuya` holds `tuya.plug`,
`tuya.zigbee-plug` and `tuya.gateway`; `niu` holds `niu.account` and
`niu.scooter` with the UQi GT as a profile; `aferiy` holds `aferiy.p280`.
An integration may refine another's type (step 30's `refines`), so `atorch`
stays an integration of its own that refines `tuya.plug`.

**The code's entry** exports `defineIntegration({ types, functions,
recipes })`: what the type packages export today, gathered, plus the
automation contributions that already live beside them. The generated
lists, and checks that the manifest's `types` match the code's, keep the two
honest.

### 4.3 The contract: accounts and bridges

**An account** is a device type with `kind: 'account'`. It has one method
(the cloud's API, held by a trusted node), credentials from its protocol,
an identity read at check time (the account's own id — never the email, which
can change), and a description like any device: what it reports about
itself (last fetched, how many members, quota) and what it can do.

**A bridge** is any type that declares `bridge`:

```ts
// device-sdk
export type BridgeSpec = {
  /** What its members are spoken to in: a protocol package's id. */
  protocol: string;
  /** Which member types it can bring, for the add screen. */
  members: readonly string[];
  /** Whether new members are added without asking, unless a person chose otherwise. Default: ask. */
  addNew?: 'ask' | 'automatically';
};

export type BridgeSession = DeviceSession & {
  /** Who is behind it, now: live, never stored. Each becomes a sighting until a device claims it. */
  members(): readonly Member[];
  watchMembers(listener: (members: readonly Member[]) => void): () => void;
  /** A channel to one member, for its session. */
  open(member: string): MessageChannel;
};

export type Member = {
  /** Its key within this bridge: stable as long as the bridge says it is. */
  key: string;
  /** The type it should be added as, when the bridge knows. */
  type: string;
  name?: string;
  /** Its permanent id, when the bridge knows it: what makes it one device with another way to it. */
  identity?: string;
  detail?: string;
};
```

**A member's method** names a bridge instead of a transport:

```ts
connections: [
  { id: 'icloud', label: 'Through iCloud', protocol: 'icloud-findmy', through: ['icloud.account'], reach: 'cloud' },
]
```

`ConnectionMethod` becomes a union — reached by a transport, or reached
through a bridge — and every place that opens a connection handles both
(the compiler makes sure).

**How a member is held.** The holder that holds a bridge's active
connection opens the bridge's session, then each member's session over
`bridge.open(member.key)`. If the bridge moves to another node, its members
move with it. If the bridge is down, its members are offline, and say why
("iCloud needs you to sign in again").

**One fetch for many.** A bridge session fetches once and sends each member
its part: Home Assistant's coordinator, without a class to inherit. iCloud's
account fetches every device's location in one call, on an interval the
account works out (shorter while someone is moving, longer at home — the
logic of Home Assistant's `_determine_interval`, ported).

**Which nodes.** A bridge's method `needs` (trusted, always on) apply to its
members too: they are where it is.

### 4.4 Discovery

Each method declares what it is found by, as data in the manifest, compiled
into the catalogue:

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

`updates: 'push' | 'poll' | 'both'` in the manifest, beside `reach`, so the
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
  the server's `/api/setup/callback` completes the action → tokens are
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
| **Isolation** | None; reviewed code | Its own process, no built-ins, channels by message, limits on memory and time | A container |
| **Speaks** | The SDK, directly | The SDK, over messages | Home Assistant's WebSocket API, through the `home-assistant` integration |
| **When** | Today | Phase I7 | Phase I8 |

**Contained** is possible because of the seam kraftverk already has: a
type's code does no I/O of its own. It is handed channels, a clock, a store
and a logger. Every one of those can cross a process boundary as messages,
so running an integration in a separate Bun process — with no `fetch`,
no file system, its channels opened by the hub and passed in, under a memory
limit and a watchdog — needs no change to the integration. The architecture
check that forbids built-ins in device code (`scripts/architecture.mjs`)
already enforces the rule that makes this work. Home Assistant cannot do
this: its integrations open their own sockets.

The sandbox is one port, `IntegrationSandbox`, with two implementations
to choose between when it is built (decision D5): a **process** (fast,
with the operating system's confinement around it) or **QuickJS in
WebAssembly** (the strongest isolation, slower; the same engine the script
step will use). A crash or a hang takes down only the integration; the hub
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
- **Accounts** on Home: each account with its members ("Family iCloud — 5
  devices") and its state.
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
| `components/<domain>/` | `packages/integrations/<id>/` |
| `manifest.json` | `package.json` → `kraftverk.integration` |
| `integration_type: device / hub / service` | a type of kind hardware / an account or hardware type with `bridge` / a type of kind service |
| `iot_class` | `reach` + `updates` |
| `requirements` (a PyPI library) | a **protocol package** (`packages/protocols/<id>`), ported from the library: pure, over a channel. Or a maintained MIT TypeScript library, vendored, when one exists |
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
| `diagnostics.py` | the diagnostics bundle (step 32), redaction declared by `secret` fields |
| `strings.json` | words in the type; translations later |
| `quality_scale.yaml` | measured (§10) |
| tests with `MockConfigEntry` and mocks | simulator + recorded fixtures replayed |

### 8.2 The recipe

1. **Read** the manifest, `config_flow.py`, the coordinator, every platform
   file and `services.yaml`; and the library's client. Write down: what is
   signed into, what is found, what is fetched how often, every value and
   its unit, every command and what it changes.
2. **Protocol:** port the library's calls into a pure protocol package over
   the channel its transport gives (HTTPS for a cloud; TCP for a LAN
   device). No I/O of its own; secrets in, typed values out.
3. **Types:** one per kind of thing. Values become attributes with standard
   meanings; controls become capabilities; anything that changes something
   physical declares its consequence; actions become commands or queries.
4. **Setup:** the flow's steps become the plan; two-factor and PIN steps
   become `ask`; the `unique_id` becomes the identity.
5. **Simulator** that behaves like the device, and **fixtures** recorded or
   written from the library's own tests.
6. **README** with the four headings, the device table, and what is not
   supported; **NOTICE** with the origin and licences.
7. **Checks:** typecheck, tests, the architecture check, the quality
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
- **Types:** `icloud.account` (account, bridge; needs trusted and always on;
  identity: Apple's account id); `apple.device` (hardware, through the
  account; parts `main`; attributes position, battery charge, charging,
  owner; commands `alert.playSound`, `findMy.lostMode` — consequential: it
  locks someone's phone).
- **The interval:** shorter while a device moves away from home, longer at
  home or on low battery — ported from Home Assistant's `account.py`.
- **What it needs first:** bridges (I2), `ask` and kept tokens (I3), the
  `location` capability and a position quantity (I5). Presence in
  automations — "when Alex's phone gets home" — follows from the position and
  the home's own location, already kept: `distance(phone.position, home) <
  200 m`. Places beyond the home wait on the owner's open decision about
  homes and places.

### 8.5 Apple TV, worked through

- **Protocols:** Companion (power, apps, keyboard), MRP tunnelled in AirPlay 2
  (now playing, playback), pairing by HAP (SRP with the PIN shown on the TV,
  then Ed25519/X25519 and ChaCha20-Poly1305). `node-appletv-remote` (MIT,
  TypeScript, no native code) already speaks these; it is vendored behind a
  protocol package rather than ported line by line from pyatv.
- **Transport:** `lan` with TCP and mDNS discovery (I4).
- **Type `apple.tv`:** hardware; discovered by `_companion-link._tcp` and
  `_airplay._tcp` with `model=AppleTV*`; capabilities `onOff`,
  `mediaPlayback`, `contentLauncher`, `keypadInput`, `audioOutput`; pairing
  credentials per protocol as connection secrets; push updates.
- **What it needs first:** `ask` (I3), mDNS (I4), the media capabilities
  (I5).

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

Each phase is one or more green steps, pushed, as the automation language
was. The database resets where the schema changes; the configuration file
gains a version where its shape does, with a migration and a kept fixture.

| Phase | What | Done when |
|---|---|---|
| **I1 · Integrations as packages** | `packages/integrations/<id>` replaces `devices/` and `services/`; the manifest; several types per integration; brands; `gen:catalogue`; the architecture check's areas renamed; ARCHITECTURE.md, DATA-MODEL.md and ADDING-A-DEVICE.md (becoming ADDING-AN-INTEGRATION.md) changed with it; the integrations page | Every existing package is an integration; the integrations page lists them |
| **I2 · Accounts and bridges** | `kind: 'account'`; `BridgeSpec` and `BridgeSession`; connections `through` a bridge; members as sightings; `sighting_ignored`; NIU becomes `niu.account` + `niu.scooter` (one password); the Tuya gateway a bridge (no more `ip#cid`); configuration file version 5 with `through:`, migrating NIU and Tuya Zigbee entries | Two NIU scooters share one account; a Zigbee plug is reached through its gateway |
| **I3 · Setup and health that need a person** | `ask` and `open` results; flows with a purpose (`sign-in`, `change`); kept secrets; the core's health states and backoff; `NeedsSignIn` / `NotReachable`; the "needs you" list | A changed NIU password is fixed from "needs you" without removing anything |
| **I4 · Discovery** | mDNS and SSDP in `lan`; matchers in manifests; matching from the catalogue; gathering by host; "found" items | A device on the LAN that announces itself is offered without being searched for |
| **I5 · The lists opened, code loaded on demand** | Categories grown; quantities as records (position first); capabilities: `location`, `mediaPlayback`, `contentLauncher`, `keypadInput`, `audioOutput`, `notify`; lazy registries; `updates` declared and checked | The add screen offers a type whose code is not yet loaded |
| **I6 · The first ports** | A small polling integration (the recipe); then iCloud; then Apple TV | Family devices' positions in kraftverk; an Apple TV paused from an automation |
| **I7 · Contained integrations, then uploads** | `IntegrationSandbox`; an integration run in its own process; crash and hang handling; then `integration_package`, upload, namespaces, contract versions | A deliberately crashing integration does not take the hub down; an uploaded one runs contained |
| **I8 · Home Assistant beside kraftverk** | The `home-assistant` integration; entities mapped; commands through the gateway; Home Assistant's flows drawn in kraftverk; its catalogue "through Home Assistant" | An integration kraftverk has not ported is added from kraftverk's add screen and switched by an automation |

I1 to I3 come first because every port that signs in needs them. The owner
can point at a Home Assistant integration from I1 on: one without an account
ports straight away; one with an account waits for I2–I3.

---

## 13. Decisions for the owner

- **D1. Integration and service are different words** (§1): *integration*
  for the code, *service* for a device without hardware. Recommended.
- **D2. The vendor's account is "account"**, qualified on screen, beside a
  person's account in kraftverk; or *sign-in*. Recommended: account.
- **D3. An account is a device** (of kind `account`), not a table of its
  own. Recommended: it gets connections, secrets, holders, health,
  history and automations for free, and Home Assistant's own move to "one
  device, one owner, children for parts, via for hubs" is the same shape.
- **D4. One folder per integration**, `packages/integrations/<id>`, with
  several types in it, replacing `devices/` and `services/`. Recommended.
- **D5. How contained integrations are contained** (I7): a separate process,
  or QuickJS in WebAssembly. To decide when I7 starts, measured.
- **D6. Home Assistant beside kraftverk** (I8): run and updated by the
  deployment, as a container kraftverk connects to. Kraftverk does not
  supervise containers itself. Recommended.
- **D7. The first port** (I6): which small integration the owner has, to prove the
  recipe before iCloud.
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
