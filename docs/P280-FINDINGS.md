# AFERIY P280 — protocol findings

A running log of what has been established against **real hardware** (MAC
`MAC redacted`, advertised as `POWER-nnnn`), as distinct from what the
published maps claim.

The published register map was derived largely from **Fossibot F2400/F3600**
units. The P280 runs the same Sydpower stack but is a bigger machine, so
everything here is either confirmed on the unit or explicitly flagged as not.

Status legend: **✅ confirmed on hardware** · **📖 from docs, untested** ·
**❓ observed, meaning unknown** · **⚠️ docs are wrong**

---

## Connection

| Fact | Status |
| --- | --- |
| Advertises as `POWER-nnnn`, MAC `MAC redacted` | ✅ |
| GATT service `0000a002-...` (write `c304`, notify `c305`) | ✅ |
| Second vendor service `0000a003-...`, purpose unknown | ❓ |
| **Pairing is NOT required** — bound with `IsPaired: false` | ✅ |
| Only one BLE connection at a time | ✅ |

### ⚠️ The phone blocks everything

While BrightEMS held the BLE connection, Windows enumerated **only** `1800`
and `1801` (characteristics `2a00, 2a01, 2a05, 2aa6`) — the generic services
every BLE device has. The vendor services were invisible.

This looks *identical* to the documented WinRT limitation where unpaired
peripherals hide custom services, and we initially misdiagnosed it as such and
spent time trying to pair. Pairing was never needed. **Force-quit BrightEMS and
disable Bluetooth on the phone; the services appear immediately.**

Signal matters: at **-89 dBm** connections dropped mid-enumeration. At
**-60 dBm** (after attaching antennas) it bound on the first attempt.

---

## Framing

| Fact | Status |
| --- | --- |
| MODBUS RTU frames, slave address `0x11` | ✅ |
| `0x04` reads 80 input registers; `0x03` reads 80 holding | ✅ |
| Read responses echo start + count before the data | ✅ |
| **CRC-16/MODBUS appended big-endian** | ✅ |

### ⚠️ The CRC byte order is backwards

CRC-16/MODBUS (init `0xFFFF`, poly `0xA001`) but transmitted **high byte
first**, which contradicts the MODBUS spec. A stock MODBUS library byte-swaps
it and the device silently drops every frame.

Verified against three independent captures:

| Frame | CRC | On the wire |
| --- | --- | --- |
| `110400000050` | `0xA6F2` | `a6f2` |
| `1106003f003c` | `0x47BB` | `47bb` |
| 168-byte response | `0xDFB5` | `dfb5` |

---

## Input registers (`0x04`) — telemetry

| Reg | Name | Scale | Status | Evidence |
| --- | --- | --- | --- | --- |
| 2 | AC charging rate | 1–5 | 📖 | read `3` |
| 3 | Charging power | W | 📖 | |
| 4 | DC/solar input power | W | ✅ | read `166` with a panel delivering |
| 6 | Total input power | W | ✅ | tracked reg 4 with no mains |
| 9 | DC output power | 0.1 W | 📖 | |
| 15 | LED power | 0.1 W | ✅ | `10` → 1.0 W with the light on; scaling proven by arithmetic, see below |
| 18 | AC output voltage | 0.1 V | ✅ | `0` off → `2306` (230.6 V) with inverter on |
| 19 | AC output frequency | 0.1 Hz | ⚠️ | reads `500` (50 Hz) **even when AC output is off** — nominal, not measured |
| 20 | AC output power | W | ✅ | `9` W inverter idle draw |
| 21 | AC input voltage | 0.1 V | ⚠️ | `2` with no mains, but **`591` when the inverter runs** — backfeed, see below |
| 22 | AC input frequency | 0.01 Hz | ✅ | `0` with no mains |
| 25 | LED state | enum | ✅ | `1` in "always on", `2` in SOS — confirms `0=off, 1=on, 2=SOS, 3=flash` |
| 30–31, 34–37 | USB port power | 0.1 W | 📖 | stayed `0` with USB enabled but nothing plugged in |
| 39 | Total output power | W | ✅ | |
| 41 | Status bitmask | — | ✅ | see below |
| 42 | Device state | — | ✅ | `0` idle → `0x03D8` with an output active |
| 47 | — | — | ❓ | reads `0x3000` |
| 48 | Charging flag | bit 15 | ⚠️ | see below |
| 53, 55 | Expansion pack SOC | 0.1 % | 📖 | `0` — no packs attached |
| 54 | — | — | ❓ | reads `376`; **possibly** 37.6 °C battery temp, unconfirmed |
| 56 | State of charge | 0.1 % | ✅ | `1000` → 100 % |
| 57 | AC charging booking | min | 📖 | |
| 58 | Time to full | min | 📖 | |
| 59 | Time to empty | min | ✅ | `22560` idle → `20509` after enabling USB |
| 62 | — | — | ❓ | reads `0x00FF` |
| 70, 71 | displayed SOC? | 0.1 % | ❓ | both `1000` at 100.0 % SOC, both `990` when SOC hit 999 — see below |

