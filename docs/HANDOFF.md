# Handover

State of play, and the things that would otherwise cost you a day. The product
intent is in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). The architecture, its
vocabulary and the plan are in [`ARCHITECTURE.md`](ARCHITECTURE.md), and the
data model in [`DATA-MODEL.md`](DATA-MODEL.md). This document holds only what
those cannot: where things stand right now, and what has been learned the hard
way. Where it describes code that the plan replaces, the plan is the target.

Last updated 2026-10-03.

> **Phase: research and development — strict version 1.** Nobody runs
> kraftverk in production but its owner, so nothing here is kept backward
> compatible: no adapters, no versions, no migration chain, no fields nullable
> only for old rows. A change to the model is made everywhere at once. Where
> this document says "stable forever", it means from the first release on.
> See [AGENTS.md](../AGENTS.md) and decision 21 in ARCHITECTURE.md §9; this changes when there
> is a production state to protect.

---

## Where things stand

**The plan's steps 0–15 are done** (ARCHITECTURE.md §8), and so are the
next-step plan's phases 0, 1, 2 and 5 and the assistant minimum — see *What
is built, and what is not* below. Work happens on `main`, and pushing it to
the owner's Forgejo checks it and deploys it onto the server it runs on
([DEPLOY.md](DEPLOY.md)). The broker container is updated by the manual
**Broker** workflow, which drops the station for about a minute. The architecture baseline is
empty: the core names no product, and every device is found, not listed.

- **The shared core** ([PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md)): the
  home is one hub (`@kraftverk/hub`) behind one interface (`KraftverkApi`),
  run by the server and by the app alike — in a browser's worker or a
  phone's process — with its own SQLite. Phases 0–6h and 6j are done:
  every place kraftverk runs is a **kraftverk node** (a `node` record, by
  its own id, declaring always on, reachable, trusted); one is the home's
  **master**, the others **follow** it (`createFollower`) and hold for it
  the ways they reach; a connection method says what it `needs` of the
  node holding it. 6i is done too: no logic is left in the server or the
  app (the architecture check holds it at zero). The structure pass, and
  an outside review after it (2026-10-02), are done: each file holds one
  thing, a refusal crosses every wire as itself, and the HTTP client and
  the routes are held in step by a test. Places are out of the schema
  until the owner decides what groups things (a home, or places). Still
  open, each a decision first: whether a node is trusted only once a
  person confirms it (today it says so itself); a follower asked as the
  person using it (`as(caller)`), not as its node; and what step 32 needs
  before a package from outside (ARCHITECTURE.md, step 32).
- **The layers are packages**: `packages/transports` (mqtt with the broker,
  ble with system, web and native entries, lan, https),
  `packages/integrations` — each platform, with its protocol inside it:
  sydpower, tuya, niu, open-meteo, elprisetjustnu — `packages/devices` — each product on one: aferiy-p280,
  atorch-s1w, tuya-zigbee-plug, niu-uqi-gt (docs/PLAN-INTEGRATIONS.md §1.1) —
  and `packages/gateway`. The server finds them at start; the app binds them in
  through `client/src/generated/registry.ts`.
- **The device model** (2026-09-29, ARCHITECTURE.md §4.2, steps 23–26 and
  35): a device is described by parts, attributes and events; capabilities are
  declared like Matter clusters and projected into Home Assistant and Matter
  (`standards.ts`); commands go to a part, settings are attributes written
  through the gateway. Keys off `main` begin with their part; each attribute
  says how long its value stays current; links join parts; tools, query
  answers and what makes a command consequential are declared as data and
  checked. There is one contract and one database schema
  (`packages/store/src/schema.ts`): a database from an older schema is set
  aside on start, and history is not carried over. Removing a device keeps its
  history.
- **What the database holds besides** (Phase 2 of the next-step plan): a
  `meta` table saying which schema and version made it, a change log of every
  on/off and enum (`sample_change`, `GET /devices/:id/changes`), whose word a
  description is (`description_source`), each transport's own store
  (`transport_kv`, `TransportContext.store`), and what each audit entry is
  about (`resource_kind`, filterable at `/audit`). One-per-source links are
  held by a partial unique index, not only by code.
