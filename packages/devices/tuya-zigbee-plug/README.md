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
- **Power and current are pushed while a load changes**, not at once:
  switching a 1 kW fan off pushed the relay only, but a scooter charger
  switched on (2026-10-01) brought its first power push 7.3 s later
  (`{"18":1297,"19":2970,"20":2340}`), and pushes every 5–20 s after as it
  settled. A query in between is answered from the gateway's memory, which
  holds the last push. Asked once a second for a minute with nothing
  drawing, the answer never changed and no `"type":"query"` push came.
- **`UPDATEDPS` (0x12) brings nothing through the gateway**: sent with the
  plug's cid and `"dpId":[18,19,20]` before every query, no push followed.
- **Switched off, it does not push the load falling**: the gateway kept
  answering 269 W for minutes with the relay off, until the owner opened the
  plug in Smart Life — then it said 0 W. So the app has a way to have the
  plug measure again that a local query does not (to learn: what it sends).
  The session reads power and current as 0 while the relay is off: nothing
  flows through the meter then.
- **Right after a switch, the gateway's memory lags the plug**: a query sent
  as the relay's push arrives can still say the old state. The session takes
  the plug's push over the memory for a few seconds, and does not query
  straight after a switch. **Energy is** pushed on its own
  (`{"17":43350}`, 120 Wh on from the last).
- **Several connections at once** are fine, and each hears every push: a
  listener stayed connected while two others switched the plug, and heard
  both.
- **Which plugs it can reach:** `0x40 {"reqType":"subdev_online_stat_report","data":{"online":[cid…],"offline":[]}}`,
  every so often. A plug reported offline is shown as "Its gateway cannot
  reach it".

- **A gateway that loses its power closes nothing** (measured 2026-10-01, the
  gateway on the same switched outlets as the plug): its connection kept
  looking open for six minutes, until the gateway was back and reset it; a
  command sent into it in between was lost ("did not answer command 0xd").
  The link now takes silence for the connection gone — a request unanswered
  with nothing else heard, or two heartbeats (10 s apart) without an answer —
  and opens it afresh, which fails until the gateway answers again.
- **Back on power, the gateway took ~24 s** to accept a connection again; its
  answers to queries came at once, from its memory. No presence report, and
  no push from the plug, came as the plug rejoined. So "can be reached" is
  not proven by the connection alone: after a run switches power, the engine
  holds a device reachable only once it has been heard from since.

- **After the gateway lost its power, the plug stopped measuring** (the same
  day): with the charger drawing 240 W — the station feeding it said so — the
  gateway answered 0 W from its memory every two seconds for minutes, and no
  push came. Opening the plug in Smart Life had it measure again at once
  (the owner). So a metric behind a gateway is dated by when the plug last
  measured it — pushed it, or an answer changed it — never by the gateway
  answering the same again: an automation waiting for the plug's power reads
  "not known" rather than "0 W", and its page shows how old it is. What the
  app sends to have it measure is still to learn.

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
- **How soon the gateway says a plug that lost its power is gone.** Until it
  reports the plug offline, a query is still answered from its memory, and
  the session takes that answer as current. Once it reports it, the session
  takes nothing more from memory until the plug speaks again (tested).
  - To learn: unplug the plug while listening, and time the
    `subdev_online_stat_report`.
  - Also: whether a query to a powered plug always brings its own
    `"type":"query"` push. Captured so far, not every query did, and those
    that came carried only some datapoints. So the query-answer push cannot
    yet stand in for the memory answer.
