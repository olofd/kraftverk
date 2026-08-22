# Handover

State of play, and the things that would otherwise cost you a day. The vision and
the architecture are in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) — read its end-goal
section first; the device-first target and its milestones are in
[`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md). This document is only what
those cannot tell you: where things stand right now, and what has already been
learned the hard way.

Last updated at commit `95d95ed` on `main`.

---

## Where things stand

**Merged to `main` and pushed.** `devices-and-extensions` was fast-forwarded into
`main` at `95d95ed`; the two refs are identical, so the feature branch holds
nothing extra. Typecheck clean across all nine workspaces — the seven packages,
the client and the server — and 177 tests passing (`npm test`).

**The device-first restructuring is done**, in the sense the session set out:
the P280 works as it did, and it is a saved device that can be added, renamed,
edited and deleted. Auto-adoption is gone, the `ConnectionManager` owns every
session, root is the device canvas, and no client code reads a global station.

Two loose ends, both deliberate and both cheap:

- **The global station routes are now dead code.** `/api/status`,
  `/api/settings`, `/api/ports/:id` and `/api/simulator/grid` still exist and
  still work — they resolve through the one open session and 404 when there is
  no station — but nothing in the app calls them. Deleting them (and the
  matching `fetchStatus`/`patchSettings`/`setPort` in `@kraftverk/api-client`)
  is a self-contained next commit.
- **`/api/diagnostics/*` is still global.** The Protocol screen sits under a
  device's Advanced, but the register dump it reads still resolves to whichever
  session the server holds. It becomes device-scoped when the P280 adapter moves
  into its package in Milestone B.

**Local mode and server mode.** The app no longer assumes a server exists. A
server is a client-side record — address, name — kept in `localStorage` by
`client/src/lib/servers.ts`, with full CRUD and one selected at a time; selecting
none *is* local mode. On first run the app probes the build-time default address
and adopts the server if one answers, so `npm run dev` still just works, and a
browser-only user is left in local mode with nothing red on screen. The API
client's base URL is now runtime-settable (`setApiBaseUrl`), not a constant.

`KRAFTVERK_DB` and `KRAFTVERK_BINDING_FILE` now override where the database and
the station binding live. They exist so tests — and a scratch server — work on
their own state instead of the owner's devices and real station binding. Under
`NODE_ENV=test`, `KRAFTVERK_DB` is **required**: see the trap about the suite
that deleted the real database.

**Browsers are no longer trusted by default.** CORS reflected whatever origin
asked, which on an unauthenticated LAN server with a route that switches mains
is the same as no policy. Loopback and private ranges are allowed; anything else
must be named in `ALLOWED_ORIGINS`. `DELETE` was also missing from
`allowMethods`, so *Forget this device* was refused by every browser — and the
app never caught the failure, so it showed nothing at all. Both are fixed, and
the catalog's own lifecycle (`device.added` / `renamed` / `remodelled` /
`forgotten`) is now written to the audit timeline, which it never was.

Built and verified in earlier sessions:

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
2. ~~**Root becomes `Your devices`.**~~ **Done.** There is no tab bar at all.
   Root is the canvas; `/device/:id` and `/device/:id/settings` are that
   device's only two primary destinations, and the register tools sit at
   `/device/:id/advanced`, reached from its Settings under Advanced. Extensions
   and the station link moved to `/app-settings`, one level down. The P280's
   panels are rendered from the device route through `src/devices/screens.ts`;
   a device with no panels of its own gets the generic ones in
   `src/features/devices/panels.tsx` and loses nothing.
3. ~~**`/devices` returns `SavedDeviceView`**~~ **Done.** `id` is always the
   catalog's, `providerDeviceId` carries the vendor's, and `providerName` the
   vendor's name — the descriptor is spread in with `id` and `name` *omitted*,
   so `Omit<DeviceDescriptor, 'id' | 'name'>` is what stops the old overwrite
   coming back rather than a convention someone has to remember. `online:
   boolean` became `health: ConnectionHealth`, whose five states each carry a
   sentence; the aliases and that type live in `packages/plugin-sdk/src/
   identity.ts`, which the server and the API client both import.
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
- ~~`StationProvider` is global~~ — **fixed.** It is now `DirectLinkProvider`,
  and it owns only the link the *app* holds over Bluetooth. Station telemetry is
  per device: `useDeviceConnection(device)` reads
  `GET /api/devices/:id/p280/state` and writes through
  `PATCH /api/devices/:id/p280/settings` and the device's own control route.
  Nothing in the client reads "the station" any more.
- ~~The server holds one `driver`, one `transport`, one binding.~~ **Fixed.**
  `server/src/connections/manager.ts` opens one session per saved station,
  keyed by catalog id, and is the only thing that knows about live drivers and
  links. `binding.json` is legacy and read-only now; where a device is reached
  lives on its record.
- ~~A second station is refused, because the process holds one radio.~~
  **Fixed, and the reasoning was wrong.** `StationTransport` conflated three
  jobs — discover, bind, carry frames — so one `boundId` capped the whole
  server. Over MQTT there was never any constraint at all: `DeviceBroker` has
  always been per-MAC, and the transport read every station's frames off the
  broker and then dropped all but one with a single identity check. Over BLE a
  central holds several peripherals at once; the code kept one set of
  characteristics and one frame assembler.

  It is now a `TransportHost` (the radio or the broker — genuinely one per
  process) carrying a `ServerLink` per saved station. The app is unaffected: it
  implements `StationTransport`, which now extends the smaller `StationLink`
  that `StationClient` actually needs.

  **What remains true is per station, not per server**: a station accepts one
  connection at a time, so the server still competes with the app and BrightEMS
  for any single unit — and two saved devices naming the *same* station is
  refused, which is what `refusal()` means now.
- **`PluginHost` keeps one configuration per package** and the registry reads
  `plugin.devices()[0]`, so one adapter cannot serve two plugs.
- ~~**`DeviceDescriptor.id` and `DeviceView.id` mean different things.**~~
  **Fixed**, see Milestone A item 3. The rule still stands for everything
  written from here: `SavedDeviceId`, `CandidateId` and `ProviderDeviceId` are
  named types in the SDK, and `id` in a public DTO always means the catalog's.
- **`/api/device-types` flattens every relay adapter to a generic smart plug**
  and says nothing about connection choices, discovery or verification.
- **Adding a device writes the record before the connection is configured**, so
  a permanently grey device can be created.

## Known gaps

**Toggles cannot be operated from a keyboard.** They are focusable and announce
correctly, but neither a Tamagui `onKeyDown` prop, a listener attached through
the ref, nor `role="button"` + `aria-pressed` flipped one — the first two never
fire, and react-native-web's built-in Enter/Space handling did not reach it.
Everything *else* is keyboard-operable now, so the problem is specific to the
switch. Unresolved; worth a look at how Tamagui forwards DOM events on web
before trying again.

Everything else was fixed by giving each tappable a `role`, a `tabIndex` and a
focus ring — the lesson being that a Tamagui `XStack` with an `onPress` renders
a plain `div` and is invisible to Tab. Measured before the fix: the device
canvas offered three focusable elements and **not one was a device**, and *Add a
device* offered **none at all**. If you add a tappable that is not a `Button`,
use `src/components/Pressable.tsx`, and pass `selected` when it is one of a set
of choices so it announces as a radio rather than a fourth identical button.

**The register diagnostics are still global.** `/api/diagnostics/*` resolves to
whichever session the server holds, even though the Protocol screen now sits
under one device's Advanced.

**The deprecated global routes are dead code.** `/status`, `/settings`,
`/ports/:id` and `/simulator/grid` still work; nothing calls them.

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

**A test suite once deleted that database, and the tests still passed.** Bun runs
every test file in one process, sharing `history/db.ts`'s module-level handle and
`process.env`. Each server suite set `KRAFTVERK_DB` in `beforeAll` and cleared it
in `afterAll`; the moment one file cleared it, the next file's `beforeEach` —
several begin `DELETE FROM device; DELETE FROM sample` — reopened the real
database and truncated it. It cost the owner four devices and ~28,000 samples.
`db()` now throws rather than open the default path under `NODE_ENV=test`, and no
suite clears the variable. **Do not reintroduce that cleanup**, and if you add a
suite that touches the database, set `KRAFTVERK_DB` before anything calls `db()`.

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
npm run dev:ble:write  # the same, with writes allowed — read the hardware warning
npm test               # 177 tests, whole repo
npm run typecheck      # nine workspaces: seven packages, client, server
npm run scan:tuya      # find Tuya plugs — no credentials needed
npm run keys:tuya      # fetch their local keys (needs a Tuya cloud project)
```

The server runs on Bun; `scripts/run-bun.mjs` finds it even when PATH is stale.

**The transport is a launch flag, not a setting.** `npm run dev` is the
*simulator*; the Station link screen will say so and there is no control on it
that can change that. Restarting a Bluetooth server with the wrong script is an
easy way to spend ten minutes wondering why the radio vanished.
`.claude/launch.json` carries `server`, `server:ble` and `server:ble:write` for
that reason.

## Waiting on the owner

- **The ATORCH's local key.** Everything else on that path is built and tested
  against the real API. [`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md) is the guide.
- **Which of the two Tuya devices on the LAN is the plug.** `192.168.50.74`
  speaks 3.4, `192.168.50.17` speaks 3.3; the ATORCH uses a Beken module and the
  3.3 device's id embeds an Espressif MAC, so the 3.4 one is the likelier
  candidate — but it went offline mid-session and was never confirmed.

~~Whether to push this branch.~~ **Decided**: merged to `main` and pushed.
`origin/devices-and-extensions` is stale and can be deleted; `main` has
everything.