- **Sequences** (2026-09-30, [SEQUENCES.md](SEQUENCES.md)): an automation's
  steps may wait, wait until, make sure (with retries), choose and watch —
  bounded, checked, read back as numbered steps. Every run is a row with its
  steps (`automation_run`); roles and trigger state are rows too; the gateway
  lets a run switch a part again within its declared allowance.
  `standard.start-charging` and `standard.stop-charging` drive a charger
  through its supply; the app shows a run step by step as it goes, and a
  device's page offers what it can start.
- **The automation editor** (2026-09-30,
  [AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md)): every automation owns its
  rule, built from blocks in the app — any command a part offers, any
  setting it may be told, pauses, waits, checks, choices, watches, and
  starting another automation — or copied from a recipe and changed. The
  server checks each draft as it is built. Any automation that is not off
  can be started by hand, whatever its mode (the mode governs only what it
  does on its own); `at` triggers take weekdays; chains go four deep and
  never back on themselves; any automation can be a shortcut on the home
  page.
- **Automations at a glance** (2026-10-01,
  [AUTOMATIONS-UX.md](AUTOMATIONS-UX.md)): each automation a small card with
  a play button — the same in the list, on the home page and on a device's
  page — and a page of its own, its parts in groups, which Edit turns into
  its form in place. Controls that fit a 320 px phone, by keyboard too, kept
  so by `e2e/layout.e2e.ts`. All three phases done.
- **Shared parts and a reserve** (2026-09-30,
  [SHARED-PARTS-AND-RESERVE.md](SHARED-PARTS-AND-RESERVE.md)): a run holds
  the parts it may change, and another automation's run that needs one is
  refused; keeping things so leaves what another automation set; the
  gateway refuses automations what drains a battery below the home's
  `reserveSoc`.
- **The gateway asks when it cannot tell**: a declared condition on a
  reading that is missing or stale counts as holding. How much is a load is
  the home's (`loadWatts`, App settings → Safety, `/api/policy`), and a
  confirmation is a single-use token bound to the intent and the person,
  for commands, settings and letting an automation act alike.
- **The app on the model** (step 28): pages drawn from the description —
  energy flow, part pages, events and a Problems page, About, tools from their
  declarations — with slots (`DeviceUi`) a package fills where it draws
  better, from a kit in `packages/ui`. The P280's screens draw from its
  readings; it has no status tool.
- **The assistant, minimum**: `GET /api/world`, `GET /api/vocabulary`, and
  MCP at `POST /api/mcp` (see [API.md](API.md)) acting as `actor: 'agent'`,
  which is refused whatever needs a person's yes; `propose` makes an
  automation that watches, and rehearses it on history.
- **Live** (step 27): `GET /api/live`, a WebSocket, carries readings that
  moved, health and events; the app polls only while it is down.
- **The app holds connections too.** "Bluetooth, from this browser" runs the
  station's own session in the app, as a node following the server
  (`createFollower` in `packages/hub`), sends readings to the server and
  follows the gateway's rules there. Web Bluetooth is verified in the
  browser's add flow up to its chooser; native Bluetooth
  (`packages/transports/ble/src/native.ts`) has not run on a phone.
- **Automations** (steps 14, 29): one typed rule language
  ([AUTOMATIONS.md](AUTOMATIONS.md)) — roles filled by parts, triggers by
  clock, event and threshold, commands through the gateway — watching until
  let act, audited. The shared recipes (`standard.*` in the SDK: a battery
  running low, charging between two levels, mains lost) and the packages'
  own (the forecast switch) are what automations are made from.

**Without a server.** The app does not need one. A server is a client-side
record — address, name — kept in `localStorage` by
`client/src/platform/servers.ts`, one selected at a time; with none selected
the app keeps a home of its own — the hub, in its own SQLite: in the app's process on a
phone, in a worker in a browser (`client/src/platform/home/`) — and holds
every connection. Every screen asks one interface either way
(`client/src/state/HomeProvider.tsx`). On
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
Since then, a database set aside brings the home back from
`config/kraftverk.yaml`, and its accounts are copied into the new one
(sign in again, same password). See SECURITY.md, "Where accounts live".

