# @kraftverk/device-tuya-zigbee-plug — the Tuya Zigbee plug

## What it is

A 16 A Zigbee plug that measures power, paired with a **Tuya Zigbee gateway**
in the Smart Life app — reached through that gateway on the home network,
with no cloud. A product on the [Tuya integration](../../integrations/tuya/README.md),
as the ATORCH is: a data layout on its socket, and the way it is reached.

Mapped on the owner's plug, sold as "Smart Zigbee Plug Socket 3680W 16A Power
Energy Monitoring" (and as working with Zigbee2MQTT, where the type is the
TS011F), listed in Smart Life as "Smart plug". Its gateway: an **RSH
GW018-DM** (Tuya's WBRG1 Wi-Fi/Bluetooth module and ZS3L Zigbee module
inside), Tuya LAN protocol **3.4**. `support: 'experimental'` until it has run
for a while.

## What it does — and does not

- **Does:** the Zigbee plug's data layout on the Tuya socket type, reached
  through its Tuya gateway on the home network — and what was found mapping
  it, below.
- **Does not:** speak Tuya or hold the socket's session: its integration,
  `@kraftverk/integration-tuya`, does both.

## Where it fits

A device package (docs/PLAN-INTEGRATIONS.md §1.1): a product on the Tuya
integration, `@kraftverk/integration-tuya`, as the ATORCH is — reached
through the integration's gateway (`tuya.gateway`), a device of its own.

## Why a package of its own

Because a model behind a gateway is a profile, not new code in the socket
every Tuya plug shares, nor in the gateway it is reached through.

## How it is reached

A Zigbee plug has no IP address and no key of its own. kraftverk speaks to its
**gateway** — a device of its own, `tuya.gateway`, one conversation for every
plug behind it — and names the plug there by its **Zigbee address** (the
`cid`, 16 hex digits; Tuya's begin `a4c138`), which is also its identity:
`zigbee:<address>`, the same whatever reaches it.

- **The key is the gateway's.** Smart Life lists the plug with a "local key":
  it is its gateway's — the 3.4 handshake with the gateway succeeds with it.
  The gateway itself is listed with no key, so signing in for the gateway
  gives it the key Tuya hands its plugs.
- **Its way is "through its Zigbee gateway"**, its address the Zigbee address:
  the plug's session reads it through the gateway's link (`ZigbeeLink`), and
  never holds the key or a connection of its own.
- **Setup:** add the gateway (Add a device → Gateways → Tuya Zigbee gateway →
  sign in with Smart Life); the plugs behind it are then found through it —
  on its page and under "Found near you" — as the gateway reports which it
  can reach.
- **Read every 15 s**: each read has the gateway ask the plug over Zigbee.

### What the gateway does, seen on the wire (2026-09-30)

- **Found** by its UDP broadcast like any Tuya device (its id, IP, 3.4). The
  plug is not.
- **Asked for a plug:** `DP_QUERY_NEW (0x10)` with `{"cid": "<cid>"}` **at the
  top level** → the plug's datapoints, with its cid. In the data instead
  (`{"protocol":4,"data":{"cid":…,"ctype":0}}`, as a control does it), the
  gateway answers for itself: `{"4":false,"32":"normal"}`.
- **A query is answered from the gateway's memory, at once, and asks the plug
  nothing** (2026-10-01: a 1 kW fan drawing, the same 1011.0 W answered every
  10 s for over a minute).
- **A refresh has the plug measure — named in a list.** `UPDATEDPS (0x12)`
  with `{"dpId":[18,19,20],"cid":["<cid>"]}`, as Smart Life sends it on the
  home network (its `DP_QUERY_GENERAL`), → an empty 0x12 acknowledgement, and
  within ~0.1 s a push of what changed:
  `0x08 {"protocol":4,"data":{"dps":{"18":4336,"19":10100},"cid":…,"type":"query"}}`.
  What did not change is not pushed: asked again with the fan steady, nothing
  came. So a silent refresh proves nothing — the plug may have measured the
  same, or not be there. Every poll asks one. A push of any of power,
  current and voltage dates all three as measured — the plug read its meter,
  and the rest measured the same (a plug drawing nothing pushed its current
  flickering 0–30 mA, its 0 W never). Nothing pushed, they keep their time.
  Energy keeps its own: the plug pushes it on its own.
- **Named bare** (`"cid":"<cid>"`, as tinytuya sends it) it is acknowledged
  the same, and the plug is not asked: why it seemed to do nothing before.
  Wrapped in the data, as a control is (`{"protocol":5,"data":{"cid":…,"dpId":[…]}}`),
  it is refused at once, rc 1 `query dp failed`.
- **Unknown `0x40` requests can wedge it**: after a run of guessed `reqType`s,
  the gateway took every connection and reset it at once, for half an hour,
  until its power was cycled. Send it only what is known.
- **Switched:** `CONTROL_NEW (0x0d)` with
  `{"protocol":5,"t":…,"data":{"cid":…,"ctype":0,"dps":{"1":true}}}` → an
  empty 0x0d acknowledgement, then the push `{"1":true}` within 0.2 s.
- **Every change is pushed** within seconds, whoever made it — the app, the
  button, the countdown, a schedule: `0x08 {"protocol":4,"data":{"dps":{"1":true},"cid":…}}`.
- **Power and current are not pushed on their own** — this plug (a TS011F)
  measures them when asked, as Zigbee2MQTT knows of its newer firmware. Pushes
  seen while a load changed (a charger's first, 7.3 s after it was switched
  on) came while something was asking: Smart Life open, or the gateway after
  a restart. Energy is pushed on its own (`{"17":43350}`, 120 Wh on from the
  last).
- **Switched off, it does not push the load falling**: the gateway kept
  answering 269 W for minutes with the relay off, until the owner opened the
  plug in Smart Life — then it said 0 W. The session reads power and current
  as 0 while the relay is off: nothing flows through the meter then.
- **Right after a switch, the gateway's memory lags the plug**: a query sent
  as the relay's push arrives can still say the old state. The session takes
  the plug's push over the memory for a few seconds, and does not query
  straight after a switch.
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
  (the owner): the app's refresh, above, which every poll now sends. A metric
  behind a gateway is dated by when the plug last measured it — pushed it, or
  an answer changed it — never by the gateway answering the same again: a
  page shows how old it is.

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
  - Also: whether a refresh to a plug that lost its power is refused, or
    acknowledged and silent. Acknowledged and silent, it cannot tell the plug
    gone from the plug measuring the same.
