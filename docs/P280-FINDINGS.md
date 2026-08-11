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
| 15 | LED power | 0.1 W | 📖 | |
| 18 | AC output voltage | 0.1 V | 📖 | `0` with inverter off |
| 19 | AC output frequency | 0.1 Hz | ⚠️ | reads `500` (50 Hz) **even when AC output is off** — nominal, not measured |
| 20 | AC output power | W | 📖 | |
| 21 | AC input voltage | 0.1 V | ✅ | `2` (0.2 V) with no mains |
| 22 | AC input frequency | 0.01 Hz | ✅ | `0` with no mains |
| 25 | LED state | enum | 📖 | |
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
| 70, 71 | — | — | ❓ | both read `1000` (100.0) |

### ⚠️ Register 48 is a bitmask, not a value

Docs say it reads exactly `0x8000` when charging and `0x4000` otherwise. A real
P280 reports **`0x8040`**. Comparing for equality misses the charging flag
entirely. Mask bit 15.

### Status bitmask — register 41

| Mask | Meaning | Status |
| --- | --- | --- |
| `0x1000` | LED on | 📖 |
| `0x0800` | AC output on | 📖 |
| `0x0400` | DC output on | 📖 |
| `0x0200` | USB output on | ✅ |
| `0x0080` | DC converter active | ✅ |
| `0x0060` | DC input present | ⚠️ |
| `0x0010` | Charging from AC | 📖 |
| `0x000A` | AC input connected | ⚠️ |

**USB test:** switching USB on at the unit moved register 41 from `0x0020` to
`0x02A0` — setting `0x0200` and `0x0080` together. USB feeds through the DC
converter, so both are expected. Holding register 24 went `0` → `1` at the same
time, and nothing else in either bank moved.

**⚠️ `0x0060` bits are not redundant.** Docs claim they are. A panel attached
but producing nothing reads `0x0020`; once solar delivers it reads `0x0060`.
Masking both still answers "is DC input present", which is all we use it for.

**⚠️ AC input mask is `0x000A`, not `0x000E`.** Bit 2 is set on a station
demonstrably running off battery — 1.3 V at 0 Hz, register 48 saying not
charging, discharging with 641 minutes left. Bit 2 tracks something else,
probably the inverter. Corroborated against AC input voltage in the decoder.

---

## Holding registers (`0x03`) — settings

Values below are from the live unit.

| Reg | Name | Read | Status |
| --- | --- | --- | --- |
| 13 | AC charging rate | `3` | 📖 |
| 20 | Max charging current | `20` A | 📖 |
| 24 | USB output | `0`→`1` | ✅ |
| 25 | DC output | `0` | 📖 |
| 26 | AC output | `0` | 📖 |
| 27 | LED mode | `0` | 📖 |
| 56 | Key sound | `1` | 📖 |
| 57 | AC silent charging | `0` | 📖 |
| 59 | USB standby | `3` min | 📖 |
| 60 | AC standby | `480` min | 📖 |
| 61 | DC standby | `480` min | 📖 |
| 62 | Screen rest | `300` s | 📖 |
| 63 | Delay charging | `0` | 📖 |
| 66 | Discharge floor | `100` → 10 % | 📖 |
| 67 | **AC** charge limit | `600` → 60 % | ✅ |
| 68 | Idle shutdown | `5` min | 📖 |

Every settings register decoded to a value inside its expected whitelist, which
is good evidence the map transfers to this model.

### ✅ Register 67 caps AC charging only

BrightEMS showed a 60 % charge limit; register 67 read `600`. The name is
literal — **solar charges straight past it**, which is why a station limited to
60 % was sitting at 100 %. Presenting this as a general "stop charging here"
ceiling would have people chasing a fault that does not exist.

### ❓ Unidentified holding registers

| Reg | Read | Hypothesis |
| --- | --- | --- |
| 11 | `0x1500` | bitfield? |
| 12 | `9` | |
| 14 | `1800` | **AC charging power in watts** — matches the P280's 1800 W input ceiling exactly. The documented 1–5 rate lives in registers 2 and 13 (both read `3`), so this model appears to expose wattage separately. |
| 16 | `600` | **mirrors register 67** (the 60 % AC limit) |
| 17 | `20` | **mirrors register 20** (max charging current) |
| 18 | `115` | |
| 19 | `550` | pack max voltage, 55.0 V? Right order for a 48 V LiFePO₄ string. |
| 21 | `0x0300` | bitfield? |
| 22 | `233` | 23.3 — temperature? |

**Registers 16 and 17 mirroring 67 and 20 is worth care before writing.** It
may be an active-value vs setpoint split. Writing a setpoint while its mirror
disagrees is a good way to get behaviour nobody expects.

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

---

## Next

- [ ] Toggle AC output → confirm mask `0x0800` and holding 26
- [ ] Toggle DC output → confirm mask `0x0400` and holding 25
- [ ] Turn the light on → confirm mask `0x1000`, holding 27, input 15 and 25
- [ ] Plug a load into USB → confirm registers 30–31 / 34–37 scaling
- [ ] Compare input 54 against the temperature BrightEMS reports
- [ ] Check whether BrightEMS exposes an "AC charging power" setting showing
      1800 W, which would confirm holding 14
- [ ] Connect an expansion pack → confirm registers 53 and 55
- [ ] First write, once the above is settled: LED mode. Visible across the
      room, instantly reversible, cannot affect the battery.
