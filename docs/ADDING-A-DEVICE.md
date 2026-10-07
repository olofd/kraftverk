# Adding a device

How support for a new product gets into kraftverk. The architecture this
follows is [`ARCHITECTURE.md`](ARCHITECTURE.md); the data model and the add
flow a person walks through are [`DATA-MODEL.md`](DATA-MODEL.md). This is the
practical part.

A device is supported by up to three packages, one per layer
([PLAN-INTEGRATIONS.md](PLAN-INTEGRATIONS.md) §1.1):

| Layer | Folder | What it knows | Example |
| --- | --- | --- | --- |
| **Transport** | `packages/transports/` | How to move bytes or messages to a device, and find devices. One implementation per place it runs: `server`, `web`, `native` | `ble`, `lan`, `mqtt`, `https` |
| **Integration** | `packages/integrations/` | The one place kraftverk meets a service or platform: **its protocol** in `src/protocol/` — what the bytes mean: framing, crypto, discovery packets, credentials, the one guard nobody may get around; pure, the SDK only — how things on it are reached and set up; its accounts and gateways and their screens; the builder and typed API its devices are made with; its services, and the generic type a device nobody described falls back to. Names no product | `sydpower`, `tuya`, `niu`, `open-meteo` |
| **Device package** | `packages/devices/` | A kind of device on an integration: its category, its description — parts, attributes, events — its models, pictures and device screens. Imports its integration and the SDK, nothing else | `aferiy-p280`, `atorch-s1w`, `niu-uqi-gt` |

Most new products need only a device package: a Tuya plug with a different
data layout is a profile on Tuya's socket, a new Sydpower station a product
reached the Sydpower ways. A new platform or service comes with an
integration, its protocol inside it, and a new transport is rare. A service with no product
behind it, such as a weather forecast, is its integration's own type.

## Start

A product on a platform kraftverk knows:

```bash
npm run new:device -- acme-plug tuya
npm install
npm test --workspace @kraftverk/device-acme-plug
```

A product on a platform it does not, from the bottom:

```bash
npm run new:integration -- acme
npm run new:device -- acme-plug acme
npm install
```

Each package already keeps its contract — a device package as a simulator,
reached its integration's ways — and the server finds it at start with no
other change. `npm run new:transport` does the same for the last layer.

## Make it true

Work through `src/type.ts` in this order:

1. **What it is.** `meta`: its name, brand, the models it covers as the device
   reports them, and its **category** — one of the fixed list in
   `device-sdk/src/categories.ts` (Power stations, Smart plugs, Weather…). The
   category decides where the add screen lists it and nothing else; what your
   product is, your own `meta.description` says. Set `support` honestly:
   *experimental* until it has run against real hardware.
2. **What it is made of.** `describe(config)` returns its description
   (`device-sdk/src/description.ts`): its **parts** — `main`, and whatever it
   has several of, such as outlets, inputs, battery packs — each of a
   **kind** from the curated list (`outlet`, `input`, `battery`, `sensor`…,
   or one of your own, namespaced, with an icon) and, where it has one, its
   place in the flow of energy (`energy: { role: 'load' }`). Then their
   **attributes**: a key — what history is kept under, beginning with its part
   when it is not on `main` (`outlet.ac.on`, `pack.1.soc`) — a value type
   (number with unit and precision, boolean, enum, string, timestamp, or a
   list or object of values), a standard **meaning** where one applies
   (`mainsInput`, `mainsPresent`, `temperature`) or one of your own
   namespaced by the type, a quantity and state class for numbers, how long a
   value stays **current** when it is not two minutes (`currentFor`: a
   forecast fetched every half hour says an hour), and a category: `primary`
   leads the card, `diagnostic` stays off it. Settings are attributes with
   `access: 'write'`, grouped by `section`, and `dangerous` when a wrong value
   damages the hardware. If the device decides what it has — a pack plugged in
   — the session reports its own description.