### ⚠️ Register 48 is a bitmask, not a value

Docs say it reads exactly `0x8000` when charging and `0x4000` otherwise. A real
P280 reports **`0x8040`**. Comparing for equality misses the charging flag
entirely. Mask bit 15.

### Status bitmask — register 41

| Mask | Meaning | Status |
| --- | --- | --- |
| `0x1000` | LED on | ✅ |
| `0x0800` | AC output on | ✅ |
| `0x0400` | DC output on | ✅ |
| `0x0200` | USB output on | ✅ |
| `0x0080` | DC converter active | ✅ |
| `0x0060` | DC input present | ⚠️ |
| `0x0010` | Charging from AC | 📖 |
| `0x0004` | **Inverter active** | ✅ |
| `0x000A` | AC input connected | ⚠️ |

**AC output test:** switching AC output on moved register 41 from `0x0020` to
`0x0824`, setting `0x0800` **and** `0x0004`, with nothing plugged into the wall.
Also moved: input 18 → `2306` (230.6 V), input 20 → `9` W, holding 26 → `1`.

That settles what bit 2 is: **the inverter**. The published map folds it into
the `0x000E` "AC input connected" mask, which would report a station running
purely off its own battery as being on grid power.

**USB test:** switching USB on at the unit moved register 41 from `0x0020` to
`0x02A0` — setting `0x0200` and `0x0080` together. USB feeds through the DC
converter, so both are expected. Holding register 24 went `0` → `1` at the same
time, and nothing else in either bank moved.

**⚠️ `0x0060` bits are not redundant.** Docs claim they are. A panel attached
but producing nothing reads `0x0020`; once solar delivers it reads `0x0060`.
Masking both still answers "is DC input present", which is all we use it for.

Confirmed twice: on a later capture the status moved `0x0824` → `0x0864` — the
only bit to change was `0x0040` — at the same moment DC input power went from
`0` to `50` W as the panel began producing.

**Register 48 is AC-specific.** It read `0x8040` while charging from mains,
`0x4000` with mains present but not charging, and `0` with no AC connected at
all while charging happily from solar. Do not use it to answer "is the station
charging" — use net power flow, which is what the driver does.

**⚠️ AC input mask is `0x000A`, not `0x000E`.** Bit 2 is the inverter, proven
by the AC output test above.

### ✅ Every bit of the status register is accounted for

With AC output, the car port and the light all on, a panel attached and the
inverter running, register 41 read **`0x1CA4`**. Every set bit is individually
confirmed by its own experiment:

| Bit | Meaning | Confirmed by |
| --- | --- | --- |
| `0x1000` | LED on | light test |
| `0x0800` | AC output on | AC test |
| `0x0400` | DC output on | car port test |
| `0x0080` | DC converter active | USB test, again by the light |
| `0x0020` | DC input present | solar delivering |
| `0x0004` | Inverter active | AC test with no mains |

`0x1CA4 & ~explained == 0` — nothing unexplained remains in an observed status
word. All four outputs and both switch banks are confirmed.

### ✅ The power registers add up

**Light test:** switching the light to "always on" (with AC output still on)
moved status `0x0824` → `0x18A4`, adding `0x1000` (LED) and `0x0080` (DC
converter). The light draws through the converter, exactly as USB does.

The arithmetic is the useful part:

| Register | Raw | Interpreted |
| --- | --- | --- |
| 20 AC output power | `8` | 8 W |
| 15 LED power | `10` | 1.0 W |
| 39 Total output | `9` | 9 W |

