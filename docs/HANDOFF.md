# Handover

State of play, and the things that would otherwise cost you a day. The vision and
the architecture are in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) — read its end-goal
section first. This document is only what that one cannot tell you: where things
stand right now, and what has already been learned the hard way.

Last updated at commit `9fa7c77` on branch `devices-and-extensions`.

---

## Where things stand

Four commits on **`devices-and-extensions`**, **not pushed**. Working tree clean,
typecheck clean across seven packages, 99 tests passing (`npm test`).

Built and verified this session:

- **Extension system** — SDK contracts, plugin host with scoped contexts and
  failure isolation, capability grants, audit timeline.
- **Action gateway** (`server/src/actions/gateway.ts`) — the only code that may
  switch mains. Grant → policy → freshness → one command → *two* proofs (the
  plug's readback **and** the station's AC input agreeing) → audit.
- **Device model** — persisted catalog with CRUD and model selection, a registry
  joining records to live drivers, per-measurement history sampling.
- **The P280 as a device package** — its declarations and all four of its screens
  now live in `packages/devices/aferiy-p280`. The app's tabs are 21–46 lines.
- **Tuya LAN driver** — 3.3/3.4/3.5 framing with protocol detection, UDP
  discovery, cloud helper for local keys, setup wizard in the app.

## Do these next, in this order

1. **`StationProvider` should read the device model.** It still calls `/status`
   and `/settings` directly. It is the last station-shaped assumption in the
   client, and the devices grid cannot be honest until it is gone.
2. **Devices grid and detail screens.** The server side is done and tested:
   `/api/devices`, `/api/device-types`, CRUD, `/api/devices/:id/history`. This is
   where the work pays off — adding the plug becomes a row, not a feature.
3. **Charts.** The sampler already records every declared measurement each
   minute, so one chart component answers "how many watts is it drawing" for
   every device at once, and brings the P280's own history with it.

Then: recipes (Backup reserve first), the arming gate, and `se.smhi.weather`.
Build the weather plugin **early** — it is the only real test of whether a new
device type needs zero client code, and you want to find out while the contract
is still cheap to change.

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
Tuya product spec, DP 131 in the OpenBeken community. Unresolved, and it must be
settled on the actual unit with the Test button's datapoint dump. Do not pick one.

**The MQTT path needs two things that have nothing to do with code**:
`mqtt.sydpower.com` pointed at this machine, and inbound TCP 1883 allowed. On this
machine the network profile is Public, so the README's `profile=private` rule does
not apply. BLE works with neither.

**`server/data/` is gitignored and holds the SQLite database.** Deleting it resets
your devices, plugin config, secrets and history — which is also the fastest way
back to a blank slate when testing the add-device flow.

**Tamagui must stay a `peerDependency`** in `packages/ui` and every device
package. Two installed copies mean two theme contexts and silently broken styling.

**Metro needs the workspace globs.** `packages/*` does not reach
`packages/devices/*` or `packages/plugins/*`; both are listed in the root
`package.json`. `client/metro.config.js` also stubs optional native modules, which
is what lets the app build without `react-native-ble-plx` installed.

## Commands worth knowing

```bash
npm run dev            # simulator + web app
npm run dev:ble        # real station over Bluetooth, read-only
npm test               # 99 tests, whole repo
npm run typecheck      # all seven packages
npm run scan:tuya      # find Tuya plugs — no credentials needed
npm run keys:tuya      # fetch their local keys (needs a Tuya cloud project)
```

The server runs on Bun; `scripts/run-bun.mjs` finds it even when PATH is stale.

## Waiting on the owner

- **The ATORCH's local key.** Everything else on that path is built and tested
  against the real API. [`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md) is the guide.
- **Which of the two Tuya devices on the LAN is the plug.** `192.168.50.74`
  speaks 3.4, `192.168.50.17` speaks 3.3; the ATORCH uses a Beken module and the
  3.3 device's id embeds an Espressif MAC, so the 3.4 one is the likelier
  candidate — but it went offline mid-session and was never confirmed.
- **Whether to push this branch.**