## Integrations

Built to step 16 of [PLAN-INTEGRATIONS.md](PLAN-INTEGRATIONS.md) on
2026-10-07 (Part A: what kraftverk has, on the model; discovery by
declaration; mDNS and SSDP heard through the relay; the lists opened —
quantities as records, position and `location`, `distance` in rules,
categories toward Home Assistant's breadth; and code loaded on demand —
each package's generated `catalogue.json` is what a home lists and finds
by, an integration's code imported when first needed), on the model its
§1.1 sets out: an integration is the one place kraftverk meets a service —
its protocol, accounts, gateways and own screens — and a device package
builds on one integration and nothing else; parts talk by typed calls,
never publish/subscribe; accounts live on their integration's page. Ways
say what they are found by; the home network and the broker are watched all
the time, so what turns up waits on Home. In Docker the home network is
heard by the `relay` service, the only one on the host's network
([DOCKER.md](DOCKER.md#the-relay)); radios plugged into the host later
(Zigbee, Thread, Matter) are services at that edge too. Step 16 is done:
[PORTING-FROM-HOME-ASSISTANT.md](PORTING-FROM-HOME-ASSISTANT.md), and
Shelly (Gen2 and later) ported by it — experimental until checked against
the owner's Shelly. Part C is under way: iCloud (steps 17–18: Apple's
sign-in with a second factor, the family's devices with their positions)
and the Apple TV (step 19: Companion with HomeKit pairing; step 20: the
device — on and off, playback, keys, apps, volume, paused by an
automation through the gateway) are built, tested against Apple and a TV
played in the tests — not yet against the owner's Apple ID or TV. That
completes Part C as planned; what is left is checking it on the real
account and TV.

The app's addresses are one scheme, `PATHS` in `@kraftverk/api-client`
(collections plural, every page and every step of adding its own; a setup
is taken up again from its URL). What a person meets is decided by a
type's kind: devices, services, and an integration's own — its accounts
and gateways — on its page. An integration keeps what its setups share
(`SetupContext.kept`, sealed in `integration_kv`): Tuya its Smart Life
listing and User Code.

## The automation language

Paused at a good point on 2026-10-06, its plan's phases A–C done and
deployed. What it does, and what is left — in the order it is worth doing —
is in [AUTOMATION-LANGUAGE-STATUS.md](AUTOMATION-LANGUAGE-STATUS.md).

## What is built, and what is not

Measured against [NEXT-STEP-ARCHITECTURE.md](NEXT-STEP-ARCHITECTURE.md) §10
(the phases) and §12 (findings J1–J40), as of 2026-09-30 (`32a218b`). The
checks say whether they are green — `npm run typecheck`, `npm test`,
`npm run check:architecture`, `npm run test:e2e` — and this page does not
repeat them: counts written here went stale with every commit, and once
said green over a red job.

**Deployed 2026-09-30.** The push to GitLab carried the schema change of
Phase 2 (`4b2be75`), so the NAS database was set aside once on start: the
first account is made again from the home network, and the station and the
plug are added again. The set-aside file is kept beside the new one.

### Built

| Phase | What | Commits |
|---|---|---|
| 0 Hygiene | Ratchets over every package's words; events pruned; refused devices retried; product words out of the shell | earlier |
| 1 The model, part 3 | Values with structure, meanings, part-scoped keys, `currentFor`, links between parts, declared consequence, tools and query answers as data, branded ids, reach on methods | `eaade9b` |
| 2 Storage | `meta`; `sample_change` and `/devices/:id/changes`; `description_source`; `transport_kv` (`TransportContext.store`); `audit.resource_kind`, filterable at `/audit`; history `from`/`to`; one-per-source held by a partial unique index | `4b2be75` |
| 3 The engine, in part | The live stream (step 27); confirmation as a single-use token bound to the intent and the person (J17); a write dwell per setting (J18) | `4b2be75`, `32a218b` |
| 4 Automations | Rules as data; recipes from packages and the SDK (`standard.*`); time, event and threshold triggers; trigger state kept across restarts | `df58ec0`, `bda8c67` |
| 5 The app on the model | Slots (`DeviceUi`) and a kit in `packages/ui`; energy flow, part pages, events and a Problems page, About, tools drawn from their declarations; the P280's screens from its readings, with no status tool; keyboard-operable toggles | `b558fe3`, `4b7ed6d`, `29b102b` |
| Assistant, minimum | `GET /world`, `GET /vocabulary`; MCP at `POST /mcp`, acting as `actor: 'agent'`, refused whatever needs a person's yes; `propose` (made watching) and rehearsal on history, also in the app | `1389c53` |

From the Phase 1 review:

- Unknown load asks. A missing or stale reading now needs confirmation.
- The 5 W threshold is the home's `loadWatts`, in App settings → Safety and at `/api/policy`. Beside it, `reserveSoc`: none until the home sets one.
- Trigger state is persisted.
- The P280 state tool is gone.
- Phase 2 was bundled with the confirmation nonce.
- One-per-source is enforced in the database.
- The small items are done.
- The end-to-end jobs run in both CIs.
- The plan documents are committed.

### Not built

| Where | What is left | Finding |
|---|---|---|
| Phase 3 | The sampler still builds every device's view once a minute; it should sample from records and sessions, and pushing devices on change | J25 |
| Phase 3 | Package discovery through a manifest (`@kraftverk/packages`); the broker still walks the protocols folder itself | J31 |
| Phase 3 | Setup merges credential and method config fields by name; a collision is silent | J35 |
| Phase 4 | A role records the part, not the capability that filled it; `oneOf` is ambiguous at run time | J40 |
| Phase 4 | The P280 declares only its mains events: no overload or over-temperature, if its registers carry them | J22 (part) |
| Phase 5 | The `card` and recipe-editor slots, until a package needs them | — |
| Assistant | An API token for MCP clients (today a person's session cookie); a CI test against a local model | — |
| Phase 6 | `refines`; the Tuya profiles as refinements; reach shown on the add screen (the ATORCH's "no cloud" text still contradicts its `cloud-at-setup` reach) | — |
| Phase 7 | Packages from outside the repository; the SDK on npm; `npm create kraftverk-device`; a diagnostics bundle; `AGENTS.md` for packages; record-and-replay fixtures; the Home Assistant bridge; BTHome, Shelly, ESPHome | J38 (fixtures) |
| Phase 8 | `ARCHITECTURE.md` split into the design, `ROADMAP.md` and `DECISIONS.md`; the generated device table; published images; notifications; homes and roles | J39 |
| Phase 9 | The Matter spike | — |

### Next steps

**Zigbee, being hardened** ([PLAN-ZIGBEE.md](PLAN-ZIGBEE.md), 2026-10-07):
MQTT made sound for a bridge, the `zigbee2mqtt` integration (the coordinator,
a generic type per shelf, groups, pairing in the bridge contract), a device's
type changed with its history mapped, the deploy and the NUC's settings — all
built, tested against a played Zigbee2MQTT. On the NUC: the dongle up, the
SNZB-02P sensor and four S60ZBTPF plugs paired and added; every device's last
word kept by the holder (`device_reading`) and shown as it was after a
restart. Software updates built (§5.7, 2026-10-08): the four plugs run 1.0.2
and are offered 2.1.3 — update one first, watch it a few days (two report
0 V; a 2.0.2 once turned under-current protection on), then the rest. Left:
the wall switch, the NIU charger moved from its Tuya gateway; then §5.5's
next — device options, structured settings.

**Then the rest of [PLAN-RUN-AND-CHAIN.md](PLAN-RUN-AND-CHAIN.md)**: its
Phases 1 (fixes), 2 (the automation editor) and 3 (shared parts, the
reserve) are done; next, Phase 4, the language for import and export. The steps below follow it.

In this order, each small and each keeping the checks green:

1. **Finish Phase 3's findings.**
   - J25: the sampler reads records and sessions (a lean `DeviceRegistry.current()`) instead of building views, and samples pushing devices on change.
   - J35: refuse a setup whose credential and method fields collide.
   - J31: one package manifest for the server, the broker, `gen:devices` and the ratchet.
2. **J40.** A role binding records the capability that filled it.
3. **An API token for the assistant.** Scoped to `agent`, revocable, and audited as its own actor, so an MCP client does not carry a person's session.
4. **Phase 6.** Reach on the add screen, with the ATORCH's text fixed. Then `refines`, with the Tuya profiles as its first use.
5. **Phases 7–9, as the product needs them.** First the Home Assistant bridge from the projections and record-and-replay fixtures, then packages from outside the repository, then the documentation split.

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
Bun runs every test file in one process, sharing `platform/database.ts`'s module-level
handle and `process.env`. Each server suite set `KRAFTVERK_DB` in `beforeAll` and
cleared it in `afterAll`; the moment one file cleared it, the next file's
`beforeEach` — several begin `DELETE FROM device; DELETE FROM sample` — reopened
the real database and truncated it. It cost the owner four devices and ~28,000
samples. Since then the server keeps no database handle at all: the process
opens it once and hands it on, each test opens its own, and `openDatabase`
refuses the default path under `NODE_ENV=test`. **Do not reintroduce a shared
handle**: a suite that touches the database opens one of its own.

**`server/data/` is gitignored** and holds the development database. Deleting it
resets your devices, secrets and history — the fastest way back to a blank slate
when testing the add flow. Scratch files for one-off scripts go in
`server/data/scratch/`.

**Tamagui must stay a `peerDependency`** in `packages/ui` and every device
package. Two installed copies mean two theme contexts and silently broken
styling.

**Metro and npm need the workspace globs.** `packages/*` does not reach nested
package folders (`packages/integrations/*`, `packages/devices/*`, and the others ARCHITECTURE.md §3 adds);
each is listed in the root `package.json`. `client/metro.config.js` also stubs
optional native modules, which is what lets the app build without
`react-native-ble-plx` installed.

**`npm install --ignore-scripts` leaves a placeholder `bun.exe`.** Fix it with
`node node_modules/bun/install.js`.

**On the web a toggle is a real `<button role="switch">`** (`packages/ui/src/Toggle.tsx`):
no handler on a Tamagui view ever received a key — an `onKeyDown` prop, a
listener through the ref and `role="button"` were all tried — and a button gets
Tab, Space and Enter from the browser. Everything else is
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
npm run gen:devices          # regenerate every package's catalogue.json and the app's registry, after changing a package
npm run new:integration -- name           # start a platform and its protocol (new:transport too)
npm run new:device -- name integration     # start a product on one
npm run scan:tuya            # find Tuya plugs — no credentials needed
npm run keys:tuya            # fetch their local keys (scan a QR code with the Smart Life app)
```

The server runs on Bun; `scripts/run-bun.mjs` finds it even when PATH is stale.

## Waiting on the owner

- **The ATORCH's local key, and the questions in [`ATORCH-S1W.md`](ATORCH-S1W.md) §7**,
  settled on the unit: which of the two Tuya devices on the LAN is the plug, and
  which datapoint switches its relay.
- **Decisions the bug hunt of 2026-10-03 left open** — each a choice about
  trust, not a fix to make alone:
  - **A node's trust.** A phone or browser joins as a node of its account
    unasked; should a person confirm it in the app before it holds ways?
  - **A follower's caller.** What a node sends is taken as the node; should it
    be the signed-in person (`as(caller)`), so the timeline and the gateway's
    rules see who?
  - **A station on the broker.** Any client on the LAN may publish on a
    station's response topics: forged readings, a wrong toggle from them.
    Pinning a station to the client id it first came with stops that, and
    risks locking out the real one after a reset.
  - **The first account.** It is made from the home network, judged by the
    address; a forged `Host` on the plain port may pass. A one-time setup code
    printed in the server's log would close it.
  - **An assistant's credential.** An MCP client carries the session cookie;
    one of its own, revocable, would keep it apart from a person's.
  - **A Tuya plug's energy (DP 17).** Read at scale 2; Tuya's standard and the
    Zigbee plug's own README say 3 — ten times less. Unchecked on hardware.
  - **"Already so" from an old reading.** The gateway may judge a part already
    on from a reading up to a minute old, and send nothing.
