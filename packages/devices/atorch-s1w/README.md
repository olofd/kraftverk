# ATORCH S1W / S1WP / S1BW — the energy socket with a display

## What it is

The device type for ATORCH's Tuya energy sockets: a relay, a meter, an LCD, and
the protection and timer logic the plug runs itself. Spoken to directly on the
home network with the Tuya local protocol (`@kraftverk/protocol-tuya-local`),
**no cloud** after the local key is fetched once.

> **Unofficial.** Not affiliated with, endorsed by, or supported by ATORCH or
> Tuya. The names identify the hardware this software talks to.

Everything below marked **✔ seen** was established on a real **S1BW** on
2026-09-30: a setting changed in the Tuya app while kraftverk held the plug's
local connection, and the datapoint that moved read off the wire. **✔ read**
means the value was read and matched what the app displays. **Published** means
only [make-all/tuya-local's map](https://github.com/make-all/tuya-local/blob/main/custom_components/tuya_local/devices/atorch_s1bw_smartplug.yaml)
says so.

---

## What it does — and does not

- **Does:** the plug's data layout on the Tuya socket type — its relay,
  meter, display, protections and timers — its settings in plain words, and
  its own screens.
- **Does not:** speak Tuya (`@kraftverk/protocol-tuya-local`) or hold the
  socket's session (`@kraftverk/device-tuya-plug`, which it builds on).

## Where it fits

A family on the generic Tuya socket (docs/ARCHITECTURE.md §3): a profile
and screens over `@kraftverk/device-tuya-plug`, by its name.

## Why a package of its own

Because adding a plug model should be a profile and its screens, not code
in the core or in the generic socket.

## 1. The unit

| | |
| --- | --- |
| Tuya app name | *ATORCH Smart Socket(S1BW)* |
| Product key | `pl28o0wkaopyft8u` (S1BW); `sqrf2g1amfutn4co` is the S1WP |
| Protocol | **3.5** (AES-GCM, `6699` frames), TCP 6668 — ✔ |
| Module | BK7231N (Beken), per the OpenBeken teardown |
| Relay | internal relay rated 10 A / 2650 W at 265 V by one reseller spec; the app's own limits go to 16 A / 4500 W |

An earlier working setup by the owner (tuyapi, protocol 3.5) read the plug but
switched it with DP 1 — which, as §3 shows, only *appears* to work.

## 2. Connecting: few clients, and the phone app crowds them out

- **While the Tuya/Smart Life app is open on a phone** on the same network,
  every connect from kraftverk was reset (`ECONNRESET` on each protocol version
  tried). Closing the app fully (swiping it away) freed it within seconds.
- **Two kraftverk connections at once were accepted** (a leftover probe and a
  new one both received every push), so the limit is not simply one client.
  Where exactly it lies is not established; a holder should expect to be
  refused while the app is open, and say so.
- **While kraftverk holds the connection, the app still works** — it falls back
  to the cloud — and **every change the app makes is pushed to kraftverk** as an
  unsolicited `STATUS` (0x08) frame. That is how this map was made, and how
  kraftverk sees changes made at the plug or in the app without polling.
- A status query sometimes answers with only the datapoint that just changed
  (e.g. `{"1": true}`), then the full set on the next query. Merge, never replace.

## 3. The relay — DP 131, not DP 1

| DP | Wire values | Meaning |
| --- | --- | --- |
| **131** | `"open"` = **on**, `"close"` = **off**, `"auto"` | **Switches the relay.** ✔ seen: app On/Off writes it; kraftverk writing `"close"` switched the plug off, `"open"` on again |
| 1 | `true` / `false` | **Status only.** Follows 131 about two seconds later ✔ seen |

**Writing DP 1 does not switch the relay.** kraftverk wrote `DP 1 = false`: the
plug accepted it, reported `false` from then on, and **stayed on** (DP 131 still
`"open"`). The owner confirmed it at the plug. This was the bug behind "nothing
happens when I toggle it". After such a write DP 1 is wrong until the relay
next moves, so **DP 131 is the truth for on/off**; DP 1 is only consulted while
131 is `"auto"`.

**`"auto"`** hands the relay to the plug's own mode (§4, *Device interface*).
The app greys the Auto button out unless the current mode can drive the relay.
✔ seen with Smart Power Off A (P low 76 W, Last 1 min, the charger drawing 0 W):

```
10:35:22 {"120":1} {"124":60}   Last = 1 minute; 60 s to go
10:35:25 {"131":"auto"}         Auto pressed in the app
10:36:24 {"124":0}
10:36:25 {"132":"outage_a"}     relay cut — and DP 1 was NOT pushed
10:37:19 {"132":"off"}          OK pressed on the plug itself
10:37:20 {"1":true}             relay on again; 131 still "auto"
```

A minute after OK it cut again — **the mode re-arms; OK does not stop it**, only
leaving Auto or the mode does:

```
10:38:18 {"124":0} {"1":false} {"132":"outage_a"}   cut again; DP 1 pushed this time
10:38:44 {"132":"off"} {"1":true}
10:38:47 {"131":"open"} {"118":"safety_protection"} On pressed, normal mode: back to normal
```

**When a mode cuts the relay, the plug does not always push DP 1 `false`** — the
reliable sign is the warning (DP 132) naming the mode. The screen showed a countdown
state; **pressing OK on the plug** acknowledged it and switched the relay back
on. So on/off is: DP 131 when it is `open`/`close`; in `auto`, off while DP 132
names a mode (`outage_a` seen; the other mode names presumably the same), else
DP 1.

## 4. Datapoints

Scale *n* means the raw integer is the value × 10ⁿ.

### Measurements

| DP | Name | Scale | Unit | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| 18 | Current | 3 | A | ✔ read | `6` = 0.006 A; app shows 0.000 A form |
| 19 | Power | 2 | W | ✔ read | `37` = 0.37 W |
| 20 | Voltage | 2 | V | ✔ read | `22956` = 229.56 V; app 232.40 V form |
| 123 | Total energy | **3** | kWh | ✔ read | `19595` = **19.595 kWh**, matches the app. kraftverk used scale 2 (195.95) — a bug |
| 102 | Bill (total cost) | 3 | currency | ✔ read | Recomputed by the plug as energy × price: 19.595 × 21.27 = `416794` ✔ seen |
| 133 | Frequency | 2 | Hz | ✔ read | `4998` = 49.98 Hz |
| 134 | Power factor | 2 | — | ✔ read | `24` = 0.24 |
| 135 | CPU temperature | 0 | °C | ✔ read | 44–46 °C idle |
| 132 | Warning | — | enum | ✔ seen (`lvp`) | `off`, `lvp`, `ovp`, `ocp`, `opp` published, plus mode values `outage_a`, `outage_b`, `timing_open`, `timing_close`, `loop_timing`, `countdown`. The app sounds an alarm while it is not `off` |
| 124 | Time remaining | 0 | s | ✔ seen | Appears when a mode or timer starts: 540 for a 9-minute Smart power off A, 28800 for 8 h, 120 for 2-minute timers |
| 142 | Recovery countdown | 0 | s | ✔ seen | After a protection trip: set to the recovery delay (120 for 2 min), **held there while the fault lasts**, then pushed once a second down to 0, when the relay comes back on |

### Fast refresh — DP 140

| DP | App label | Status |
| --- | --- | --- |
| **140** | *Faster refresh after activation* | ✔ seen (`false` → `true` from the app) |

With it on, the plug **pushes the measurements that changed about once a second**
— only DPs 18, 19, 20, 133, 134, 135, and only those that moved:

```
+13.9 s {"19":1,"20":23129,"134":14,"135":44}
+17.0 s {"18":1,"19":7,"20":23078,"135":44}
```

**It switches itself off after exactly 5 minutes.** kraftverk wrote `true` at
10:28:51; the plug reported `false` at 10:33:51 with nobody touching it. (An
earlier activation from the app also lapsed on its own.) Likely to spare the
CPU. An adapter that wants live readings renews it while someone is watching,
and lets it lapse otherwise. **It is written over the local connection** — the
first setting confirmed writable locally.

### Settings page (in the app's order)

| App label | DP | Scale / unit | Wire values | Status |
| --- | --- | --- | --- | --- |
| Device language | 107 | — | `english`, `chinese` | ✔ read |
| Display brightness | 108 | 1–9 | | ✔ read (6) |
| Standby brightness | 109 | 1–9 | | ✔ read (3) |
| Enter standby time | 110 | s, 3–99 | | ✔ read (60) |
| Key beep | 111 | bool | | ✔ read (on) |
| Over-voltage protection (OVP) | 104 | 1 → V | `2650` = 265.0 V | ✔ seen (→ 257.7 V = `2577`) |
| Low-voltage protection (LVP) | 141 | 1 → V | `750` = 75.0 V | ✔ seen (→ 140.0 V = `1400`) |
| Over-current protection (OCP) | 105 | 2 → A | `1600` = 16.00 A | ✔ seen (→ 16.01 A = `1601`) |
| Over-power protection (OPP) | 106 | 0 → W | `4500` | ✔ seen (→ 4499) |
| Overprotect enabled | 139 | bool | | ✔ seen (off and on again) |
| Overprotect delay time | 103 | 1 → s | `3` = 0.3 s | ✔ seen (→ 0.2 s = `2`) |
| Switch mode | 112 | — | `controlled`, `normally_open` | ✔ read (`controlled`); **not changed** — may stop remote switching |
| Standby screen | 117 | — | `original`, `measurement`, **`calendar` = "Screen off"** | ✔ seen. "Screen off" is `calendar` on the wire; no published map has it |
| Over recovery delay time | 137 | 0 → min | `3` | ✔ seen (→ 2) |
| Device power-up switch status | 138 | — | `open` = on, **`colse`** = off (sic), `memory` = last state | ✔ seen (`memory` → `colse` → `memory`). **The plug reports its own boot behaviour** |
| Price mode | 136 | — | `single_rate` = Price A, `stair` = Price B, `peak_valley_stair` = Price C | ✔ seen (A → B → C → A). Whether B and C bring settings of their own is not recorded |
| Unit price | 101 | 2 | `7001` = 70.01 | ✔ seen (→ 21.27 = `2127`); no currency |

**Buttons** (write `true`; the plug acts and reports `true`):

| App label | DP | Status |
| --- | --- | --- |
| Screen rotation | 116 | ✔ seen: each press sends `true` and flips the screen |
| Data zero (reset energy and bill) | 113 | Published; not pressed |
| Wi-Fi reset | 114 | Published; **never press** — the plug leaves the network |
| System all default settings | 115 | Published; **never press** |

The app warns (in machine translation) that changing the price mode or unit
price should be followed by clearing the data.

### A protection trip, end to end

✔ seen, by setting the low-voltage limit above the mains (239.9 V against about
232 V), then back:

```
10:31:03 {"141":2399}      limit raised above the mains
10:31:04 {"1":false}       relay off within a second
10:31:04 {"131":"close"}
10:31:04 {"132":"lvp"}     warning: under-voltage; the app alarms
10:31:04 {"142":120}       recovery countdown set to the 2-minute delay — and held
10:31:46 {"141":1405}      limit lowered: the fault clears
10:31:47 {"142":119}       …the countdown starts, pushed every second
10:33:46 {"142":0}
10:33:46 {"131":"open"}    relay back on, by itself
10:33:46 {"132":"off"}     warning cleared
```

So after a trip **the plug turns itself back on** once the fault has been gone
for the recovery delay. For a plug feeding a station that is the right default;
an automation that wants it off must not rely on it staying off after a trip.

### Device interface — the plug's own mode, DP 118

The main page's *Device interface* dropdown picks what the screen shows **and
what logic the plug runs**. The wire names do not match the labels.

| App label | DP 118 value | Its settings | Status |
| --- | --- | --- | --- |
| Security Protect | `wifi1` | none | ✔ seen |
| Electricity Price Setting and Bill | `safety_protection` | unit price (101) | ✔ seen (the normal mode) |
| Smart Power Off (A) | `outage_a` | *P low* (119, W) and *Last* (120, min) | ✔ seen: 100 W → 76, 10 min → 9; DP 124 then counts 540 s |
| Smart Power Off (B) | `outage_b` | *Power* (121, W — the app says "V", a typo) and *Last* (122, **hours**) | ✔ seen: 500 → 499 W, 1 h → 8 h; DP 124 = 28800 |
| Timing Cut Off | `timing_close` | time (125, s; app picks hours and minutes) | ✔ seen: 60 → 120 |
| Timing On | `timing_open` | time (126, s) | ✔ seen: 60 → 120 |
| Timing Cycle | `loop_timing` | on-time (127, s), off-time (128, s) | ✔ seen: both 60 → 120 |

DPs 129 and 130 (published as one-shot on/off timers, both `60`) had no control
in the app. The published map also lists a `countdown` mode, which the app does
not offer.

**A** ✔ seen: in Auto, with the draw **below** *P low* for *Last* minutes, it cut
the relay (a charger that has finished). **B** presumably cuts when the draw
stays **above** *Power* for *Last* hours; not watched.
**Relay changes seen:** at 10:17:06 the relay went off (131 `close`, then 1
`false`) about the time Smart Power Off A was being selected — whether the owner
pressed Off or the mode cut it was not settled.

### Main page

- **Big buttons:** On, Off, Auto (Auto disabled in the normal mode).
- **Hourglass — countdown, DP 9** (seconds): ✔ seen. Set to 60 s; when it ran out
  the plug **toggled the relay** (it was off, it came on: 1 `true`, 131 `open`)
  and DP 9 returned to 0.
- **Clock — schedules.** Kept in Tuya's cloud, not on the plug; no datapoint.
  kraftverk's automations do this job locally.
- Stats, graphs and an operation log, drawn from the datapoints above.

## 5. What this means for the adapter

The type as it stood before this mapping had five faults, all visible above:

1. **It switched DP 1.** Must write DP 131 (`open`/`close`) and read on/off from it.
2. **Energy was scaled ×10 too high** (scale 2 instead of 3).
3. **It asked the person** for the boot behaviour ("Not tested yet") that the
   plug reports on DP 138.
4. **It threw away pushes** — the plug tells us every change, once a second with
   fast refresh.
5. **Its check guessed the relay** as the first boolean datapoint, which on this
   plug is DP 1 — the wrong one.

All five are fixed: the profile in `src/type.ts` switches on 131, reads on/off
from 131 then 132 then 1, scales energy by 3, reads the boot behaviour, and the
socket type takes every push. Confirmed through the app on the real unit: the
toggle switches it.

**What is offered, and what is not.** The plug's own app is hard to understand:
seven "device interface" modes, Auto, A and B, timers, a price mode. kraftverk
does not copy it. As settings it offers what a person decides — *after a power
cut*, the *safety cut-off* (limits, delay, back-on time), the *display* and
the *price per kWh* its screen bills by — in plain words, and its two safe
buttons: turning the screen around and resetting its counter. Live readings
are a switch of their own. The plug's modes and their values are **read,
never offered**: kraftverk uses them to explain a cut ("a rule set in the
maker's app switched it off"), can stop one, and its automations do their job
with more to go on. Left out, the Datapoints tool showing each raw: the timers
and the countdown (kraftverk's automations time things), the price mode (tiers
B and C had no settings in the app), the switch mode ("normally open" was
never tried, and may stop remote switching), and resetting Wi-Fi or every
setting (the plug leaves the network).

### Its screens (`ui/`)

- **Live readings** (DP 140) are kept by the plug's session on the server, not
  by any screen: switched on, they stay on for a quarter of an hour — the
  session turning the plug's fast refresh back on each time it lapses — and a
  screen that shows them extends that while it is open, but only while they
  are on. Switched off, they are off, for every screen and every person.
- **Buttons** the plug is told once are tools: *Turn the screen around*
  (DP 116), and *Reset the energy counter* (DP 113), which the app asks about
  first because the plug's total cannot be brought back.
- **Dashboard:** what it draws now, large; the power button; live readings as
  a switch beside it; tiles for voltage (drawn inside its cut-off window),
  current (against its limit), energy, the temperature inside, frequency and
  power factor; and, when the plug switched itself off, a card saying why in
  plain words and counting down to when it comes back — or, for a rule set in
  the maker's app, offering to switch it on and to stop that rule.
- **Settings:** the live-readings switch at the top, to watch a change land.
  *After a power cut* as three choices; the *safety cut-off* as sliders — the
  voltage window as one range with the mains marked on it, current and power
  with what is drawn now marked, each warning before it is written if it would
  cut at once; *its screen* as sliders and choices, and turning it around;
  *the bill on its screen*: the price per kWh, what it shows, and resetting
  its counter.
- The wording is in `ui/words.ts`, tested on its own: never the maker's terms.

## 6. Still to establish

- Whether every setting accepts a local write (DP 140 does; so do DPs 1 and 131).
- Auto in the other modes (B, the timers), and whether each names itself in
  DP 132 when it cuts, as A does.
- DP 132 for the other protections (`ovp`, `ocp`, `opp`); `lvp` is seen.
- Price modes B and C on the wire.
- Power-on behaviour under a real power cut with `memory`.
- Current and temperature through a full P280 AC charge (about 7.8 A).

## 7. Values the mapping session left changed

The session changed these in the app to see them move. Set them back if the
old values mattered:

| Setting | Before | Left at |
| --- | --- | --- |
| Low-voltage protection | 75.0 V | 140.5 V |
| Over-voltage protection | 265.0 V | 257.7 V |
| Over-current protection | 16.00 A | 16.01 A |
| Over-power protection | 4500 W | 4499 W |
| Overprotect delay | 0.3 s | 0.2 s |
| Over recovery delay | 3 min | 2 min |
| Smart Power Off A | 100 W, 10 min | 76 W, 1 min |
| Smart Power Off B | 500 W, 1 h | 499 W, 8 h |
| Timing Cut Off / On / Cycle | 60 s each | 120 s each |
| Unit price | 70.01 | 21.27 |

## 8. How the map was made

A scratch probe over kraftverk's own `TuyaLink`: `read` dumps every datapoint,
`set <dp> <value>` writes one and reads back, `listen <s>` holds the connection
and prints every pushed change with a timestamp while someone works the app.
`TuyaLink` gained an `onPush` option for this — the same hook the adapter uses.

## Sources

- The owner's unit, 2026-09-30 (all ✔ rows).
- [make-all/tuya-local — atorch_s1bw_smartplug.yaml](https://github.com/make-all/tuya-local/blob/main/custom_components/tuya_local/devices/atorch_s1bw_smartplug.yaml); issues [#3253](https://github.com/make-all/tuya-local/issues/3253), [#1103](https://github.com/make-all/tuya-local/issues/1103), [#4139](https://github.com/make-all/tuya-local/issues/4139).
- [Elektroda: ATORCH S1-BWTH relay not switching via DP 1](https://www.elektroda.com/rtvforum/topic4124515.html) — relay on DP 131, DP 1 status only.
- [Elektroda: ATORCH S1-B/W/T/H teardown](https://www.elektroda.com/rtvforum/topic4003739.html) — BK7231N, OpenBeken.
- [tinytuya PROTOCOL.md](https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md) — the protocol.