8 + 1 = 9. **This proves the 0.1 W scaling rather than assuming it** — at whole
watts the light's raw `10` would have made the total 18. Holding 27 and input 25
both read `1`, matching the unit's "always on" mode and confirming the LED enum
ordering.

### ✅ The light is fully characterised — and is the safe first write


All four LED modes verified on hardware. Holding 27 and input 25 track each
other exactly:

| Mode on the unit | holding 27 | input 25 |
| --- | --- | --- |
| off | `0` | `0` |
| always on | `1` | `1` |
| SOS | `2` | `2` |
| flash | `3` | `3` |

The status bit `0x1000` and the 1.0 W draw stayed constant across the mode
change, so the mode register is independent of the on/off bit. Register 15
reports nominal draw, not instantaneous — it stayed at `10` while flashing.

This makes holding 27 the right target for the first write: the whole read path
is confirmed, the effect is visible across the room, it reverses instantly, and
it cannot touch the battery.

### ⚠️ The inverter backfeeds the AC input sense line

With the inverter running and **nothing plugged into the wall**, input register
21 (AC input voltage) read **59.1 V** — up from 0.2 V. Register 22 (AC input
frequency) stayed at `0`.

An earlier version of the decoder treated anything above 50 V as mains, so this
would have reported the station as grid-connected while it drained its own
battery. Presence now requires **voltage ≥ 100 V *and* frequency ≥ 40 Hz**,
which rejects backfeed and still recognises real mains (~230 V at 50 Hz).

---

## Holding registers (`0x03`) — settings

Values below are from the live unit.

| Reg | Name | Read | Status |
| --- | --- | --- | --- |
| 13 | AC charging power, step 1–5 | `3`→`2` | ✅ writable |
| 15 | **DC input type** (0=PV, 1=DC) | `0`→`1` | ✅ **undocumented** |
| 20 | Max charging current | `20` A | 📖 |
| 24 | USB output | `0`→`1` | ✅ |
| 25 | DC output | `0`→`1` | ✅ |
| 26 | AC output | `0`→`1` | ✅ |
| 27 | LED mode | `0`→`1` | ✅ |
| 56 | Key sound | `1` | 📖 |
| 57 | AC silent charging | `0`→`1` | ✅ |
| 59 | USB standby | `3` min | ✅ |
| 60 | AC standby | `480` min | 📖 |
| 61 | DC standby | `480` min | 📖 |
| 62 | Screen rest | `300` s | 📖 |
| 63 | AC charge booking | `0`→`1439` | ✅ |
| 66 | Discharge floor | `100` → 10 %, `230` → 23 % | ✅ |
| 67 | **AC** charge limit | `600` → 60 % | ✅ |
| 68 | Idle shutdown | `5` min | 📖 |

Every settings register decoded to a value inside its expected whitelist, which
is good evidence the map transfers to this model.

### ✅ Both battery limits confirmed, at arbitrary percentages

Cross-checked against BrightEMS on the same unit:

| Setting in BrightEMS | Register | Raw |
| --- | --- | --- |
| AC charge limit 60 % | holding 67 | `600` |
| AC charge limit 73 % | holding 67 | `730` |
| Discharge limit 10 % | holding 66 | `100` |
| Discharge limit 23 % | holding 66 | `230` |

BrightEMS describes register 67 as: *"In AC charging mode, the energy storage
power supply will stop charging at the set charging level."* The app enforces a
**60 % minimum**, which the device itself may or may not.

The 23 % reading is the valuable one — a non-round value proves the tenths
scaling holds generally rather than only at multiples of ten. It also showed the
UI was wrong: the sliders stepped by 5 and could not have produced 23 %. They
step by 1 now, since the hardware clearly accepts any integer percent.

### ✅ Register 67 caps AC charging only

BrightEMS showed a 60 % charge limit; register 67 read `600`. The name is
literal — **solar charges straight past it**, which is why a station limited to
60 % was sitting at 100 %. Presenting this as a general "stop charging here"
ceiling would have people chasing a fault that does not exist.

### 🆕 Holding 15 is the DC input type — and it is in no published map

BrightEMS calls this **"DC input type setting"**, toggling between **PV**
(photovoltaic) and **DC** (adapter or car). Switching PV → DC moved holding 15
from `0` to `1`.

