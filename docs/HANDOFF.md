# Handover

State of play, and the things that would otherwise cost you a day. The product
intent is in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). The architecture, its
vocabulary and the plan are in [`ARCHITECTURE.md`](ARCHITECTURE.md), and the
data model in [`DATA-MODEL.md`](DATA-MODEL.md). This document holds only what
those cannot: where things stand right now, and what has been learned the hard
way. Where it describes code that the plan replaces, the plan is the target.

Last updated 2026-09-28.

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
- **Migration 7** turns the old catalog into devices with type ids and
  identities, connections, sealed connection secrets and links; the Tuya
  plugin's configuration becomes an ATORCH or generic plug with its key, and
  the grid pairing a `feeds` link. Removing a device now keeps its history.
- **The app holds connections too.** "Bluetooth, from this browser" runs the
  station's own session in the app, sends readings to the server and follows the
  gateway's rules there (`client/src/runtime`). Web Bluetooth is verified in the
  browser's add flow up to its chooser; native Bluetooth
  (`transport-ble/src/native.ts`) has not run on a phone.
- **Automations** (step 14): recipes with roles filled by devices, observing
  until armed, run by the server through the gateway and audited
  (`server/src/automations`, the app's Automations screen). The first recipe
  switches by the forecast; the backup reserve and rules are next.

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

**Production starts afresh.** The live database had no devices after
2026-09-27, when removing a device still deleted its history. The owner decided
not to restore the older copy: it is early in the project, and history from
before the new data model is not worth keeping. The `.before-migration-*`
copies on the server's volume can be deleted by the owner. Add the station
again through the add flow.

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
machine whose network profile is Public, the README's `profile=private` firewall
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

**What a server can reach is a launch flag.** `npm run dev` is the
*simulator*, and no screen can change that: **App settings → Connectivity** says
which it is. Restarting a Bluetooth server with the wrong script is an easy way
to spend ten minutes wondering why the radio vanished. `.claude/launch.json`
carries `server`, `server:ble` and `server:ble:write` for that reason.

**Writes from the app are off every launch.** A connection the app holds is
read-only until **App settings → Allow writes from this app** is turned on, on
purpose. A settings screen that silently refuses from a phone is that switch.

## Commands worth knowing

```bash
npm run dev                  # simulator + web app
npm run dev:ble              # real station over Bluetooth, read-only
npm run dev:ble:write        # the same, with writes allowed — read the hardware warning
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
