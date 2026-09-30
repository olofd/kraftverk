# Adding a device

How support for a new product gets into kraftverk. The architecture this
follows is [`ARCHITECTURE.md`](ARCHITECTURE.md); the data model and the add
flow a person walks through are [`DATA-MODEL.md`](DATA-MODEL.md). This is the
practical part.

A device is supported by up to three packages, one per layer:

| Layer | Folder | What it knows | Example |
| --- | --- | --- | --- |
| **Transport** | `packages/transports/` | How to move bytes or messages to a device, and find devices. One implementation per place it runs: `server`, `web`, `native` | `ble`, `lan`, `mqtt`, `https` |
| **Protocol** | `packages/protocols/` | What the bytes mean: framing, crypto, discovery packets, credentials, the one guard nobody may get around. Pure: no I/O | `sydpower`, `tuya-local` |
| **Device type** | `packages/devices/`, `packages/services/` | What the product is: its category, its description — parts, attributes, events — and how it is reached: its protocol over a transport | `aferiy-p280`, `atorch-s1w` |

Most new products need only a device type: a Tuya plug with a different data
layout is a profile on the generic Tuya socket, a new Sydpower station is a
type over the existing protocol. A new protocol comes with a family of
products, and a new transport is rare.

## Start

```bash
npm run new:device -- acme-plug
npm install
npm test --workspace @kraftverk/device-acme-plug
```

That package already keeps the device-type contract, as a simulator, and the
server finds it at start with no other change. `npm run new:protocol` and
`npm run new:transport` do the same for the other two layers.

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
   (`power.in.ac`, `grid.present`, `temperature.air`) or one of your own
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
   hardware. Tests use it, and so does "try without hardware".
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

**A picture** of the device makes it recognisable in lists and on its page.
Put a PNG on a transparent background in `assets/` — at most 1024 px square
and 512 KB; `npm run gen:devices` refuses anything larger, or opaque — and
name it in `package.json` under `kraftverk.assets.image` and `exports`. The
app draws it small beside the name in lists, and large on the device's own
page. It stands for every device of the type, so it is shown only where the
type is known: a device found on the network that might be one of several
types gets no picture.

### What it brings to automations

A device's package decides what automations can do with it
([AUTOMATIONS.md](AUTOMATIONS.md)). Three things, all optional:

- **Events** in its description — `{ id: 'mains.lost', part: 'input.ac', level:
  'warn' }` — raised with `ctx.event(id, data, part)` when they happen, never
  on the first reading. A trigger can wait for them.
- **Recipes**, under `automation.recipes`: rules with roles and settings left
  open, as data (`defineRecipe`), for what only your devices make possible.
  A recipe that needs nothing but library capabilities and standard meanings
  — "when a battery runs low", "charge between two levels" — belongs in the
  shared vocabulary (`device-sdk/src/recipes.ts`), where every device that
  offers them gets it. Give it a `sentence`; the check makes sure it names
  only roles and settings.
- **Functions**, under `automation.functions` (`defineFunction`), for what a
  comparison cannot say: "does tomorrow look sunny". Typed arguments and
  result, the capability it needs, and an answer of `null` — with why — when
  it cannot tell. The only package code an automation runs; it answers, it
  never acts: it is handed a reader of the part — its readings, its health,
  and its queries answered in their declared types (`ask`) — and nothing
  that can command, write or run a tool.

Ids are namespaced by your type: `acme.plug.overheating`. The contract check
validates every recipe as a rule; the server checks it again against every
installed package's functions when it starts.

## Rules the check enforces

`npm run check:architecture` runs in CI and fails on:

- a device type importing a transport, the server or the app — it is handed
  an open connection;
- a protocol, or a device type's `src/`, importing a Node or Bun built-in —
  both run in the app too;
- a transport importing anything from kraftverk but the SDK, or its web or
  native entry reaching its server one;
- the core naming a product.

A family may build on another device type by its package name — the ATORCH
S1W is the Tuya socket with a profile.

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