**This register is undocumented.** Every source we have — schauveau,
ha-fossibot, the BLE work — lists holding registers 0–1, 13, 20, 24–27, 56–68,
73, 78–79. Register 15 is absent. Found purely by diffing.

### ⚠️ Writing register 15 has a side effect

The same change moved **`MAX_CHARGING_CURRENT` (holding 20) from 20 A to 8 A**,
which we never wrote:

| | holding 15 | holding 20 |
| --- | --- | --- |
| PV mode | `0` | `20` A |
| DC mode | `1` | `8` A |
| back to PV, set 16 A | `0` | `16` A |

**8 A is DC mode's ceiling, not a fixed DC value.** Switching to DC clamps a
higher setting down rather than rejecting it; PV mode allows up to 20 A. The
register itself takes arbitrary amps — 20, 8 and 16 all observed. The settings
slider caps itself at 8 A in DC mode accordingly.

Physically sensible — a DC adapter tolerates less current than a solar array —
but it means the station changes settings on its own. **Anything writing this
register must re-read afterwards rather than assume the rest held.** The driver
already re-polls after every write, so this is handled; the simulator models the
same coupling so the behaviour is exercised without hardware.

This is a useful warning for the remaining unknowns: a register write is not
guaranteed to affect only that register.

### ⚠️ AC charging power: the wattage scale is model-specific

BrightEMS offers five AC charging powers. Register 13 stores the **step**, and
input register 2 mirrors it. Confirmed by changing the setting on the unit:

| BrightEMS | Register 13 |
| --- | --- |
| 600 W | `1` |
| 900 W | `2` ✅ observed |
| 1200 W | `3` ✅ observed |
| 1500 W | `4` |
| 1800 W | `5` |

**The published map gives this scale as 300–1100 W for a FOSSiBOT F2400.** The
P280 spans 600–1800 W. Same register, same step encoding, completely different
wattages — so the step-to-watts mapping cannot be carried between models. Any
integration that assumes the F2400 values will show the wrong power on a P280.

**Registers 14 and 16 are the ends of this scale.** Holding 14 reads `1800` and
holding 16 reads `600` — the maximum and minimum of the P280's range. Neither
moved when the power was changed from 1200 W to 900 W, so they are capability
constants rather than settings. That also explains why register 16 held `600`
while the charge limit was 60 %: coincidence, as established above.

**Register 13 is writable, despite the docs marking it read-only.** BrightEMS
changes it, and nothing else in either bank moved when the power changed. It is
now on the write whitelist, restricted to steps 1–5.

### ✅ "AC booking charging" is a countdown, not a clock time

BrightEMS presents this as **HH:MM** — scheduling it for "24:00" looks like
setting an alarm for midnight. It is not. The register stores **minutes until AC
charging is enabled**, and the device counts it down.

Measured directly:

| Time | holding 63 | input 57 |
| --- | --- | --- |
| set to "24:00" | `1439` | `1439` |
| +60 s | `1438` | — |
| +101 s | `1437` | — |

One decrement per minute. Charging resumes at `0`, so `0` means "charging
enabled now", not "scheduled for midnight".

**The maximum is 1439, not 1440.** 24 hours exactly does not appear to be
storable; the published map gives the same bound. The write whitelist and the
schema were both capped at 1440 and are now 1439.

This changed the UI. A slider bound to a value the device decrements would drift
under the user's finger, so the control offers fixed delays (Now / 1h / 4h / 8h
/ 12h / 24h) and reports the live remaining time separately.

### ✅ Standby timers really fire

USB switched itself off roughly three minutes after being enabled with nothing
plugged in — matching holding register 59 reading `3`. Worth knowing while
testing: enable an output, and you have about three minutes before the station
undoes it for you.

### ❓ Unidentified holding registers

| Reg | Read | Hypothesis |
| --- | --- | --- |
| 11 | `0x1500` | bitfield? |
| 12 | `9` | |
| 14 | `1800` | ✅ **maximum AC charging power** — top of the 1–5 scale, unchanged when the power was set to 900 W |
| 16 | `600` | ✅ **minimum AC charging power** — bottom of the same scale |
| 17 | `20` | ✅ **maximum DC charging current** — held at 20 while the actual ceiling went 20 → 8 → 16 A |
| 18 | `115` | limit of some kind? |
| 19 | `550` | pack max voltage, 55.0 V? Right order for a 48 V LiFePO₄ string. |
| 21 | `0x0300` | bitfield? |
| 22 | `233` | 23.3 — temperature? |

