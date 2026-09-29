# kraftverk — project brief

## Purpose of this document

The complete hand-off brief for whoever works on this next. It describes what
exists, what has been learned, the owner's desired behaviour, the safety rules,
and a staged plan. Read it together with the [`README.md`](../README.md) and
[`P280-FINDINGS.md`](P280-FINDINGS.md) before changing code.

The project began as an app for one power station and is now a local energy
controller for **the devices you own**, with an AFERIY P280 as the reference
hardware and the only one verified against real firmware. Read the end-goal
section next; everything after it describes the station, the devices that work
with it, and the automation, in detail.

The goal, unchanged since the start:

- prove that every supported station setting can be read and safely changed;
- document every setting and its evidence on the actual P280, rather than trusting
  a register map from a related product;
- add a controllable upstream AC smart plug so the station can run household loads
  from its battery while it is normally connected to mains;
- use solar production and conservative weather/PV forecasts to reduce unnecessary
  AC charging, while never compromising a configured energy reserve.

This must be an open-source product that is useful with nothing but a station.
Smart plugs, weather services, electricity prices, Home Assistant and future
products are all **device types or services you add**, each one package (see
[`ARCHITECTURE.md`](ARCHITECTURE.md)). No feature may assume every user owns the
same ATORCH plug, uses SMHI, lives in Sweden, or wants automation enabled.

The owner is in Sweden and primarily uses the P280 at home. It is normally left
connected to mains AC. It has two 200 W solar panels (400 W nameplate); their
observed direct-sun peak is about 300 W.

---

## The end goal: devices you own, wired together

> **The authoritative target, vocabulary and implementation order are in
> [`ARCHITECTURE.md`](ARCHITECTURE.md), and the data model in
> [`DATA-MODEL.md`](DATA-MODEL.md).** This section states the product intent
> behind them, and agrees with them.

Three decisions settled with the owner, which the rest of the documentation must
not contradict:

**Who holds a connection decides what a device can do.** A device is reached
through one of the connection methods its type declares — for the P280, Wi-Fi
through the server's broker, or Bluetooth — and each connection is held either
by the server or by the app on a phone or in a browser. The same code runs in
either. Server-held connections are first class: only the server is running when
the app is closed, so only it can record history in the background and drive an
automation. A connection held by the app is a genuine way to *use* a device —
live readings, settings, manual control — and not diagnostics-only; while it is
held, its readings are recorded on the server if there is one. The app says
plainly what a phone-held connection cannot do while the phone is away.

**Services are devices without hardware.** Weather and price are added the same
way as a plug and expose telemetry and capabilities the same way, shown in a
section of their own.

**Root is always the canvas; every device also has its own address.** Opening the
app lands on *Your devices* regardless of how many you own, so the shape never
changes as you add the second. Each saved device has a stable route of its own,
so it can be bookmarked or pinned and opened directly.

### Vocabulary

The glossary is [ARCHITECTURE.md §2](ARCHITECTURE.md#2-vocabulary): **category**,
**device type** (a package that knows a product), **transport** (how bytes reach
a device), **protocol** (the language spoken over it), **connection method** (a
protocol over a transport, declared by a type), **device** (one thing you
added), **connection** (one way a device is reached, and who holds it),
**identity**, **service** (a device with no hardware), **capability**,
**telemetry**, **setting**, **setup**, **link** and **automation**. Adapter,
driver, provider, extension and grid relay are retired as names, and plugin is
never shown on screen.

Everything below this section describes the station and the devices around it. This section
describes what the whole thing is becoming, and every design decision should be read
against it.

### One noun: the device

The product is not "a P280 app with plugins". It is **your devices**, in one list, each
with its own screen, which you can connect to each other.

```
device type = a package that knows a product      "ATORCH S1W", "AFERIY P280"
device      = a thing you own, added and named    "Hallway plug", "Garage P280"
```

One device type serves any number of devices, and a device outlives its connection's
mood: unplug a plug for a week and it stays in the list, greyed, with its history
intact. Devices are **persisted in the database**, not derived from whatever happens
to answer a scan.

The station is a device. That is the load-bearing decision: the moment it is a special
case, every feature after it has to be built twice.

### Adding, renaming, removing, resetting

A device is something you deliberately **add**, and adding it is where the model gets
established. The flow, screen by screen, is [DATA-MODEL.md §1](DATA-MODEL.md):

1. **What kind** — a category: Power stations, Smart plugs, and among services, Weather.
2. **Which one** — a device type, with how well it is supported: verified on real
   hardware, reported working by others, or experimental. This is not cosmetic: the
   register map differs between models, and the app must not guess. A model nobody has
   verified is not offered.
3. **How it connects** — the type's connection methods, and who would hold the
   connection: for a station, Wi-Fi through your server, Bluetooth from your server, or
   Bluetooth from this phone or browser; for a plug, the home network.
4. **Setup for that method** — get it ready, choose it from what can be seen, give a key
   if it needs one, and check it answers. The check reads the device's own identity, so
   the same station found twice is recognised as one.

Full CRUD, with the destructive parts treated as destructive:

- **Rename** freely; the name is yours and survives the device renaming itself.
- **Remove** keeps the device's history: adding the same device again offers to bring it
  back. The warning names any automation that uses it — "Used by: Backup reserve"
  appears on the device screen so that is visible *before* the button is pressed.
- **Delete history** is separate, explicit and confirmed, because it cannot be undone.
- **Reset to a blank slate** — remove everything and start again, because a setup you
  cannot undo is a setup people are afraid to try.

### Each device brings its own UI

The current P280 screens — the energy-flow dashboard, the settings with their
model-specific charge-power steps, the register diagnostics — are **P280 UI**, not app
UI. They are excellent, and they are specific. So they belong with the thing they
describe, in the device type's own package:

```
packages/devices/aferiy-p280/ui/    station UI: dashboard, settings, protocol screens
packages/devices/atorch-s1w/ui/     plug UI, if the generic screens are not enough
client/                             the shell: device list, wiring, shared primitives
```

The app becomes a **shell**: it renders the device list, the wiring, and the generic
pieces (schema forms, charts, health, setup wizards) that every device gets for free. A
device with no UI of its own is fully usable through those generics; a device with UI
of its own takes over its detail screen.

Two rules keep this from becoming a loophole:

- **Compile-time only.** A panel ships in a release or it does not exist. No downloaded
  UI, ever — an iOS build must not fetch and execute code.
- **Data and callbacks, not privileges.** A device's own screen reaches the hardware
  through the same action gateway as everything else, with the same confirmation,
  dwell, freshness checks and two-stage verification.

### Wiring: Lego with typed studs

Once two devices exist, you connect them. First with **links** — facts about the house,
such as "this plug feeds that station's AC input", recorded once and read by everything
(ARCHITECTURE.md §4.4). Then with **automations**, in two tiers, because "make it
programmable" and "do not cut mains at 3am" pull against each other.

**Recipes** (curated, parameterised, the default) are whole behaviours the core
implements, with **roles** you fill with devices:

```
Backup reserve
  roles     station       ← needs battery + acInput                 [ Garage P280 ▾ ]
            feeding plug  ← needs switch, and a feeds link to it    [ Hallway plug ▾ ]
  settings  reserve 30 %   hard floor 15 %   start at 40 %
  state     OBSERVE — would have cut mains 12 minutes ago
```

The dropdowns only offer devices whose capabilities fit the role, so **an incompatible
piece cannot be connected**: the failure mode is a role you cannot fill, not an
automation that misbehaves at 3am. Every guard in this brief — dwell, hysteresis,
freshness, hard floor, two-stage verification, `GRID_UNAVAILABLE`, the arming checklist
— lives inside the recipe, in the core, not in user configuration. The reserve
controller is recipe #1. Later: *charge overnight when tomorrow is cloudy*, *avoid the
expensive hours*.

**Rules** (open, but on rails) cover the long tail in one sentence:

```
WHEN   [Hallway plug ▾] [power rises above ▾] [ 2000 W ]  for [ 60 s ]
AND    [Garage P280 ▾]  [battery is above ▾]  [ 50 % ]
THEN   [Hallway plug ▾] [turn off ▾]
       because "stop the kettle draining the pack"
```

Built from what devices declare — the first dropdown lists devices, the second their
telemetry, the last their capabilities' commands — as a phone-friendly sentence builder,
not a node graph. **A rule has no more power than you do**: its action goes through the
action gateway, dwell and freshness still apply, the physical effect is still verified,
and everything lands in the audit timeline. A rule that would breach the reserve or the
hard floor is refused at execution, with the reason shown against it. Rules start in
**dry run**; arming one that touches mains needs the same checklist as the controller.

*Why not just Home Assistant?* Because a Home Assistant automation cannot know that this
station's AC input must come back before the pack hits its floor, and cannot verify that
mains actually returned. The recipes encode knowledge that lives in
[`P280-FINDINGS.md`](P280-FINDINGS.md). Both tiers are optional; the station works with
neither.

### Where this stands

The status of every piece is kept in one place: the plan's table in
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-the-plan), with the findings it fixes in §6.
[`HANDOFF.md`](HANDOFF.md) says what is true right now and what has been learned the
hard way.

