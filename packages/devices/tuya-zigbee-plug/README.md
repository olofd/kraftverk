# Tuya Zigbee plug

A 16 A Zigbee plug that measures power, paired with a **Tuya Zigbee gateway**
in the Smart Life app — reached through that gateway on the home network,
with no cloud. Built on the Tuya socket type ([`tuya-plug`](../tuya-plug)),
as the ATORCH is: a data layout, and the way it is reached.

Mapped on the owner's plug, sold as "Smart Zigbee Plug Socket 3680W 16A Power
Energy Monitoring" (and as working with Zigbee2MQTT, where the type is the
TS011F), listed in Smart Life as "Smart plug". Its gateway: an **RSH
GW018-DM** (Tuya's WBRG1 Wi-Fi/Bluetooth module and ZS3L Zigbee module
inside), Tuya LAN protocol **3.4**. `support: 'experimental'` until it has run
for a while.

## How it is reached

A Zigbee plug has no IP address and no key of its own. kraftverk speaks to its
**gateway**, and names the plug there by its **Zigbee address** (the `cid`,
16 hex digits; Tuya's begin `a4c138`).

- **The key is the gateway's.** Smart Life lists the plug with a "local key":
  it is its gateway's — the 3.4 handshake with the gateway succeeds with it.
  The gateway itself is listed with no key.
- **The address is the gateway's, `#`, the plug's Zigbee address**:
  `192.168.1.20#a4c1380000000001`. The whole address is the one plug: two
  plugs behind one gateway are two addresses, each claimed by its own device,
  each with a connection of its own to the gateway (the `lan` transport
  connects to the part before `#`).
- **Setup:** Add a device → Smart plugs → Tuya Zigbee plug → sign in with
  Smart Life. The plug comes back with its gateway's key, and — when its
  gateway is heard on the network — its address. The Zigbee address is Tuya's
  `uuid` for it (**to confirm on the owner's account**; typed by hand
  otherwise, as the gateway's IP address `#` the Zigbee address).
- **Read every 15 s**: each read has the gateway ask the plug over Zigbee.

### What the gateway does, seen on the wire (2026-09-30)

- **Found** by its UDP broadcast like any Tuya device (its id, IP, 3.4). The
  plug is not.
- **Asked for a plug:** `DP_QUERY_NEW (0x10)` with `{"cid": "<cid>"}` **at the
  top level** → the plug's datapoints, with its cid. In the data instead
  (`{"protocol":4,"data":{"cid":…,"ctype":0}}`, as a control does it), the
  gateway answers for itself: `{"4":false,"32":"normal"}`.
- **A query is answered from the gateway's memory, at once.** The gateway then
  asks the plug over Zigbee, and pushes what it says a few seconds later:
  `0x08 {"protocol":4,"data":{"dps":{"18":4310,"19":9970},"cid":…,"type":"query"}}`.
  The session takes both.
- **Switched:** `CONTROL_NEW (0x0d)` with
  `{"protocol":5,"t":…,"data":{"cid":…,"ctype":0,"dps":{"1":true}}}` → an
  empty 0x0d acknowledgement, then the push `{"1":true}` within 0.2 s.
- **Every change is pushed** within seconds, whoever made it — the app, the
  button, the countdown, a schedule: `0x08 {"protocol":4,"data":{"dps":{"1":true},"cid":…}}`.
- **Power, current and voltage are not pushed**: switching a 1 kW fan off
  pushed the relay only. They must be asked for — as Zigbee2MQTT documents
  for this plug's firmware from 1.0.5. **Energy is** pushed on its own
  (`{"17":43350}`, 120 Wh on from the last).
- **Several connections at once** are fine, and each hears every push: a
  listener stayed connected while two others switched the plug, and heard
  both.
- **Which plugs it can reach:** `0x40 {"reqType":"subdev_online_stat_report","data":{"online":[cid…],"offline":[]}}`,
  every so often. A plug reported offline is shown as "Its gateway cannot
  reach it".

## Datapoints

Each changed in the Smart Life app, one at a time, while kraftverk listened.

| DP | Here | What | Established |
|---|---|---|---|
| 1 | `relay` | The relay, true/false | Switched in the app, by the countdown, by a schedule, and from kraftverk: pushed each time |
| 17 | `kwh` | Energy, **Wh** (scale 3) | 43230 → 43.23 kWh in the app |
| 18 | `amps` | Current, **mA** (scale 3) | 4310 → 4 300 mA in the app, a ~1 kW fan |
| 19 | `watts` | Power, **0.1 W** (scale 1) | 9970 → 994 W in the app |
| 20 | `volts` | Voltage, **0.1 V** (scale 1) | 2310 → 230 V in the app |
| 27 | `afterPowerCut` | After a power cut — app "Relay status" | `off` Off, `on` On, `memory` Keep |
| 28 | `indicator` | The light — app "Light mode" | `relay` lit while on, `pos` lit while off (to find it at night), `none` Blank |
| 29 | `buttonLocked` | The button does nothing — app "Child lock". Undone at the plug by pressing its button four times, or unplugging it | true/false |
| 9 | `countdown` | A countdown set in the app, **seconds** — read, never offered | 2 min → `120`; nothing while it ran; at the end `9: 0`, then `1: true` |

Energy is where it differs from a Wi-Fi Tuya socket's generic layout, which
counts hundredths of a kWh.

## What is left out, and why

- **The app's Timer tab** — Schedule, Circulate (a repeating cycle), Random:
  not datapoints of the plug; kept by the gateway or the cloud. A schedule set
  for 17:21 arrived at 17:21:00 as a plain `{"1":false}` — the same as a
  person pressing the switch. kraftverk's automations do this job, and say
  why when they act; a switch they did not make is shown as the plug's.
- **The countdown** is read so a switch nobody pressed is explained, and not
  set from here, for the same reason.
- **"Switch log" and "Electric"** in the app are the cloud's history of the
  relay and of DP 17; kraftverk keeps its own.

## Still to learn

- Whether a schedule fires with the internet down (the gateway's, or the
  cloud's).
- How often energy is pushed: every 0.1 kWh, or on a timer.
- Whether Smart Life's `uuid` for the plug is its Zigbee address (setup
  counts on it).
- A second plug behind the same gateway (each its own connection: expected
  to work).