### ✅ Registers 14–22 are a capability block

Three are now established, and they share a character: they describe **what the
hardware supports**, not what it is set to.

| Register | Value | Meaning | Proof |
| --- | --- | --- | --- |
| 14 | `1800` | max AC charging power | unchanged while power went 1200 → 900 W |
| 16 | `600` | min AC charging power | unchanged, matches the scale's bottom |
| 17 | `20` | max DC charging current | unchanged while the ceiling went 20 → 8 → 16 A |

That makes 18, 19, 21 and 22 more likely to be limits too — plausibly voltages
and currents. But **none has been moved by anything yet**, which is precisely
why they are still unidentified. Nothing reads them.

It also kills the third and final "mirror" hypothesis. Register 17 read `20`
while max charging current read `20`, then the setting changed and 17 did not
follow. Same story as register 16 and the charge limit. **Two registers holding
the same value has now been coincidence three times out of three.**

### ❓ Registers 70 and 71 look like the displayed state of charge

Both sat at `1000` while SOC (register 56) read `1000`, and both dropped to
`990` at the exact moment SOC fell to `999`:

| Register | Raw | As percent |
| --- | --- | --- |
| 56 state of charge | `999` | 99.9 % |
| 70, 71 | `990` | 99.0 % |

That is consistent with the **whole-percent value the unit's own screen shows**,
stored in tenths — 99.9 % truncates to 99 %. Two data points agree, but two
points also fit several other curves. Needs a third reading at a clearly
different SOC (say 70-something) before it is worth acting on. Nothing uses
these registers today.

### ❌ The "mirror register" hypothesis is dead

Registers 16 and 17 read `600` and `20`, matching the AC charge limit and the
max charging current. That looked like an active-value vs setpoint split, and
was noted as something to be careful about before writing.

**It was a coincidence.** Changing the charge limit from 60 % to 73 % moved
register 67 to `730` while **register 16 stayed at `600`**. They are unrelated.

Two registers holding the same value proves nothing — worth remembering for the
remaining unknowns. Register 16 is more plausibly a voltage or power threshold
that happens to equal 600 (alongside register 19's `550`), but that is a guess
and is not acted on anywhere.

---

## Safety

**Writing `0` to holding register 68 permanently bricks the station.** Three
independent guards, all of which must stay: the register whitelist, the zod
schema, and a test asserting the write is refused.

Registers 25 and 26 reportedly toggle on any write rather than honouring the
value. Not yet confirmed on this unit — the driver reads current state first
and skips redundant writes.

Nothing has been written to this station yet. Everything above was obtained
read-only.

---

## Method

The Protocol tab drives this:

1. **Snapshot baseline** — captures all 160 registers
2. Change **one** thing on the station itself
3. **Dump registers**, then **Show changed only**

Whatever moved is the register behind that control. One change at a time, or
the diff stops being evidence.

The baseline persists to `server/data/baseline.json`, so a server restart — and
`--hot` reloads on every edit — no longer throws away the comparison you were
in the middle of making. Re-snapshot whenever you want a new reference point.

Note the standby timers while testing: USB switches itself off after about
three minutes with no load (holding 59), so take the second dump promptly.

---

## Next

- [x] Toggle USB → confirmed `0x0200`, `0x0080`, holding 24
- [x] Toggle AC output → confirmed `0x0800`, `0x0004` (inverter), holding 26,
      input 18 and 20
- [x] Turn the light on → confirmed `0x1000`, holding 27, input 15 and 25, and
      the 0.1 W scaling via the output sum
- [x] Toggle DC output → confirmed `0x0400` and holding 25
- [ ] Plug a load into USB → confirm registers 30–31 / 34–37 scaling
- [x] LED SOS and flash → all four enum values confirmed (0, 1, 2, 3)
- [ ] Compare input 54 against the temperature BrightEMS reports
- [x] AC charging power → confirmed register 13 (steps 1–5 = 600–1800 W), and
      identified holding 14 and 16 as the scale's maximum and minimum
- [ ] Connect an expansion pack → confirm registers 53 and 55
- [ ] First write, once the above is settled: LED mode. Visible across the
      room, instantly reversible, cannot affect the battery.
