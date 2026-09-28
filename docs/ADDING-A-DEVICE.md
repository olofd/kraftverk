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
| **Device type** | `packages/devices/`, `packages/services/` | What the product is: its category, capabilities, telemetry, settings, and how it is reached — its protocol over a transport | `aferiy-p280`, `atorch-s1w` |

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
   category decides where the add screen lists it and nothing else. Set
   `support` honestly: *experimental* until it has run against real hardware.
2. **What it offers.** `capabilities` from the standard library
   (`device-sdk/src/capabilities.ts`): `switch`, `powerMeter`, `battery`,
   `outlets`, `acInput`, `weather.forecast`. Each needs the telemetry the
   contract names — `switch` needs `switch.on` — so automations and the
   gateway can use it without knowing the product. A capability that is not in
   the library is a reviewed addition there, not something a type invents.
3. **What it measures.** `telemetry`: your keys, each with a standard `metric`
   id where one applies (`power.in.ac`, `grid.present`), and a unit and kind.
   History is recorded for all of them.
4. **How it is reached.** `connections`: one method per (protocol, transport)
   pair, with a label people understand — "Wi-Fi", "Bluetooth". Never say
   where it runs: a method is offered wherever its transport is available, on
   the server and in the app alike. Its setup is assembled from its layers —
   the binding's instructions, the transport's way of finding it, the
   protocol's credentials — plus any steps of the type's own.
5. **Who it is.** `identify(connection)` reads the device once: its permanent
   identity, namespaced by protocol (`tuya-local:bf8dc9aa`), its model, and a
   sentence for the check step. It is how the same device is recognised
   however it is found, and how a removed one gets its history back.
6. **The session.** `createSession(ctx)` gets an open connection and returns a
   `DeviceSession`: readings, capabilities, settings, and any `advanced` tools
   (a register dump). Reads are synchronous — the session polls its own device
   with `ctx.schedule` — so nothing waits on a device that stopped answering.
7. **The simulator.** `createSimulator(ctx)` keeps the same contract with no
   hardware. Tests use it, and so does "try without hardware".
8. **Tests.** `test/contract.test.ts` runs `checkDeviceTypeContract`; pass it
   fake connections from `@kraftverk/device-sdk/testing` (`fakeByteChannel`,
   `fakeMessageChannel`) to check `identify` against scripted bytes.

Screens are optional. A device with none gets the generic ones — a card,
controls, settings from its schema, history — and that is the outcome the
model is for. When it needs its own (the station's energy flow), add a `ui/`
folder, name it in `package.json` under `kraftverk.ui` and `exports`, and run
`npm run gen:devices`. A screen gets `DeviceScreenProps` from
`@kraftverk/api-client`: the device, and actions that reach whoever holds its
connection. It never learns whether that is the server or the app.

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

- **Every command goes through the action gateway.** A session implements
  `switch.set` or `outlets.set`; it never switches anything on its own
  initiative. The gateway decides whether it may, and verifies it happened.
- **Honour `ctx.readOnly`.** Refuse every write while it is set.
- **A frame that can damage hardware is the protocol's `guard`'s business.**
  The Sydpower guard refuses register 68 = 0 for every holder and at the
  broker. If your protocol has such a frame, refuse it there, once.
- **Settings that can damage hardware** go in `settings.dangerous`, and their
  schema must not allow the value that does it.
- **No third-party runtime dependencies** without a review: a package runs
  inside the server with everything it can do.

## Before you open a pull request

- `npm test`, `npm run typecheck` and `npm run check:architecture` pass.
- `npm run gen:devices -- --check` passes, if it has screens.
- Its `support` level is honest, with a `supportNote` saying why.
- What was verified on real hardware is written down, as
  [`P280-FINDINGS.md`](P280-FINDINGS.md) and [`ATORCH-S1W.md`](ATORCH-S1W.md) do.