---

## Desired real-world behaviour

The P280 currently prefers AC/bypass power whenever its AC input is present. Thus,
after it is charged to (for example) 60%, connecting an output load does **not**
consume battery energy; it largely pulls from the wall.

The desired feature mimics EcoFlow’s *Backup Reserve* concept externally:

```text
Grid AC → ATORCH S1W smart relay/meter → P280 AC input
2 × 200 W solar panels                         → P280 solar/DC input
P280 AC/DC/USB outputs                         → household loads
```

1. When the P280 has sufficient SOC and is delivering a meaningful load, turn the
   ATORCH relay **off**. This removes AC input, so the P280 supplies the load from
   battery and any available solar.
2. Continue until the P280 reaches a user-selected reserve SOC.
3. Turn the ATORCH relay **on** at the reserve. The P280 can then return to its
   normal AC-input/bypass and AC-charging behaviour.
4. Solar and weather forecasts should help decide whether/when AC charging is
   needed, particularly overnight. They must never override real low-battery,
   stale-telemetry, fault, or relay-failure protection.

EcoFlow DELTA 2 documents the analogous logic: above a configured backup reserve,
AC input is disabled and battery/solar is used; below it, AC charging resumes.
This project cannot change P280 bypass priority internally, so it will reproduce
the policy by controlling the upstream AC input.

Important: removing P280 AC input can cause a transfer event. Do not test with
medical, heating, security, network, or other safety/availability-critical loads.
Test first with a small non-critical load.

---

## Current codebase

### Architecture