3. **What it offers.** A part offers a read-only capability from the library
   (`device-sdk/src/capabilities.ts`: `powerMeter`, `battery`, `acInput`) when
   its attributes carry the meanings it needs, and one that takes commands or
   answers queries (`switch`, `weather.forecast`) when the part lists it in
   `offers`. Automations, the gateway and the bridges then use it without
   knowing the product; what makes a command consequential — worth a
   person's "yes" — is the capability's declaration, never your code. When the
   library has nothing for what your device does, declare a capability of
   your own in its description (`capabilities`), namespaced by your type
   (`acme.plug.childLock`), in the library's shape: the gateway and the app
   treat it like any other, and it can be promoted to the library — borrowing
   a Matter cluster's meaning where one exists — once a second device needs it.
4. **How it is reached.** `connections`: one method per (protocol, transport)
   pair, with a label people understand — "Wi-Fi", "Bluetooth" — and what it
   **reaches** beyond the home network: `local`, `cloud-at-setup` (a key
   fetched from the vendor's cloud once) or `cloud`. Never say where it runs:
   a method is offered wherever its transport is available, on the server and
   in the app alike. Its setup is assembled from its layers —
   the binding's instructions, the transport's way of finding it, the
   protocol's credentials — plus any steps of the type's own.
5. **Who it is.** `identify(connection)` reads the device once: its permanent
   identity, namespaced by protocol (`tuya-local:bf8dc9aa`), its model, and a
   sentence for the check step. It is how the same device is recognised
   however it is found, and how a removed one gets its history back.
6. **The session.** `createSession(ctx)` gets an open connection and returns a
   `DeviceSession`: `readings()` — every attribute, settings included —
   `command({ part, capability, command, args })`, `write(patch)` for
   settings, `query(…)` for data that is not a value now — answered in the
   type its capability declares — and the `tools` it can run. Each reading
   carries when the device **observed** it, never the time the value is
   about: a forecast for 14:00 fetched at 09:30 was observed at 09:30. Reads
   are synchronous — the session polls its own device with `ctx.schedule` —
   so nothing waits on a device that stopped answering. `ctx.event(id, data)`
   raises an event the description declares.
   **Tools** — a register dump, a raw frame — are declared on the type as
   data (`tools`): what each asks for, what it answers in the value system,
   and whether it writes. Whoever holds the device checks the input before a
   tool runs and the answer after; the app can draw any of them.
7. **The simulator.** `createSimulator(ctx)` keeps the same contract with no
   hardware. Tests use it, and so does "try without hardware". It keeps the
   home's time — `ctx.clock` for what it stamps and whatever changes with
   time, `ctx.schedule` for its steps — so a test on a fast clock lives a day
   of it in seconds. What it can be set up with is the type's `simulation`
   fields, chosen when a simulated one is added (`ctx.simulation.config`);
   `ctx.simulation.fed(part)` says whether a simulated switch that feeds one
   of its parts gives it power now.
8. **Tests.** `test/contract.test.ts` runs `checkDeviceTypeContract`; pass it
   fake connections from `@kraftverk/device-sdk/testing` (`fakeByteChannel`,
   `fakeMessageChannel`) to check `identify` against scripted bytes.

Screens are optional. A device with none gets the generic pages — a card,
where its energy comes from and goes (from its parts' energy roles and its
links), controls from the commands its parts take, a card and a page for each
part, settings from its writable attributes, history, what it said happened,
what it is (its `DeviceInfo`), and its tools drawn from their declarations —
and that is the outcome the model is for. Draw from its readings: whatever a
screen shows must be a declared attribute, so history, automations and every
other screen see the same.

When it draws something better, fill a **slot** rather than a page
(`DeviceUi` in `@kraftverk/api-client`): `dashboard` (the top of the
dashboard; history and events stay the app's), `parts` (one part's card, by
its id or kind), `settings`, and `tools` (a workbench above the declared
tools). Add a `ui/` folder whose default export `satisfies DeviceUi`, name it
in `package.json` under `kraftverk.ui` and `exports`, and run
`npm run gen:devices`. Compose it from the kit in `@kraftverk/ui` —
`PartCard`, `ReadingRow`, `EnergyFlow`, `EventList`, `InfoCard`,
`ToolPanel`, `SchemaForm` — which takes model types only. A piece gets
`DeviceScreenProps`: the device, actions that reach whoever holds its
connection, and whether they reach it now (`reach`). It never learns whether
that is the server or the app.

**Pictures** of the device make it recognisable in lists and on its page.
Put PNGs on a transparent background in `assets/`, named `image-1.png`,
`image-2.png`… — each at most 1024 px square and 512 KB; `npm run gen:devices`
refuses anything larger, or opaque — and list them, in order, in
`package.json` under `kraftverk.assets.images`, and in `exports`. The first is
shown unless a device's owner picks another in its settings; one is plenty.
The app draws it small beside the name in lists, and large on the device's
own page. A type's first picture stands for it where no device is chosen yet —
the add screen — and only where the type is known: a device found on the
network that might be one of several types gets none.

**A model on a platform** — one NIU among NIU scooters, one Tuya socket among
Tuya sockets — is a device package of its own, built with its integration's
builder (`defineNiuScooter`, `defineTuyaSocket`): its name, the model names it
reports (the check step offers it for a device reporting one), its pictures,
and what only it does. It inherits the rest. The integration's generic type
claims no model.

### What it brings to automations

A device's package decides what automations can do with it
([AUTOMATIONS.md](AUTOMATIONS.md); the language is
[`@kraftverk/automation`](../packages/automation/README.md)). Three things,
all optional. Recipes and functions are the package's own entry beside its
type — `"types": [{ "id": "acme.plug", "entry": "./src/type.ts",
"automation": "./src/automation.ts" }]` in its manifest — whose default export is
`defineContribution({ recipes, functions })` from `@kraftverk/automation`;
the device contract itself knows nothing of automations.

- **Events** in its description — `{ id: 'mains.lost', part: 'input.ac', level:
  'warn' }` — raised with `ctx.event(id, data, part)` when they happen, never
  on the first reading. A trigger can wait for them.
- **Recipes**, in its contribution: rules with roles and settings left
  open, as data (`defineRecipe`), for what only your devices make possible.
  A recipe that needs nothing but library capabilities and standard meanings
  — "when a battery runs low", "charge between two levels" — belongs in the
  shared vocabulary (`packages/automation/src/recipes.ts`), where every device that
  offers them gets it. Give it a `sentence`; the check makes sure it names
  only roles and settings.
- **Functions**, in its contribution (`defineFunction`), for what a
  comparison cannot say: "does tomorrow look sunny". Typed arguments and
  result, the capability it needs, and an answer of `null` — with why — when
  it cannot tell. The only package code an automation runs; it answers, it
  never acts: it is handed a reader of the part — its readings, its health,
  and its queries answered in their declared types (`ask`) — and nothing
  that can command, write or run a tool.

Ids are namespaced by your type: `acme.plug.overheating`. Installing the
package checks the contribution (`checkContribution`): every recipe as a rule,
against the functions it brings; the server checks it again against every
installed package's functions when it starts.

## Rules the check enforces

`npm run check:architecture` runs in CI and fails on:

- an integration or a device package importing a transport, the server or
  the app — each is handed an open connection;
- an integration importing a device package or another integration — a
  platform names no product;
- a device package importing another device package, an integration it is
  not built on, or a protocol its integration is not built on;
- a protocol, or an integration's or a device package's `src/`, importing a
  Node or Bun built-in — all run in the app too;
- a transport importing anything from kraftverk but the SDK, or its web or
  native entry reaching its server one;
- the core naming a product;
- an integration or a device package importing more of the core than the
  SDK and the automation language;
- a package without a README that says, under these headings, what it is,
  what it does and does not, where it fits, and why it is a package of its
  own: `## What it is`, `## What it does — and does not`,
  `## Where it fits`, `## Why a package of its own`. The `new:` scripts
  write them for you to fill in; what you find mapping the device goes
  below them.

A device package builds on its integration by the integration's package
name — the ATORCH S1W is Tuya's socket with a profile — and never on another
device package.

## How good it is, measured

Every way says how far it reaches (`reach`) and how what it says arrives
(`updates`: `push`, `poll` or `both`); the add screen says both in words.
`npm run check:integrations` measures an integration and the device
packages on it against the checklist (docs/PLAN-INTEGRATIONS.md §10) and
writes what it found into the integration's README, under "Quality,
measured": run it after a change, and commit what it writes — the checks
fail a README that is not current.

## Found by what it announces

A way over a transport says what it is found by, as data — its
`discovery` matchers — and its protocol's `recognise` confirms and reads
what a matcher picked out:

```ts
{ id: 'lan', protocol: 'acme', transport: 'lan', reach: 'local', updates: 'push',
  discovery: [{ kind: 'broadcast', port: 6667 }] }
```

A matcher is one announcement: `broadcast` (a UDP port), `advert` (a
Bluetooth service, a name — `ACME*` for a prefix — or a company id),
`client` (a broker client's protocol), `mdns` (a service type, with TXT
records that say the model) or `ssdp` (a search target). A transport says
which it hears (`finds`), and the checks refuse a way that declares one its
transport does not. Each sighting is one host with everything it said, so
`recognise` reads it with `heardAs(sighting, 'broadcast')` and returns the
device's identity when the announcement carries it — then a device that is
yours already is not offered again when its address changes. Where watching
costs nothing — the home network, the broker — what turns up is offered on
Home without anyone asking.

## An account, and a device behind it

When a service is signed into once and brings many devices — an iCloud
account and the family's phones, a NIU account and its scooters — the
integration writes the account, and a device package writes the device
(docs/PLAN-INTEGRATIONS.md §1.1). They talk by calls, never messages:

1. **The integration declares the link** (`src/link.ts`): what a device
   behind the account reads and asks, as plain methods.

   ```ts
   export interface ScooterLink extends MemberLink {
     vehicle(): NiuVehicle;
     report(): ScooterReport | null;
     raw(): Promise<ScooterRaw>;
   }
   ```

2. **The account is a bridge**: `kind: 'account'`, `bridge: { fallback }`,
   and a session whose `bridge` lists its members and hands each a link —
   `link(key, changed)` — calling `changed()` whenever what that link reads
   has moved. It signs in once, fetches once for all of them, and keeps the
   password; nothing behind it ever sees one.
3. **The device's way names the account** instead of a protocol and a
   transport: `{ id: 'account', label: 'Through your NIU account', through:
   ['niu.account'], reach: 'cloud' }`.
4. **Its session links and reads**:

   ```ts
   const scooter = await linkOf<ScooterLink>(ctx.connection, () => ctx.changed(), 'Reached through its NIU account');
   // readings() reads scooter.report(); close() calls scooter.close()
   ```

   Its `identify` links the same way. The device package imports the link
   type from its integration, and nothing else.

`@kraftverk/integration-niu` is the working example; `bridgedConnection`
in `@kraftverk/device-sdk/testing` opens a device through a bridge in a test.

## When a way changes

The configuration file carries a home across every database reset
([CONFIG.md](CONFIG.md)), so a change to how a type is reached — a way it no
longer has, a way that goes through an account now — must read a file kept
before it. The integration says how: a `FileMigration` in the module its
manifest names (`"migrations": "./src/migrations.ts"`), from the file's
version before the change, finding its entries by what is installed — the
types reached through its account — never by naming a product. The NIU
integration's is the example, with its test. The migration raises the
file's version, and with it the database's fingerprint: a home kept in an
older database is set aside and brought in again through its file, so the
migration is what carries every home over — none keeps the old way.

## Safety

- **Every command goes through the action gateway.** A session carries out
  commands addressed to its parts; it never switches anything on its own
  initiative. The gateway decides whether it may, and verifies it happened by
  reading back what the command sets.
- **Honour `ctx.readOnly`.** Refuse every write while it is set.
- **A frame that can damage hardware is the protocol's `guard`'s business.**
  The Sydpower guard refuses register 68 = 0 for every holder and at the
  broker. If your protocol has such a frame, refuse it there, once.
- **Settings that can damage hardware** are marked `dangerous`, and their
  value type must not allow the value that does it.
- **No third-party runtime dependencies** without a review: a package runs
  inside the server with everything it can do.

## Before you open a pull request

- `npm test`, `npm run typecheck` and `npm run check:architecture` pass.
- `npm run gen:devices -- --check` passes, if it has screens.
- Its `support` level is honest, with a `supportNote` saying why.
- What was verified on real hardware is written down, as
  [`P280-FINDINGS.md`](P280-FINDINGS.md) and [`ATORCH-S1W.md`](ATORCH-S1W.md) do.
