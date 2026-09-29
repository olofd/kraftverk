# Handover

State of play, and the things that would otherwise cost you a day. The product
intent is in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). The architecture, its
vocabulary and the plan are in [`ARCHITECTURE.md`](ARCHITECTURE.md), and the
data model in [`DATA-MODEL.md`](DATA-MODEL.md). This document holds only what
those cannot: where things stand right now, and what has been learned the hard
way. Where it describes code that the plan replaces, the plan is the target.

Last updated 2026-09-29.

> **Phase: research and development — strict version 1.** Nobody runs
> kraftverk in production but its owner, so nothing here is kept backward
> compatible: no adapters, no versions, no migration chain, no fields nullable
> only for old rows. A change to the model is made everywhere at once. Where
> this document says "stable forever", it means from the first release on.
> See [AGENTS.md](../AGENTS.md) and decision 21 in ARCHITECTURE.md §9; this changes when there
> is a production state to protect.

---

## Where things stand

**The plan's steps 0–15 are done** (ARCHITECTURE.md §8) and deployed: work
happens on `main`, and pushing it to GitLab deploys to the owner's NAS (GitHub
runs CI only; see [CI.md](CI.md)). The broker container is updated by the
manual `broker` job, which drops the station for about a minute. The architecture baseline is
empty: the core names no product, and every device is found, not listed.

- **The layers are packages**: `packages/transports` (mqtt with the broker,
  ble with server, web and native entries, lan, https), `packages/protocols`
  (sydpower, tuya-local, open-meteo), `packages/devices` (aferiy-p280,
  tuya-plug, atorch-s1w), `packages/services` (open-meteo) and
  `packages/gateway`. The server finds them at start; the app binds them in
  through `client/src/generated/registry.ts`.
- **The device model** (2026-09-29, ARCHITECTURE.md §4.2, steps 23–26 and
  35): a device is described by parts, attributes and events; capabilities are
  declared like Matter clusters and projected into Home Assistant and Matter
  (`standards.ts`); commands go to a part, settings are attributes written
  through the gateway. Keys off `main` begin with their part; each attribute
  says how long its value stays current; links join parts; tools, query
  answers and what makes a command consequential are declared as data and
  checked. There is one contract and one database schema
  (`server/src/history/schema.ts`): a database from an older schema is set
  aside on start, and history is not carried over. Removing a device keeps its
  history.
- **What the database holds besides** (Phase 2 of the next-step plan): a
  `meta` table saying which schema and version made it, a change log of every
  on/off and enum (`sample_change`, `GET /devices/:id/changes`), whose word a
  description is (`description_source`), each transport's own store
  (`transport_kv`, `TransportContext.store`), and what each audit entry is
  about (`resource_kind`, filterable at `/audit`). One-per-source links are
  held by a partial unique index, not only by code.
- **The gateway asks when it cannot tell**: a declared condition on a
  reading that is missing or stale counts as holding. How much is a load is
  the home's (`loadWatts`, App settings → Safety, `/api/policy`), and a
  confirmation is a single-use token bound to the intent and the person,
  for commands, settings and arming alike.
- **Live** (step 27): `GET /api/live`, a WebSocket, carries readings that
  moved, health and events; the app polls only while it is down.
- **The app holds connections too.** "Bluetooth, from this browser" runs the
  station's own session in the app, sends readings to the server and follows the
  gateway's rules there (`client/src/runtime`). Web Bluetooth is verified in the
  browser's add flow up to its chooser; native Bluetooth
  (`transport-ble/src/native.ts`) has not run on a phone.
- **Automations** (steps 14, 29): one typed rule language
  ([AUTOMATIONS.md](AUTOMATIONS.md)) — roles filled by parts, triggers by
  clock, event and threshold, commands through the gateway — observing until
  armed, audited. The shared recipes (`standard.*` in the SDK: a battery
  running low, charging between two levels, mains lost) and the packages'
  own (the forecast switch) are what automations are made from.

**Local mode.** The app does not need a server. A server is a client-side record
— address, name — kept in `localStorage` by `client/src/lib/servers.ts`, one
selected at a time; selecting none *is* local mode, in which the app keeps its
own devices (`client/src/runtime/local.ts`) and holds every connection. On
first run the app probes the build-time default address and adopts the server if
one answers, so `npm run dev` still just works.

**Tests and scratch state.** `KRAFTVERK_DB` overrides where the database lives,
so tests and a scratch server work on their own state instead of the owner's.
Under `NODE_ENV=test`, `KRAFTVERK_DB` is **required** — see the trap below.
`.claude/launch.json` has `server:ui-check`: the server on port 3334 with a
scratch database, for driving the app in a browser.

