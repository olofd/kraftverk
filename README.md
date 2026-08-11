# Aferiy Powerstation

Monitor and control an **AFERIY P280** portable power station from iOS and the
browser — locally, without the vendor cloud.

- **`client/`** — Expo app (React Native + react-native-web), Tamagui, expo-router. One codebase, iOS + web.
- **`server/`** — Hono API on Bun that speaks the station's native protocol over Wi-Fi or Bluetooth.

---

## Table of contents

1. [What we're talking to](#what-were-talking-to)
2. [How the protocol works](#how-the-protocol-works)
3. [The register map](#the-register-map)
4. [Safety — read before writing registers](#safety--read-before-writing-registers)
5. [Architecture](#architecture)
6. [Getting started](#getting-started)
7. [Connecting over Wi-Fi](#connecting-over-wi-fi)
8. [Connecting over Bluetooth](#connecting-over-bluetooth)
9. [API reference](#api-reference)
10. [Verifying the map against your unit](#verifying-the-map-against-your-unit)
11. [What's verified vs. inferred](#whats-verified-vs-inferred)
12. [Project plan](#project-plan)
13. [Sources](#sources)

---

## What we're talking to

### The hardware

**AFERIY P280** (sold as "Haven2800" in some regions):

| Spec | Value |
| --- | --- |
| Capacity | 2048 Wh LiFePO₄, expandable to 10.24 kWh (up to 4 × P280-B packs) |
| AC output | 2800 W continuous, 5600 W peak, pure sine wave |
| AC input | up to 1800 W (0→80 % in ~55 min) |
| Solar input | up to 1200 W, dual MPPT |
| UPS switchover | < 10 ms |
| Ports | 13 total (AC, USB-A, USB-C, 12 V DC, car) |
| Cycle life | 4000+ cycles to ~80 % capacity |

### The software stack

**Aferiy does not write its own firmware stack.** It rebadges **Sydpower**, the
platform also behind **Fossibot**, **Eco Play** and **ABOK Power**. That's why a
single vendor app — **BrightEMS** (`com.sydpower.app`) — drives all of them, and
why reverse-engineering work done against a Fossibot F2400 transfers to a P280.

This matters practically: when searching for help, search for **Sydpower** and
**Fossibot**, not Aferiy. Almost all the useful material is filed under those.

### How BrightEMS actually connects

Traced by the community using an HTTPS MITM proxy against a rooted Android phone:

1. The app authenticates to `api.app.sydpower.com` and fetches the user's device list.
2. Both app and station connect to an MQTT broker at **`mqtt.sydpower.com`**
   (port 1883, or 8083 for WebSocket). The station obtains its own MQTT
   credentials from the cloud.
3. All monitoring and control then flows as **MODBUS frames published as MQTT
   messages** — the cloud is just a message relay.

That last point is the whole opportunity: because the cloud is only relaying,
redirecting DNS for `mqtt.sydpower.com` to a local broker gives you complete
control with no credentials and no internet round-trip.

---

## How the protocol works

The station is a **MODBUS RTU slave at address `0x11`**, reachable through
either an MQTT bridge or a BLE GATT service. Both transports carry
**byte-identical frames**, which is why this project shares one codec and one
register map across both.

### Function codes

| Code | Meaning | Direction |
| --- | --- | --- |
| `0x03` | Read holding registers (settings) | request → response |
| `0x04` | Read input registers (telemetry) | request → response |
| `0x06` | Write single holding register | request → echo |

An exception sets the high bit of the function code in the reply (e.g. `0x86`).

### Frame layout

```
[0x11] [fn] [start hi] [start lo] [count hi] [count lo] [CRC hi] [CRC lo]
```

Read responses **echo the start address and count** before the data, rather than
sending a plain byte count as standard MODBUS RTU does:

```
[0x11] [0x04] [start:2] [count:2] [80 × uint16 big-endian] [CRC:2]   = 168 bytes
```

### ⚠ The CRC is big-endian

CRC-16/MODBUS — init `0xFFFF`, reflected polynomial `0xA001`, no final XOR — but
appended **high byte first**. This is *not* what the MODBUS spec says (RTU
transmits the CRC low byte first).

Verified three independent ways:

| Frame | CRC value | Bytes on the wire |
| --- | --- | --- |
| `110400000050` (read 80 input registers) | `0xA6F2` | `a6 f2` |
| `1106003f003c` (defer charging 60 min) | `0x47BB` | `47 bb` |
| 168-byte telemetry response | `0xDFB5` | `df b5` |

**A stock MODBUS library will byte-swap this and the device will silently drop
every frame.** This is the single easiest way to waste a day on this protocol.
Locked down by tests in `server/src/protocol/modbus.test.ts`.

### MQTT topics

Keyed by the device MAC (12 uppercase hex chars, on a sticker or in BrightEMS):

| Topic | Purpose |
| --- | --- |
| `{MAC}/client/request/data` | Requests are published here |
| `{MAC}/device/response/client/04` | Telemetry (retained; auto-pushed every 60 s) |
| `{MAC}/device/response/client/data` | Settings reads and write acknowledgements |
| `{MAC}/device/response/state` | `0x30` = shutdown, `0x31` = reconnect |

### BLE GATT

Same frames, written to one characteristic and received as notifications on
another. No handshake — start reading immediately after connecting.

Two UUID layouts are documented and sources disagree on which model uses which,
so this project probes both:

| Layout | Service | Write | Notify |
| --- | --- | --- | --- |
| A | `a002` | `c304` | `c305` |
| B | `fff0` | `fff2` | `fff1` |

Notifications are fragmented at the BLE MTU (23 bytes by default), so a 168-byte
response arrives across ~8 packets and must be reassembled. Leave **~500 ms
between writes** or the device throws GATT errors.

---

## The register map

### Input registers — `0x04`, read-only telemetry

| Reg | Name | Unit |
| --- | --- | --- |
| 2 | AC charging rate | config 1–5 |
| 3 | Charging power | W |
| 4 | DC/solar input power | W |
| 6 | Total input power | W |
| 9 | DC output power | 0.1 W |
| 15 | LED power | 0.1 W |
| 18 | AC output voltage | 0.1 V |
| 19 | AC output frequency | 0.1 Hz |
| 20 | AC output power | W |
| 21 | AC input voltage | 0.1 V |
| 22 | AC input frequency | 0.01 Hz |
| 25 | LED state | 0=off, 1=on, 2=SOS, 3=flash |
| 30–31, 34–37 | USB port power | 0.1 W each |
| 39 | Total output power | W |
| 41 | Status bitmask | see below |
| 48 | AC charging state | `0x8000` = charging |
| 53, 55 | Expansion pack SOC | 0.1 % |
| 56 | State of charge | 0.1 % |
| 57 | AC charging booking | minutes |
| 58 | Time to full | minutes |
| 59 | Time to empty | minutes |

### Status bitmask — register 41

| Mask | Meaning |
| --- | --- |
| `0x1000` | LED on |
| `0x0800` | AC output on |
| `0x0400` | DC output on |
| `0x0200` | USB output on |
| `0x0080` | DC converter active |
| `0x0060` | DC/solar input connected |
| `0x0010` | Charging from AC |
| `0x000A` | AC input connected — **corrected, see below** |

> **Correction to the published map.** Sources give `0x000E` for "AC input
> connected". Bit 2 is set on a station that is demonstrably running on battery:
> in a captured frame with status `0x0804`, the AC input reads 1.3 V at 0 Hz,
> register 48 is `0x4000` (not charging), and the pack is draining with 641
> minutes left. Bit 2 tracks something else — most likely the inverter, which is
> on in that same frame. This project masks `0x000A` and corroborates against AC
> input voltage. Covered by a regression test.

### Holding registers — `0x03` read / `0x06` write

| Reg | Name | Permitted values |
| --- | --- | --- |
| 13 | AC charging rate | read-only |
| 20 | Max DC charging current | 1–20 A |
| 24 | USB output | 0, 1 |
| 25 | DC output | 0, 1 — *toggle bug* |
| 26 | AC output | 0, 1 — *toggle bug* |
| 27 | LED mode | 0, 1, 2, 3 |
| 56 | Key sound | 0, 1 |
| 57 | AC silent charging | 0, 1 |
| 59 | USB standby | 0, 3, 5, 10, 30 min |
| 60 | AC standby | 0, 480, 960, 1440 min |
| 61 | DC standby | 0, 480, 960, 1440 min |
| 62 | Screen rest | 0, 180, 300, 600, 1800 s |
| 63 | Delay charging | 0–1440 min |
| 66 | Discharge floor | 0–500 (0.1 %) |
| 67 | Charge limit | 600–1000 (0.1 %) |
| 68 | Idle shutdown | 5, 10, 30, 480 min — **never 0** |

---

## Safety — read before writing registers

**Writing `0` to holding register 68 permanently bricks the station.** Not a
soft-lock; the device does not come back.

Three independent guards, all of which must stay in place:

1. `WRITABLE` in `server/src/protocol/registers.ts` — whitelists exact permitted
   values per register. Anything else is refused before a frame is built.
2. The zod schema in `server/src/types.ts` — `sleepMinutes` cannot be 0.
3. A regression test asserting the write is refused.

Registers **not** on the whitelist cannot be written at all. Community reports
say writing undocumented registers has damaged hardware.

`POST /api/diagnostics/raw` bypasses every check by design, for protocol work.
It is disabled unless `ALLOW_RAW_MODBUS=1`.

**Known firmware bug:** registers 25 and 26 *toggle* on any write instead of
honouring the value. The driver reads current state first and skips redundant
writes.

---

## Architecture

```
┌──────────────┐   HTTP    ┌──────────────────────────────┐
│ Expo client  │──────────▶│ Hono API (Bun)               │
│ iOS + web    │           │                              │
└──────────────┘           │  DeviceDriver                │
                           │      │                       │
                           │  Transport (interface)       │
                           │   ├── MqttTransport ──┐      │
                           │   └── BleTransport ───┤      │
                           │                       │      │
                           │  protocol/modbus  ────┤      │
                           │  protocol/registers ──┘      │
                           └───────────┬──────────────────┘
                                       │ identical MODBUS frames
                          ┌────────────┴────────────┐
                          ▼                         ▼
                  embedded MQTT broker         BLE GATT
                     (port 1883)              (noble)
                          │                         │
                          └────── AFERIY P280 ──────┘
```

The key decision: **both transports live on the server.** BLE therefore works
from iOS and the browser through the same HTTP API, with no native modules in
the app and no custom Expo dev build.

---

## Getting started

### Prerequisites

- **Node 20.19+** (22 or 24 recommended) — Expo and Metro
- **Bun** — `winget install Oven-sh.Bun`
- **You cannot run the iOS Simulator on Windows.** iOS testing happens on a
  physical iPhone via **Expo Go** on the same Wi-Fi network.

### Install

```bash
npm install
```

```bash
npx expo install --fix --project-root client
```

### Run

Simulator, no hardware needed:

```bash
npm run dev
```

Real station over Wi-Fi:

```bash
npm run dev:device
```

Real station over Bluetooth:

```bash
npm run dev:ble
```

Web opens at `http://localhost:8081`. For iOS, run `npm start` and scan the QR
code with the Camera app — the app resolves the API host from Expo's dev-server
address, so it finds this machine over the LAN automatically.

---

## Connecting over Wi-Fi

1. Start with `npm run dev:device`. The server listens for MQTT on `:1883`.
2. Redirect the vendor hostnames to this machine (router DNS or Pi-hole):

   ```
   mqtt.sydpower.com                ->  <this machine's LAN IP>
   pro.emqx1-cluster1.sydpower.com  ->  <this machine's LAN IP>
   ```

3. Power-cycle the P280 so it re-resolves DNS.
4. Open the **Devices** tab. The station appears as soon as it publishes and is
   bound automatically; the binding persists to `server/data/binding.json`.

**The station still needs internet on first connect** — it fetches MQTT
credentials from the Sydpower cloud before connecting. Only the MQTT traffic is
redirected. The embedded broker accepts any credentials, because they're issued
by the vendor and can't be predicted. **Bind it to your LAN, never the internet.**

Windows Firewall usually blocks the inbound connection:

```bash
netsh advfirewall firewall add rule name="Aferiy MQTT" dir=in action=allow protocol=TCP localport=1883 profile=private
```

---

## Connecting over Bluetooth

```bash
npm run dev:ble
```

The server scans for stations advertising a known name pattern
(`FOSSIBOT`, `AFERIY`, `SYDPOWER`, `POWER`, …), connects, probes both GATT
layouts, and subscribes to notifications.

Requires a Bluetooth adapter on the server machine, and the station within
roughly 10 m.

---

## API reference

Base URL: `http://<host>:3333/api`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/version` | Name, version, runtime, uptime, link mode |
| `GET` | `/status` | Live telemetry |
| `GET` `PATCH` | `/settings` | Read / update station settings |
| `POST` | `/ports/:id` | Toggle `ac` \| `dc` \| `usb` \| `led` |
| `GET` | `/devices` | Discovered stations and current binding |
| `POST` | `/devices/bind` | Bind a station by id |
| `POST` | `/devices/unbind` | Release the binding |
| `GET` | `/diagnostics/link` | Transport and broker state |
| `GET` | `/diagnostics/traffic` | Recent frames as hex |
| `GET` | `/diagnostics/registers` | Full register dump, raw and named |
| `POST` | `/diagnostics/raw` | Arbitrary frame — needs `ALLOW_RAW_MODBUS=1` |

### Environment and flags

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `STATION_DRIVER` | `--driver=` | `sim` | `sim` \| `device` \| `ble` |
| `DEVICE_ID` | `--device=` | — | Bind this station instead of auto-binding |
| `AUTO_BIND` | — | `1` | `0` requires an explicit bind |
| `PORT` / `HOST` | — | `3333` / `0.0.0.0` | HTTP API |
| `MQTT_PORT` / `MQTT_HOST` | — | `1883` / `0.0.0.0` | Embedded broker |
| `ALLOW_RAW_MODBUS` | — | — | `1` enables `/diagnostics/raw` |
| `DEBUG_LINK` | — | — | Log transport poll failures |

---

## Verifying the map against your unit

The published map was derived largely from **Fossibot F2400/F3600** hardware.
The P280 is the same stack but a bigger machine — 1800 W AC input vs 1100 W —
so some scaling may differ.

The **Protocol** tab dumps all 80 input and holding registers with raw value,
hex, and documented name. Compare against BrightEMS and adjust
`server/src/protocol/registers.ts`.

Handy manual frames (via `/api/diagnostics/raw` with `ALLOW_RAW_MODBUS=1`):

| Purpose | Frame |
| --- | --- |
| Read all 80 input registers | `110400000050a6f2` |
| Read all 80 holding registers | `1103000000506647` |
| Defer charging by 60 minutes | `1106003f003c47bb` |

### Tests

```bash
npm test
```

19 tests covering frame construction, response parsing, telemetry decoding — all
against captured traffic from real hardware — and the write-safety whitelist.

---

## What's verified vs. inferred

Being explicit, because it determines how much to trust each part.

**Verified against real captured traffic:**
- Frame construction for reads and writes
- 168-byte response parsing into 80 registers
- CRC-16 big-endian byte order (three independent frames)
- Telemetry decoding: SOC, power, runtime, AC voltage/frequency, status bits
- The `0x000A` AC-input correction

**Verified locally, end to end, against a simulated station:**
- Embedded MQTT broker under Bun
- Auto-discovery, auto-binding, binding persistence
- Settings round-trip: every field written and read back correctly
- Register dump, traffic log, port toggles

**Not yet verified against a real P280:**
- That the P280 uses this protocol at all (strongly implied by the shared
  Sydpower stack, but no source names the P280 for MQTT — they list P210 and
  P310)
- Register scaling on a 2800 W unit, particularly the AC charging rate
- The entire BLE path — the adapter is confirmed usable from Bun, but no
  station has been connected
- Expansion-pack SOC registers (53, 55) with real packs attached

---

## Project plan

### Phase 1 — First contact ← *next*

- [ ] Point DNS at this machine, power-cycle the P280, confirm it appears in **Devices**
- [ ] Dump registers from the **Protocol** tab; diff against BrightEMS
- [ ] Correct any P280-specific scaling in `registers.ts`
- [ ] Confirm a read-only session is stable for an hour before writing anything
- [ ] First write: charge limit — the safest reversible setting

### Phase 2 — Trust the link

- [ ] Reconnect/backoff when the station drops off Wi-Fi
- [ ] Surface write failures in the UI instead of silently resyncing
- [ ] Confirm the register 25/26 toggle workaround against real firmware
- [ ] Verify the BLE path; measure reconnect behaviour at range
- [ ] Automatic transport failover: BLE when Wi-Fi is unreachable

### Phase 3 — Make it useful

- [ ] History: log telemetry to SQLite (Bun has it built in), chart SOC and power
- [ ] Charge scheduling on top of register 63, so cheap-rate charging is automatic
- [ ] Spot-price integration (e.g. Tibber/Nord Pool for Sweden) to drive the schedule
- [ ] Safety automations: force UPS mode below N %, alert on lost connection
- [ ] Push notifications for outage / low battery

### Phase 4 — Ship it

- [ ] Replace the hand-mirrored client types with Hono RPC (`hc<AppType>`) for end-to-end types
- [ ] Lock CORS to an allowlist; add auth if it leaves the LAN
- [ ] EAS build so the app runs standalone on iOS instead of through Expo Go
- [ ] Run the server as a Windows service so it survives reboots
- [ ] Multi-station support (the binding model already allows for it)

### Known limitations

- The station needs internet once at startup to fetch MQTT credentials — a fully
  air-gapped setup isn't possible without also spoofing `api.app.sydpower.com`.
- CORS is wide open for local development.
- No authentication on the API. Anyone on your LAN can control the station.

---

## Sources

Everything in this document traces back to these. Enormous credit to the people
who did the original work.

### Protocol

- **[schauveau/sydpower-mqtt](https://github.com/schauveau/sydpower-mqtt)** — the
  most complete MQTT+MODBUS specification, including the
  [full register map](https://github.com/schauveau/sydpower-mqtt/blob/main/MQTT-MODBUS.md).
  Primary source for this project.
- **[iamslan/ha-fossibot](https://github.com/iamslan/ha-fossibot)** — Home
  Assistant integration. Source of the writable-register whitelist and the
  `api.app.sydpower.com` endpoints.
- **[dandwhelan/fossibot-bluetooth](https://github.com/dandwhelan/fossibot-bluetooth)** —
  BLE protocol, GATT UUIDs, and independent confirmation of the big-endian CRC.
- **[ylianst/esp-fbot](https://github.com/ylianst/esp-fbot)** — ESP32 BLE bridge;
  useful for the supported-model list and BLE behaviour.
- **[bootuz-dinamon/Aferiy-Fossibot-Reverse-Engineering](https://github.com/bootuz-dinamon/Aferiy-Fossibot-Reverse-Engineering-)** —
  RS485/ESPHome approach for per-cell voltages. The only source that names the
  **P280** explicitly, though via a different interface.

### Write-ups

- **[Jack Reeve — Reverse Engineering my smart battery](https://medium.com/@jack_57343/reverse-engineering-my-smart-battery-c01d711c770b)** —
  the MITM walkthrough that established how BrightEMS reaches the cloud, with the
  captured frames used as test vectors here.

### Vendor

- [BrightEMS on Google Play](https://play.google.com/store/apps/details?id=com.sydpower.app) — `com.sydpower.app`
- [AFERIY P280 product page](https://www.aferiy.com/products/aferiy-p280-portable-power-station-2800w-2048wh)
- [AFERIY app guide](https://www.aferiy.com/pages/app-guide)

### Legal note

Reverse engineering a device you own for interoperability is generally lawful in
the EU and US. Everything here targets hardware on your own network. Don't point
it at anyone else's.

---

## Project layout

```
client/
  app/(tabs)/
    index.tsx          dashboard — SOC, power flow, ports
    settings.tsx       station settings, written to registers
    devices.tsx        discovery and binding
    diagnostics.tsx    register dump and frame log
  src/
    components/        Card, Row, SliderRow, SegmentedControl, …
    lib/               api client, mirrored types, formatters
    state/             StationProvider — one poll loop for the app
  tamagui.config.ts    tokens, light/dark themes, animations
server/
  src/
    protocol/
      modbus.ts        framing + CRC (+ tests against real captures)
      registers.ts     register map, decoders, write whitelist (+ tests)
    transport/
      types.ts         Transport interface
      mqtt.ts          embedded-broker transport
      ble.ts           GATT transport
    drivers/
      device.ts        real station
      simulator.ts     simulated P280
    mqtt/broker.ts     embedded MQTT broker (aedes)
    binding.ts         persisted device binding
    index.ts           Hono routes
```