The packages, the rule for what may import what, and how a device type,
protocol or transport is added are in [ARCHITECTURE.md §3](ARCHITECTURE.md#3-packages-and-the-dependency-rule);
where each file lives today is in DEVELOPING.md's *Project layout*. Two properties
matter for everything in this brief:

- **One implementation of the protocol.** The server and the app run the same
  protocol and device-type code, so there is exactly one implementation of what
  a register means and which writes are safe, wherever the connection is held.
- **The station is the reference device, not a special case.** Its screens,
  its settings and its register tools belong to its own package.

Device names are the user's: the catalog stores whatever you rename a device to.
The owner calls this setup “F3” while the protocol research identifies the
hardware as an AFERIY P280 — which is exactly the split the catalog models. The
device type is the verified identity and decides how the thing is decoded; the
name is presentation.

### Existing capabilities

- A simulator for every device type, and the real P280.
- The P280 over Wi-Fi (a local MQTT broker the station is pointed at) and over
  Bluetooth, from the server or from the app.
- Polls all 80 input registers and all 80 holding registers.
- The register tools emit raw, hex, named and writable register data, take a
  baseline, and show what changed since it, enabling one-change-at-a-time
  discovery.
- `--read-only` / `READ_ONLY=1` blocks every hardware write at the station's
  client; blocked attempts are logged and shown.
- The station's settings are read and written per device, through its write
  whitelist.
- UI already exposes charge limit, discharge floor, charging options, sleep/standby,
  light and panel preferences.

### Protocol facts already evidenced

- Modbus slave address is `0x11`.
- Function `0x04`: input / telemetry registers; `0x03`: holding/settings reads;
  `0x06`: single holding-register writes.
- CRC-16/MODBUS is appended **high byte first**, unlike ordinary MODBUS RTU.
  A stock MODBUS library may silently fail without this correction.
- Requests must be serialised; there is no correlation ID.
- The device needs delay between writes. Current code uses 150 ms; BLE documentation
  suggests roughly 500 ms between writes.

### Known P280 register map

Treat the following as a starting point. The original map was largely derived from
Fossibot F2400/F3600 equipment; each setting must be re-verified on this P280.

Input (read-only) registers include:

- `3`: charging power W; `4`: DC/solar input W; `6`: total input W.
- `20`: AC output W; `21`: AC input voltage in tenths of V; `22`: AC input Hz.
- `39`: total output W; `41`: state bitmask; `48`: AC charging state.
- `56`: SOC in tenths of percent; `57`: AC charging booking minutes;
  `58`/`59`: time to full / empty.

Holding registers exposed as supported settings:

| Register | Intended setting | Allowed / current understanding |
| ---: | --- | --- |
| 20 | max DC charge current | 1–20 A |
| 24 | USB output | 0 / 1 |
| 25 | DC output | 0 / 1; firmware may toggle on every write |
| 26 | AC output | 0 / 1; firmware may toggle on every write |
| 27 | LED mode | 0–3 |
| 56 | key sound | 0 / 1 |
| 57 | silent AC charging | 0 / 1 |
| 59 | USB standby | 0, 3, 5, 10, 30 min |
| 60 | AC standby | 0, 480, 960, 1440 min |
| 61 | DC standby | 0, 480, 960, 1440 min |
| 62 | screen rest | 0, 180, 300, 600, 1800 sec |
| 63 | delay charging | 0–1440 min |
| 66 | discharge lower limit | 0–500; tenths of % (0–50%) |
| 67 | AC charging upper limit | 600–1000; tenths of % (60–100%) |
| 68 | whole-unit sleep | 5, 10, 30, 480 min only |

P280-specific candidates requiring confirmation:

- Holding `14` reads 1800 and is plausibly the P280’s 1800 W AC charge ceiling.
- Input `54` is plausibly battery temperature in tenths of °C.
- Input `47`, input `62`, and holding `11` are currently unknown flags.

### Non-negotiable station safety rules

1. **Never write `0` to holding register `68`.** It reportedly permanently bricks
   the station.
2. Never write an undocumented register.
3. Do not remove or weaken `WRITABLE`, Zod validation, or tests that reject unsafe
   values.
4. Never use the raw-frame tool to probe writes. It is deliberately an
   escape hatch and must remain disabled unless `ALLOW_RAW_FRAMES=1`.
5. Treat registers `25` and `26` as toggles until their behaviour is verified on the
   actual P280; do not assume writing `1` makes a port on idempotently.
6. Begin every unfamiliar-hardware session in `--read-only` mode.
7. Do not make output-port changes while important equipment is connected.

### Current gaps to fix

- ~~Hardware writes are not proven end-to-end against this P280.~~ **Done.**
  Confirmed against the real station in write mode over BLE: LED mode (27),
  AC output (26), DC output (25) and AC charge limit (67) all written from this
  codebase and observed to take effect. Registers 25/26 toggle behaviour remains
  untested, since the station client skips redundant writes.
- A write may be sent followed by a poll whose errors are swallowed, so the UI needs
  per-setting acknowledgement and explicit readback verification—not just cached state.
- The complete register catalog has not yet been evidenced on this device.
- ~~No smart-plug integration or history database exists yet.~~ **Partly done.**
  The Tuya local protocol, the action gateway and per-device history sampling
  are built; the plug itself is not yet commissioned, because that needs its
  local key (see [`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md)) and the open
  questions in [`ATORCH-S1W.md`](ATORCH-S1W.md) settled on the unit.
- No weather source, solar forecast, or automation state machine exists yet.
  The controller is designed but unwritten, and nothing may actuate on its own
  until the arming checklist below passes — including API authentication.

### System-level safety boundaries (required before automation)

This is the most important review addition. A software fail-safe cannot turn the
ATORCH relay on when the controller, router, Wi-Fi, Home Assistant, or the plug is
unreachable. Consequently, do **not** call the system fail-safe merely because it
requests AC ON; distinguish a confirmed restoration from an unconfirmed request.

Before unattended use, document and physically verify all of the following:

1. The computer/Raspberry Pi running this server, Home Assistant (if used), router,
   Wi-Fi access point, and DNS are powered independently of the P280 output, or have
   enough independent backup to remain online until AC has been restored. Avoid a
   circular design where a flat P280 turns off the controller that must restore its
   own AC charging input.
2. The S1W has a known and tested power-recovery relay state. Record whether it boots
   ON, OFF, or restores its previous state. A last-state/always-OFF device is not
   suitable for unattended battery-first operation without another recovery path.
3. There is a practical manual recovery path: accessible plug button, safe manual
   plug access, and a clear UI/emergency instruction. The owner must know it.
4. The P280’s physical discharge-lower-limit is deliberately set **below** the
   automation hard floor, leaving a recovery buffer. Example: P280 device lower
   limit 10%, automation hard floor 15%, normal reserve 30%. Verify the real P280
   behaviour before depending on it.
5. The server API is protected before it is allowed to control mains power.
   **Done:** accounts and sessions, a trusted-home-network rule decided by entrance
   rather than address, CSRF and DNS-rebinding defences, and a recovery CLI — see
   [SECURITY.md](SECURITY.md). Still true: never expose the server's own port or the
   MQTT broker through router port forwarding.
6. The controller cannot distinguish a grid outage from a failed relay solely from
   “P280 AC input absent.” Model and display this as `GRID_UNAVAILABLE` after relay
   ON is confirmed but P280 AC voltage does not return. Do not relay-cycle repeatedly
   during a real grid outage.

---

## Integrations: device types and services

Everything beyond the station is something you add as a device, from a package
of its own: a smart plug is a device type, a weather forecast is a service. How
they are built is [`ARCHITECTURE.md`](ARCHITECTURE.md); this section is what the
product requires of them.

### Product boundary

The core product is useful with **one station and nothing else**: live status,
safe settings, protocol diagnostics, history, and manual controls. Everything
else is optional, and each kind of thing is a category of device type or
service:

| Category | Examples | Offers | Can it act? |
| --- | --- | --- | --- |
| Power stations | AFERIY P280 | `battery`, `outlets`, `acInput`, settings | its own outlets and settings, through the gateway |
| Smart plugs | ATORCH S1W, other Tuya sockets; later Shelly, Tasmota | `switch`, `powerMeter` | switching, through the gateway |
| Weather (service) | Open-Meteo, SMHI, Forecast.Solar | `weather.forecast`, weather telemetry | no |
| Energy price (service) | Nord Pool, Tibber | a price forecast | no; it can only inform a recipe |
| Home automation | Home Assistant | whatever its entities are | only through the gateway, as any device |

The automation controller is the sole authority that decides whether an action
is safe. No device type may write raw MODBUS, switch anything outside the
gateway, or bypass the reserve, the hard floor or confirmation. Which plug feeds
the station is a **link** you record (ARCHITECTURE.md §4.4), not a choice of
"active provider": a recipe asks for "the plug that feeds this station", and the
gateway verifies every switch of it against that station's AC input.

### What ships with the app, and what does not

- **Device types are packages in this repository**, found by the server at
  start-up and built into the app. No code is downloaded at runtime, ever: an
  iOS build must not fetch and execute code.
- **Every type works without screens of its own.** Its setup, telemetry,
  controls and settings are declared, and the app renders them generically. A
  type may add its own screens — the P280's energy-flow dashboard — compiled
  into the release; their absence never stops a device from being added and
  used.

### Capability and safety model

Separate signals, recommendations, intents, and commands:

```text
device telemetry       → weather forecast / plug state / price / availability
recommendation         → "charge before 05:00" or "solar likely low tomorrow"
core policy decision   → checks reserve, hard floor, freshness, dwell, user mode
core command intent    → "restore grid AC", reason and required confirmation
capability command     → one typed command, through the gateway, verified result
```

Examples:

- A weather service can publish a forecast and its confidence, but has no
  capability that switches anything.
- A smart plug offers `switch`; a command to it is accepted only through the
  gateway, and switching a plug that feeds the station is verified by the
  station's AC input as well as the plug's own readback.
- A price service can recommend a cheap charging window, but the core refuses it
  if it violates the station's reserve or hard floor.

The first command to anything that switches mains needs a clear warning and an
explicit confirmation. Rules are validated again at execution time, not only
when configured, and every command is in the audit log.

### Automation modes and composition

Modes are owned by the core, not by any device type:

```text
Manual              Station monitor/settings only; no automatic external actions.
Observe             Devices report; the core produces recommendations; nothing switches.
Reserve             Battery-first / restore-grid behaviour using live station + plug data.
Reserve + Solar     Reserve mode; actual P280 solar can influence limited hold behaviour.
Forecast-aware      Reserve + Solar with a healthy weather service; conservative only.
Scheduled / Price   Optional future mode; needs a price service and all reserve guards.
```

For each mode, render a requirements checklist. Example: `Reserve` needs a
healthy smart plug linked as feeding the station; `Forecast-aware` additionally
needs a fresh weather service and enough calibration history. If requirements
disappear at runtime, degrade to the safest compatible mode — normally
`GRID_SUPPORT`, AC restored — never to an unknown state.

Several weather services may be added, for comparison; the user chooses which
one the forecast uses, and the core keeps the source on every prediction. They
are never silently blended or swapped.

### The first integrations

1. **The ATORCH S1W**, over the Tuya local protocol on the home network: no
   cloud at runtime, no Home Assistant in the path that restores mains. Its
   research and open questions are [`ATORCH-S1W.md`](ATORCH-S1W.md).
2. **A generic Tuya energy socket**, the same protocol with a profile per
   socket, so the next plug is data rather than code.
3. **Weather**: Open-Meteo first, because it works anywhere and needs no key,
   then SMHI, which is the owner's primary forecast (Stage 3 below).
4. **Home Assistant**, later: a protocol over `https`, so any entity it exposes
   can be added as a device with the same capabilities — proof that a new
   protocol needs no change to recipes or the gateway.

### Requirements for every device type and service

- a simulator, used by tests and by "try without hardware";
- the contract suite passing (ARCHITECTURE.md §7), plus offline, stale and
  error tests;
- its setup steps, including what must be done to the device first;
- a README: hardware or service prerequisites, what leaves the home network and
  where it goes, how to recover, and how to remove it;
- no secret in any config, export or log.

---

## Stage 1 — Establish a trustworthy station link

Do this before any write or automation work.

1. Run the server with `--read-only`.
2. Confirm discovery/binding and collect at least one hour of stable reads:
   no malformed frames, reconnect loops, unexplained timeouts, or stale values shown
   as live.
3. Improve diagnostics as necessary to display:
   - last successful input-register read and holding-register read;
   - transport errors, request/response timestamp, request hex, response hex;
   - cache age / freshness of every UI value;
   - exportable timestamped JSON/CSV register snapshots.
4. Add a local, append-only audit record for every attempted write:
   timestamp, user action, register, requested raw value, before value, frame/ack,
   after readback, duration, final result, error.
5. Never report success merely because a request was sent. A setting is *verified*
   only when its specified readback is received and matches.

Acceptance: a documented one-hour read-only session and clear diagnostics evidence.

---

## Stage 2 — Enumerate and prove every station setting

The aim is a register catalog based on this exact P280.

For each holding register `0…79`:

1. Take a baseline of *both* input and holding registers.
2. Classify it: documented writable, documented read-only, unknown, or dangerous.
3. Do not write unknown/dangerous registers.
4. For documented controls, change one thing in BrightEMS or from the P280 panel,
   then dump again. Record every changed input/holding register, raw/hex values,
   displayed value, scale/unit, side effects, and whether it survives a power cycle.
5. Add confidence: `verified`, `inferred`, `contradicted`, `unknown`, or `dangerous`.

For controlled writes, require explicit user approval before each physical test and
use this order:

1. Key sound (`56`).
2. Screen rest (`62`).
3. LED mode (`27`).
4. Silent AC charging (`57`).
5. AC charge limit (`67`) within 60–100%.
6. Discharge lower limit (`66`) within 0–50%.

For every approved write:

1. Read the current holding value directly.
2. Present the exact register/value and expected physical result to the user.
3. Send exactly one write and wait for its acknowledgement.
4. Read all holding registers again and require exact readback.
5. Confirm physical/app behaviour where applicable.
6. Store the evidence in the audit log and register catalog.
7. On timeout, mismatch, malformed/unrecognised ack, or inconsistent state: stop all
   remaining writes, mark it unverified, and show raw evidence.

Do not test AC/DC output toggles until everything above is stable and the owner has
confirmed no important loads are attached.

### Settings/API/UI completion criteria

- Define a single source of truth per setting: register, raw scale, UI unit, allowed
  values, safety level, confidence, last verification result and human explanation.
- `PATCH /api/settings` returns per-setting operation results: before, requested,
  acknowledgement, readback, verified/error. It does not merely return cached settings.
- UI shows pending / verified / failed / stale status.
- Unverified controls stay disabled by default with an explanation.
- Label holding register `67` accurately: it caps **AC charging only**; solar may
  charge beyond it, so it is not a global battery charge ceiling.

---

## ATORCH plug research and integration plan

### Exact hardware

The owner provided this listing:

> AC85-265V 16A Tuya WIFI Smart Socket Digital Wattmeter Electricity Consumption
> Power Kwh With Switch Power Energy Meter

The listing corresponds to the **ATORCH S1W Wi‑Fi** socket. It is a Tuya / Smart
Life 2.4 GHz device with an LCD meter and relay. Its meter reports voltage, current,
real power, energy (kWh), frequency and power factor.

There is an important rating discrepancy: marketing describes 16 A, whereas a reseller
specification for this S1W describes measurement up to 16 A but an **internal relay
rated at 10 A / 2650 W at 265 V**. Until the actual device label/manual establishes
otherwise, treat the relay as 10 A maximum. The P280’s claimed 1800 W AC input is
about 7.8 A at 230 V and therefore within that conservative figure, but the owner
must verify actual sustained draw and plug/outlet temperature.

The plug must be only upstream of the P280’s AC charger. Do not route P280 output
loads, extension strips, heaters, or other large loads through it.

### How it is reached

The S1W is the `atorch.s1w` device type, in the Smart plugs category. It offers
`switch` and `powerMeter`, and is reached by one connection method: the Tuya local
protocol over the home network, held by the server. The server talks to the plug
directly — no Home Assistant and no vendor cloud in the path that restores mains.

1. Pair the S1W in Tuya Smart or Smart Life on a dedicated **2.4 GHz** IoT SSID.
2. Get its local key once, through a free Tuya cloud project
   ([`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md)). The key is stored encrypted on the
   server, with the plug's connection, and never sent to a browser.
3. Add it in the app: Smart plugs → ATORCH S1W → found on the network → key → check.
4. The cloud is used only to fetch the key. It is never a control path: a cloud
   path is not local, and not outage-proof.

Do not guess Tuya datapoint ids. They vary by product and firmware, and two published
sources disagree about this plug's relay ([`ATORCH-S1W.md`](ATORCH-S1W.md)). The check
step reads every datapoint on the actual unit and records the relay, power, voltage,
current, energy and any protection datapoints, with their scale and unit.

### S1W discovery and acceptance checklist

Before an automated command is allowed:

1. Record exact model, serial/firmware, product ID, Tuya/Smart Life app, Home
   Assistant entities, DPs, local address and power-on relay behaviour.
2. Manually toggle the relay at least 20 times without critical load; every result
   must be observed and recorded.
3. Test after a brief power cut: does the relay boot on, off or restore last state?
   The application must model this explicitly.
4. With P280 and a small non-critical load, verify relay OFF removes P280 AC input
   and relay ON restores it—both with S1W measurement and P280 telemetry.
5. Test actual AC transfer interruption using a non-critical load.
6. During a normal charge cycle, observe S1W current, cable/outlet/plug temperature,
   and protection behaviour. Do not enable unattended switching if anything heats
   abnormally or input current approaches the conservative relay limit.

---

## Stage 3 — Telemetry history and solar/weather data

Build this before the controller. Use Bun SQLite and store one-minute samples:

- P280 SOC, total output W, AC output W, DC output W, solar input W, AC/grid input W,
  AC input voltage/frequency and charging state.
- S1W relay state, W, V, A, kWh, availability and last update.
- Automation state/mode/reason and every command/ack/readback.
- Weather/PV forecasts including their source and **issued-at** timestamp.

Store data in UTC; display Europe/Stockholm. Maintain raw recent data plus hourly/daily
aggregates. All data should be exportable to CSV/JSON.

### Solar configuration

Create a Solar settings schema/UI:

- latitude/longitude (server-side; explain privacy implications);
- timezone default `Europe/Stockholm`;
- nominal capacity: 400 W;
- observed practical peak: initially 300 W;
- number of panels: 2;
- tilt, azimuth (define south as 180°), and confidence level;
- optional shading notes: tree, roof/chimney, balcony, morning/evening obstruction.

Do not require perfect geometry: support `observed solar only` from P280 input telemetry
immediately. Require configuration before forecast-driven automation can be enabled.

### Weather and PV sources

Weather sources are services offering the `weather.forecast` capability
(`hourly(hours)`, ARCHITECTURE.md §4.1); a PV estimate is a second capability
alongside it when a source offers one. Keep external API details inside the
service, out of the control state machine.

**SMHI is the owner's primary forecast.** It is a weather service — a device type
in `packages/services` offering `weather.forecast` — against SMHI’s official SNOW
point-forecast API. (Open-Meteo is built first, because it works outside Sweden and
needs no key; the owner chooses SMHI as the forecast the controller uses.) This is not a vague lookup: it has a defined JSON
contract, reports all times in UTC, exposes `createdTime`/`referenceTime`, selects the
nearest forecast grid point, and forecasts roughly ten days ahead.

Endpoint shape (use the owner’s configured location):

```text
https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/
geotype/point/lon/{longitude}/lat/{latitude}/data.json
```

Use a reduced `parameters` query once it has been integration-tested. Request at least:

```text
cloud_area_fraction,
low_type_cloud_area_fraction,
medium_type_cloud_area_fraction,
high_type_cloud_area_fraction,
cloud_base_altitude,
air_temperature,
precipitation_amount_mean,
probability_of_precipitation,
symbol_code,
wind_speed
```

SMHI reports cloud cover in octas (0–8); normalise it to percent for the internal
weather model, preserve the raw values, and handle documented missing values. Do not
assume every forecast time step is hourly: the forecast interval expands farther into
the future. Persist `createdTime`, `referenceTime`, requested coordinates and returned
grid-point coordinates so revisions and forecast accuracy can be measured honestly.

Fetch with bounded cadence and jitter (for example, every 30 minutes), cache results,
and save a new forecast revision only when `createdTime` changes. Validate responses
with Zod; a malformed response is a stale/unavailable forecast, never an instruction
to change the relay.

SMHI SNOW's documented point-forecast parameter list is weather-oriented; it does not
by itself provide a ready-to-use, panel-plane PV watt forecast. Therefore use it in a
two-layer solar estimator:

1. Generate a clear-sky/seasonal baseline from PVGIS plus the system geometry, then
   cap it at observed physical behaviour (400 W nameplate, about 300 W observed peak).
2. Use SMHI’s total/low/medium/high cloud cover, precipitation and weather symbols as
   inputs to a *locally calibrated and conservative* attenuation model. Train it only
   from stored P280 solar telemetry and retain a large uncertainty margin.
3. Until there is enough data, SMHI affects display and forecast confidence only; it
   cannot defer a required AC recharge.

`Forecast.Solar` can be added later as an independent PV forecast for comparison. Do
not silently substitute one source for another: show which service and estimator
produced each estimate, and compare forecasts against measured solar before trusting
any of them. Open-Meteo also offers radiation data, useful as a second opinion.

PVGIS remains for commissioning and long-term/seasonal expectation—not for the
immediate relay decision. It estimates hourly PV production using site/orientation and
radiation databases but is not a guarantee of tomorrow’s local cloud behaviour.

Cache/rate-limit all API requests. Forecast fetch failures must be non-fatal and must
reduce confidence rather than cause unsafe behaviour.

### Forecast calibration

At each hour, compare the forecast that existed *before* the hour started with the
integrated actual P280 solar Wh. Store error Wh and percent, rolling daily/7-day bias,
absolute error, and optionally error by hour/month/cloud category.

Start conservative:

```text
usableForecastWh = max(0, forecastWh × conservativeFactor − uncertaintyMargin)
```

Initial `conservativeFactor = 0.60`. Require at least 14 days of local history before
auto-calibration; do not let learning become more optimistic than observed physical
performance without review. Surface green/amber/red forecast confidence. When red
(missing/stale/poor recent accuracy), disable forecast-driven optimisation but keep
the hard safety controller working.

Weather is most valuable for **overnight grid-charge planning**. It is not the right
input for minute-by-minute safety switching: actual P280 solar watts are more reliable
than a cloud forecast, particularly for a 300 W observed peak system.

---

## Stage 4 — Energy budget and automation

### Separate user concepts

Do not overload P280 `AC_CHARGING_UPPER_LIMIT` / “AC charge limit.” It is an
AC-only device setting and solar can pass it.

The controller needs separate values:

- `hardFloorSOC`: absolute safety boundary, safely above P280 shutdown.
- `reserveSOC`: normal threshold at which AC is restored.
- `batteryStartSOC`: SOC above reserve required before battery-first begins.
- `gridRechargeTargetSOC`: desired SOC when AC has been restored.
- `forecastReserveWh`: optional extra retained energy when poor weather is forecast.
- `minimumLoadW`, `sustainedLoadDuration`.
- `minimumPlugOnDuration`, `minimumPlugOffDuration`.
- manual override and weather-optimisation enablement.

Suggested cautious defaults: hard floor 15%, reserve 30%, start battery-first 40%,
load 20 W sustained for 60 seconds, hysteresis of at least 5 SOC points, and at least
10 minutes between plug changes.

The values must be validated as a relationship, not independently:

```text
P280 physical discharge lower limit < automation hard floor < reserve SOC < battery-start SOC
P280 AC charging upper limit ≥ grid-recharge target SOC
```

Reject or clearly warn about any configuration that breaks this relationship. The
controller should normally restore AC at reserve, well before the P280's own output
cut-off; the lower device limit is only a last-resort guard.

### Energy budget

For rest of day, overnight, tomorrow morning and next 24 h calculate:

- usable battery Wh: `capacityWh × max(0, SOC - hardFloor) / 100`;
- reserve energy and projected SOC at sunrise/noon/sunset;
- load projection from configurable recent median/percentile or user-provided fixed
  essential load; never infer from one minute;
- conservative expected solar Wh;
- AC energy needed to avoid crossing hard floor/reserve before the next viable solar
  period.

Show the assumptions, not just an opaque result.

### Explicit automation state machine

```text
DISABLED       No automatic plug control.
OBSERVE        Calculate and log recommendations; never switch.
BATTERY_FIRST  S1W OFF; P280 runs from battery / real-time solar.
GRID_SUPPORT   S1W ON; P280 can bypass/charge from AC.
FORECAST_HOLD  Limited extension of battery mode due to actual solar surplus.
MANUAL_AC_ON   User-requested grid restoration; controller cannot turn it off.
FAILSAFE       Fault/stale telemetry/control failure; request AC ON and stop switching.
GRID_UNAVAILABLE  Relay is confirmed ON but grid/P280 AC input has not returned.
```

`BATTERY_FIRST` entry requires all of:

- fresh P280 telemetry and confirmed fresh S1W state;
- SOC at/above `batteryStartSOC`;
- P280 output exceeds `minimumLoadW` continuously for the configured duration;
- S1W currently on, no fault/manual override/cooldown, and minimum on-dwell elapsed.

Return to `GRID_SUPPORT` if any of:

- SOC reaches `reserveSOC`;
- projected SOC reaches hard floor before a viable solar window;
- telemetry is stale, station faults, S1W is unavailable, command/readback fails;
- user selects “Restore AC now”; maximum allowed off duration expires.

`FORECAST_HOLD` is deliberately restricted. It may delay AC restoration only while
**actual** solar input exceeds output by a configured margin for a sustained period,
SOC remains above hard floor plus buffer, and a timeout has not elapsed. Forecast alone
must not keep AC off below reserve.

Every relay transition must:

1. audit intent/reason;
2. issue one relay command;
3. confirm S1W relay state;
4. verify P280 AC-input telemetry changes in the expected direction before timeout;
5. audit verified/failed final evidence;
6. enter `FAILSAFE` after an unverified action.

On process start/restart, take no automatic relay action until both current S1W state
and fresh P280 telemetry are known. If AC was last known off and communications are
unavailable, show a prominent alert: software cannot guarantee AC restoration without
reachability to the plug.

Never automatically retry an unverified OFF transition. For an ON transition, use a
bounded retry policy only after checking dwell time and command history, then enter
`GRID_UNAVAILABLE`/`FAILSAFE`; never create a relay-cycle loop. The event record must
distinguish `AC restoration requested`, `S1W ON confirmed`, and `P280 AC present
confirmed`.

### Weather-aware policy

Start with recommendations only:

- “Tomorrow’s conservative solar estimate is X Wh; grid charging can likely wait until
  [time], subject to reserve.”
- “Poor forecast: retain/start grid support overnight to reach target SOC.”
- “Observed solar materially below forecast: reduce confidence; do not defer grid
  charge based on forecast.”

Only after 7–14 days of observe-mode evidence and at least 14 days of local forecast
calibration, permit an opt-in conservative policy:

- poor next-day forecast → charge from AC overnight to `gridRechargeTargetSOC`;
- strong next-day forecast → avoid unnecessary overnight AC charging but guarantee
  the configured morning reserve/hard floor;
- missing/poor forecast → restore grid by a user-configurable latest safe charge time;
- battery at/below reserve → restore AC regardless of forecast.

---

## UI, operational safety and acceptance

### Energy-flow dashboard — polished, physical and truthful

The Energy page should feel like a premium power-station display, not a collection of
generic cards. Build a custom responsive flow diagram in the shared Expo codebase,
preferably with SVG paths plus a native/web-compatible animation layer. Do not create
separate visual logic for iOS and web. The animation must be driven by live telemetry,
not decorative guesses.

Layout concept:

```text
       Solar panels ────────┐
                             ├──▶  [ P280 battery ] ───▶ [ AC / DC / USB outlets ]
       Grid / ATORCH ───────┘                 │
                                               └── SOC, time, state
```

Use real directional paths and small animated particles/light pulses, like water or
electrons flowing through pipes:

- solar → battery/outlets only when measured P280 solar/DC input is meaningful;
- grid → battery when AC charging is evidenced;
- grid → outlets when AC bypass is evidenced;
- battery → outlets when output exceeds input and SOC is falling;
- solar → outlets/battery may coexist with battery → outlets; show concurrent paths
  rather than pretending there is only one source;
- no flow animation when the corresponding data is zero, stale, unknown or merely
  forecast. A muted line and “Waiting for live data” is more trustworthy.

Give each path a stable semantic colour and label; never rely on colour alone:

- solar: warm yellow;
- grid/AC: cool blue;
- battery discharge: green/teal flowing outward;
- battery charging: green/teal flowing inward;
- unavailable/fault: muted grey or restrained warning colour.

Each active path must have a nearby readable value, for example `Solar 214 W`,
`Grid 0 W — relay off`, `Battery −86 W`, `AC outlets 84 W`. The sign convention
must be defined once and used throughout the app. When P280 telemetry cannot separate
bypass power from charging power with confidence, label the flow as estimated and show
the raw source (`P280` or `ATORCH`) used for it.

The central battery should show SOC, charge/discharge direction, estimated time remaining
when known, configured reserve/hard-floor markers, and current control state. Make the
reserve marker visually distinct from the device’s physical discharge limit and AC
charge ceiling. Tapping any source/path should open a compact explanation: latest raw
values, timestamp, whether it is measured/estimated/forecast, and the automation reason.

Motion-quality and accessibility requirements:

- interpolate values gently but never fabricate readings; update at telemetry cadence;
- particle speed/intensity scales with watts, with a sensible visual cap;
- respect OS reduced-motion preference: replace travelling particles with static arrows
  and numerical changes;
- maintain text contrast and non-colour status indicators; screen-reader labels must
  describe source, direction, watts, freshness and relay state;
- preserve smooth interaction on mid-range iPhones and browsers: pause/off-screen
  animations, avoid expensive re-renders, and use one shared animation clock;
- include a compact mobile layout and an expanded desktop layout;
- include skeleton, offline, stale-data and simulator states designed intentionally.

Below the live flow, show a calm 24-hour timeline: actual solar/grid/load energy to the
left of now, SMHI-based conservative forecast to the right, and projected SOC with an
uncertainty band. Clearly separate measured history from forecast using labels and line
styles, not just colour.

Create a dedicated Energy page with:

- SOC, reserve, hard floor, recharge target;
- live P280 load, solar input, grid input and S1W relay state;
- 24-hour actual/forecast solar energy chart with confidence band;
- projected SOC with/without conservative forecast solar;
- plain-language automation state/reason, next planned decision and cancellation reason;
- Dry run, Observe only, Enable automation, Restore AC now, Manual battery mode;
- event timeline and CSV/JSON export.

Every decision must be explainable. Example:

> AC remains disconnected: SOC 56%, reserve 30%, output 84 W, actual solar 210 W,
> next three-hour conservative solar estimate 430 Wh.

or:

> AC restored: SOC 29.8% reached the 30% reserve; ATORCH relay and P280 AC input
> were both verified on.

Required tests:

- setting write acknowledgement/readback/failure handling;
- threshold, hysteresis and dwell-time boundaries;
- stale/missing weather, P280 telemetry and plug data;
- forecast over- and under-prediction;
- cloud changes/daylight/overnight scenarios;
- intermittent low load;
- S1W unavailable/command failure/state mismatch;
- P280 fault and server restart with plug on/off;
- manual override/emergency restore; no relay chatter.
- controller/router outage while S1W is OFF;
- S1W reboot and Wi-Fi reconnect while OFF and while ON;
- actual grid outage while S1W is ON (must become `GRID_UNAVAILABLE`, not cycle);
- wrong/missing time zone and daylight-saving transition;
- P280 inverter idle consumption and SOC/capacity error margins.

Physical acceptance before unattended automation:

1. Observe mode for at least 7–14 days.
2. Review forecast-versus-actual solar daily.
3. Test every state transition using non-critical load only.
4. Confirm AC restoration in both P280 telemetry and S1W measurement.
5. Verify plug temperature/current over normal P280 charging.
6. Start unattended operation with conservative defaults only after the audit log shows
   stable operation.
7. Perform an explicit recovery drill: intentionally leave the S1W OFF, restart every
   controller component, then prove the system either restores and verifies AC or
   clearly requires the documented manual recovery path.

---

## Interface design direction

The Dashboard is now built around a live **energy-flow diagram**, which is the
signature element of this product category — EcoFlow, Lunar Energy and MYGRID all
centre on one, and usability research on MYGRID found the flow chart and the
headline value were what users returned to several times a day.

Current implementation (`packages/devices/aferiy-p280/ui/energy-flow.tsx` — it
belongs to the device, because none of it generalises to a plug or a forecast):

- sources feed the battery from above, loads draw from below;
- each active path animates a dashed stroke toward the ring or away from it, so
  direction reads without arrowheads;
- dash speed scales with wattage, so a trickle and a fast charge look different;
- idle paths stay drawn but dim, keeping the topology stable as ports switch;
- the state-of-charge ring springs to new values, and wattages ease between
  readings rather than snapping, because 2-second telemetry otherwise flickers.

### Next interface work, in order of value

1. **Charge-limit and reserve markers on the ring.** Show the AC charge limit as a
   tick, and shade the region below the automation hard floor. The reserve concept
   is what this whole project is built around and it is currently invisible.
2. **Tap a node to drill in.** Tapping AC should expand voltage, frequency and
   per-port detail in place, rather than that living in a separate card further
   down the page.
3. **History sparklines.** Once telemetry is logged to SQLite, put a 24-hour SOC
   curve under the ring, and input/output history behind the flow tiles.
4. **The feeding plug in the flow.** When a plug is linked as feeding the station, the grid path
   needs a third visual state — connected, disconnected by automation, and
   unavailable — because "no AC input" means something very different in each.
   Do not render an automation-driven disconnect the same as a power cut.
5. **Light theme pass.** Only dark has been reviewed.
6. **Motion accessibility.** Respect `prefers-reduced-motion`; the flow animation
   should degrade to a static directional indicator rather than stopping dead.
7. **Device-first testing.** The animation has only been judged in a desktop
   browser. It has to feel right on a phone, which is where it will be used.

Keep the Dashboard station-first. Forecast, price and plug devices may add small
badges, but their setup and settings belong on their own device pages.

## Research links

- Existing project protocol sources: see `README.md`.
- [EcoFlow DELTA 2 App User Manual — Backup Reserve](https://websiteoss.ecoflow.com/cms/upload/2023/8/29/EcoFlow%20DELTA%202%20-%20App%20User%20Manual%20V1.0_1693295643575.pdf)
- [ATORCH S1W manual / product identification](https://device.report/m/0f4c63795525e741cd5ec2098faecbcdc8e00882380fe744b53d6516a9130932)
- [S1W reseller specification — includes 10 A relay statement](https://fr.sdtek.com/e/120701-6555723/)
- [Tuya data-point documentation](https://developer.tuya.com/en/docs/iot-device-dev/bluetooth_software_map_bt_dp_data?id=Kcmeae40r8zdq)
- [LocalTuya setup documentation](https://xzetsubou.github.io/hass-localtuya/usage/configure_add_device/)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Forecast.Solar API](https://forecast.solar/)
- [SMHI SNOW point-forecast API](https://opendata.smhi.se/metfcst/snow1gv1/get_point_forecast)
- [SMHI SNOW parameter catalog](https://opendata.smhi.se/metfcst/snow1gv1/parameters)
- [European Commission PVGIS API](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en)
- [Open-Meteo forecast API fields](https://open-meteo.com/en/docs)

## Definition of done

The work is complete only when:

1. Each supported P280 setting is backed by real-P280 write/readback evidence and has
   clear UI status.
2. The P280 and S1W integration has an auditable, verified, safe control path.
3. Automation is off by default, explainable, hysteretic and fails safely.
4. Weather/PV forecasts are calibrated from real solar telemetry, treated
   conservatively, and never used to violate battery safety thresholds.
5. The owner can understand current state, expected behaviour, data freshness and the
   exact reason for every relay action.
6. The independent-power, recovery-path, API-security and grid-outage acceptance
   checks above have passed; a mere software request to turn AC on is not accepted as
   proof that mains was restored.
7. A second device — the plug, and later a weather source — is added, used and
   wired to the station **without a screen being written for it**. That is the
   test of whether the device model is real: if adding one still needs bespoke
   UI, the abstraction has not earned its keep.
