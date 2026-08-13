# Handover

> **Architecture update:** this file is a historical implementation snapshot.
> Start with [`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md) for the current
> device-first target. In particular, its “working tree clean” and completion claims
> must not be used to override the current repository state.

State of play, and the things that would otherwise cost you a day. The vision and
the architecture are in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) — read its end-goal
section first. This document is only what that one cannot tell you: where things
stand right now, and what has already been learned the hard way.

Last updated at commit `9fa7c77` on branch `devices-and-extensions`.

---

## Where things stand

On **`devices-and-extensions`**, **not pushed**. Typecheck clean across seven
packages, 160 tests passing (`npm test`).

The device-first restructuring is partly done. Auto-adoption is gone and the
`ConnectionManager` exists; the app's global tabs and `StationProvider` do not
yet, so the remaining work is the client's. The global station routes
(`/api/status`, `/api/settings`, `/api/ports`) still exist, but they now resolve
through the one open session and answer 404 when there is no station — they are
deprecated in favour of `/api/devices/:id/...`.

`KRAFTVERK_DB` and `KRAFTVERK_BINDING_FILE` now override where the database and
the station binding live. They exist so tests — and a scratch server — work on
their own state instead of the owner's devices and real station binding.

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

## Active work: Milestone A

The plan is [`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md). **Milestone A
— make the blank canvas real** is the current milestone, and nothing from D
(automations, weather, autonomous switching) starts until A–C are done.

Milestone A, in order:

1. ~~**Remove `DeviceRegistry.adoptStation()` from startup.**~~ **Done.** Nothing
   is adopted now; a fresh database renders an empty canvas. The one case that
   would otherwise lose something is `server/src/devices/legacy.ts`: a station
   bound before the catalog existed is *offered* as an import behind a banner on
   the Devices screen, and only when the server is running the transport the
   binding names — a BLE binding under the simulator would create a record the
   server cannot operate. Taking it or dismissing it is remembered in the new
   `app_state` table, so the banner asks once.
2. **Root becomes `Your devices`.** Global Dashboard, Settings, Protocol and
   Extensions leave the primary tab bar. Root is always the canvas even with one
   device; each saved device gets its own stable route so it can be opened
   directly.
3. **`/devices` returns `SavedDeviceView`** with connection health and explicit
   ids — see the identifier rule below.
4. **Migrations** for `updated_at`, connection records, device-scoped secrets and
   automation references, with CRUD tests.
5. **Deleting a device** must reject or explicitly cascade when an automation
   references it.

Then B (commission one P280 through the wizard) and C (the same shape for a
plug, with per-saved-device adapter instances).

## Known limitations to correct, not preserve

These are current behaviours the refactor exists to fix. Do not treat them as
settled design:

- ~~The station is auto-adopted at startup~~ — **fixed**, see Milestone A item 1.
- **`StationProvider` is global**, and the station still behaves like the app
  rather than like one device.
- ~~The server holds one `driver`, one `transport`, one binding.~~ **Fixed.**
  `server/src/connections/manager.ts` opens one session per saved station,
  keyed by catalog id, and is the only thing that knows about live drivers and
  transports. This process still holds one radio, so a second station is
  *refused with a reason* rather than handed the first one's link — the honest
  version of the same constraint. `binding.json` is legacy and read-only now;
  where a device is reached lives on its record.
- **`PluginHost` keeps one configuration per package** and the registry reads
  `plugin.devices()[0]`, so one adapter cannot serve two plugs.
- **`DeviceDescriptor.id` and `DeviceView.id` mean different things** — vendor
  identity versus catalog id — and the registry reads one while history keys on
  the other. Use `SavedDeviceId`, `CandidateId` and `ProviderDeviceId`
  explicitly; never overload `id` in a DTO.
- **`/api/device-types` flattens every relay adapter to a generic smart plug**
  and says nothing about connection choices, discovery or verification.
- **Adding a device writes the record before the connection is configured**, so
  a permanently grey device can be created.

## Vocabulary

`adapter` = code that knows a protocol. `device` = a saved thing you own.
`plugin` = a service with no hardware, like weather. Tuya is an **adapter**; the
relay is a **device**. Services do not appear on the device canvas at all until
that work begins.

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
npm test               # 160 tests, whole repo
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