**Production starts afresh.** The owner decided history from before the
device model is not worth keeping: on its first start with the one schema the
server sets the old database aside (`kraftverk.db.set-aside.<time>`) and
begins a new one, so the first account is created again from the home network
and the station added again through the add flow. The `.before-migration-*`
and `.set-aside.*` copies on the server's volume are the owner's to delete.

## Traps

**The station accepts one Bluetooth connection.** The app, the server and
BrightEMS all compete for it. Symptoms are misleading: on Windows an unpaired or
already-claimed peripheral shows only the generic GATT services, so the vendor
service looks missing rather than busy.

**Connecting is not understanding.** A wrong Tuya local key produced a *healthy,
connected, zero-datapoint* link. That now fails at three levels with a message
naming the likely cause — but the lesson generalises: a socket that opens proves
the thing is there and nothing about whether you can read it.

**Two published sources disagree about the ATORCH relay datapoint** — DP 1 in the
Tuya product spec, DP 131 in the OpenBeken community. Unresolved; it must be
settled on the actual unit. Do not pick one. See [`ATORCH-S1W.md`](ATORCH-S1W.md).

**The MQTT path needs two things that have nothing to do with code**: the
station pointed at this machine (BrightEMS's *Local MQTT Broker*, or
`mqtt.sydpower.com` redirected), and inbound TCP 1883 allowed. On a Windows
machine whose network profile is Public, the station README's `profile=private` firewall
rule does not apply. Bluetooth needs neither.

**A test suite once deleted the owner's database, and the tests still passed.**
Bun runs every test file in one process, sharing `history/db.ts`'s module-level
handle and `process.env`. Each server suite set `KRAFTVERK_DB` in `beforeAll` and
cleared it in `afterAll`; the moment one file cleared it, the next file's
`beforeEach` — several begin `DELETE FROM device; DELETE FROM sample` — reopened
the real database and truncated it. It cost the owner four devices and ~28,000
samples. `db()` now throws rather than open the default path under
`NODE_ENV=test`, and no suite clears the variable. **Do not reintroduce that
cleanup**, and if you add a suite that touches the database, set `KRAFTVERK_DB`
before anything calls `db()`.

**`server/data/` is gitignored** and holds the development database. Deleting it
resets your devices, secrets and history — the fastest way back to a blank slate
when testing the add flow. Scratch files for one-off scripts go in
`server/data/scratch/`.

**Tamagui must stay a `peerDependency`** in `packages/ui` and every device
package. Two installed copies mean two theme contexts and silently broken
styling.

**Metro and npm need the workspace globs.** `packages/*` does not reach nested
package folders (`packages/devices/*`, and the others ARCHITECTURE.md §3 adds);
each is listed in the root `package.json`. `client/metro.config.js` also stubs
optional native modules, which is what lets the app build without
`react-native-ble-plx` installed.

**`npm install --ignore-scripts` leaves a placeholder `bun.exe`.** Fix it with
`node node_modules/bun/install.js`.

**Toggles cannot be operated from a keyboard.** They are focusable and announce
correctly, but neither a Tamagui `onKeyDown` prop, a listener attached through
the ref, nor `role="button"` + `aria-pressed` flipped one. Everything else is
keyboard-operable: each tappable has a `role`, a `tabIndex` and a focus ring —
a Tamagui `XStack` with an `onPress` renders a plain `div` and is invisible to
Tab. If you add a tappable that is not a `Button`, use
`src/components/Pressable.tsx`, and pass `selected` when it is one of a set of
choices so it announces as a radio.

**Every server can reach everything installed.** There is no launch flag for
transports: each device is reached the way it was added, and **Simulated** is a
way to add any device with no hardware. **App settings → Connectivity** says
which transports run on this machine, and why one does not. What a launch
chooses is only whether writes to hardware are allowed: `.claude/launch.json`
carries `server` (read-only) and `server:write`.

**Writes from the app are off every launch.** A connection the app holds is
read-only until **App settings → Allow writes from this app** is turned on, on
purpose. A settings screen that silently refuses from a phone is that switch.

## Commands worth knowing

```bash
npm run dev                  # server + web app, writes to hardware refused
npm run dev:write            # the same, with writes allowed — read the hardware warning
npm test                     # the whole repo
npm run typecheck            # every workspace
npm run check:architecture   # the dependency rule, the leak ratchet, the app's generated registry
npm run gen:devices          # regenerate the app's registry after adding a package
npm run new:device -- name    # start a device type (new:protocol, new:transport too)
npm run scan:tuya            # find Tuya plugs — no credentials needed
npm run keys:tuya            # fetch their local keys (scan a QR code with the Smart Life app)
```

The server runs on Bun; `scripts/run-bun.mjs` finds it even when PATH is stale.

## Waiting on the owner

- **The ATORCH's local key, and the questions in [`ATORCH-S1W.md`](ATORCH-S1W.md) §7**,
  settled on the unit: which of the two Tuya devices on the LAN is the plug, and
  which datapoint switches its relay.
