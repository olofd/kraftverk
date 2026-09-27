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

**The plan's steps 0–3 are done and deployed** (ARCHITECTURE.md §8): one
authority for the architecture, the guardrails in CI, the device SDK, and device
types discovered at runtime with a session for every saved device. `main`
deploys to the owner's NAS through GitLab; GitHub runs CI only. The status of
every later step is the plan's table — this document does not repeat it.

**What runs today, and is on its way out.** The core still contains the P280's
connectivity (`server/src/{broker,mqtt,transport,connections,drivers}`), the
smart plugs are still the two v1 plugins under `packages/plugins/`, and
`packages/protocol` still mixes the Sydpower protocol with the P280's model. The
findings table (ARCHITECTURE.md §6) names each of these with the step that
removes it.

**Local mode.** The app does not need a server. A server is a client-side record
— address, name — kept in `localStorage` by `client/src/lib/servers.ts`, one
selected at a time; selecting none *is* local mode, in which the app holds a
station's Bluetooth link itself. On first run the app probes the build-time
default address and adopts the server if one answers, so `npm run dev` still
just works. The API client's base URL is runtime-settable (`setApiBaseUrl`).

**Tests and scratch state.** `KRAFTVERK_DB` and `KRAFTVERK_BINDING_FILE` override
where the database and the legacy station binding live, so tests and a scratch
server work on their own state instead of the owner's. Under `NODE_ENV=test`,
`KRAFTVERK_DB` is **required** — see the trap below.

**Production, 2026-09-27.** Shortly after step 3 was deployed, the station and a
test plug were removed in the app. Removing a device then deleted its history,
so the live database has no devices and no samples. The copy the server made
before migration 6 — `/data/kraftverk.db.before-migration-6.2026-09-27T19-50-30Z`
on the server's volume — still holds the station and all its history. Whether to
restore it is the owner's decision. Removing a device will keep its history from
step 5 (ARCHITECTURE.md, decision 13).

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

**The station link is a launch flag in development.** `npm run dev` is the
*simulator*, and no screen can change that. Restarting a Bluetooth server with
the wrong script is an easy way to spend ten minutes wondering why the radio
vanished. `.claude/launch.json` carries `server`, `server:ble` and
`server:ble:write` for that reason.

## Commands worth knowing

```bash
npm run dev                  # simulator + web app
npm run dev:ble              # real station over Bluetooth, read-only
npm run dev:ble:write        # the same, with writes allowed — read the hardware warning
npm test                     # the whole repo
npm run typecheck            # every workspace
npm run check:architecture   # the dependency rule, the leak ratchet, the app's generated registry
npm run gen:devices          # regenerate the app's device registry after adding a device type
npm run scan:tuya            # find Tuya plugs — no credentials needed
npm run keys:tuya            # fetch their local keys (needs a Tuya cloud project)
```

The server runs on Bun; `scripts/run-bun.mjs` finds it even when PATH is stale.

## Waiting on the owner

- **Whether to restore the station's history** from the pre-migration copy (above).
- **The ATORCH's local key, and the questions in [`ATORCH-S1W.md`](ATORCH-S1W.md) §7**,
  settled on the unit: which of the two Tuya devices on the LAN is the plug, and
  which datapoint switches its relay.
