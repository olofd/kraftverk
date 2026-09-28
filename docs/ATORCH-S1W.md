# ATORCH S1W and the Tuya local protocol: research and findings

The smart plug's counterpart to [`P280-FINDINGS.md`](P280-FINDINGS.md): what is
known about the protocol and this plug, where each claim comes from, and what
still has to be settled on the actual unit. The plug's role in the product —
it switches the mains feeding the station — is in
[`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). How it is modelled is in
[`ARCHITECTURE.md`](ARCHITECTURE.md): the `tuya-local` protocol over the `lan`
transport, and `atorch.s1w` and `tuya.plug` as device types in the Smart plugs
category.

The code today is the `tuya-local-grid-relay` plugin; step 8 of the plan moves
its protocol code to `protocol-tuya-local` and step 9 makes the plugs device
types. Everything below is about the hardware and the wire, and does not change
with that move.

---

## 1. The protocol is documented

[`jasonacox/tinytuya`](https://github.com/jasonacox/tinytuya) publishes
[`PROTOCOL.md`](https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md), a complete
specification of the Tuya LAN protocol. The code here implements 3.3, 3.4 and 3.5 from it
directly, with no third-party runtime dependency.

| Aspect | 3.1 | 3.3 | 3.4 | 3.5 |
| --- | --- | --- | --- | --- |
| Frame prefix / suffix | `55AA` / `AA55` | `55AA` | `55AA` | `6699` / `9966` |
| Encryption | AES-ECB (control only) | AES-ECB (all) | AES-ECB + session key | AES-GCM + session key |
| Integrity | CRC32 | CRC32 | HMAC-SHA256 | GCM tag |
| Handshake | none | none | 3-way | 3-way |

- **Frame layout:** prefix, 32-bit sequence, 32-bit command, length, payload,
  integrity, suffix. On 3.5: prefix, two zero bytes, sequence, command, length
  (counting IV, payload and tag), a 12-byte IV, the payload, a 16-byte GCM tag,
  suffix; the header after the prefix is the GCM additional data.
- **The version header** (`3.x` and twelve zero bytes) goes in front of the
  encrypted payload on 3.3, and inside the encryption on 3.4 and 3.5 — only on
  commands that carry one, not on queries, heartbeats or the handshake. An
  earlier version of this code had the 3.5 layout and the 3.4 header placement
  wrong; both now follow tinytuya's implementation, and are tested against a
  scripted device. Neither is yet confirmed on real hardware.
- **Session negotiation (3.4/3.5):** `START 0x03` sends the client nonce;
  `RESP 0x04` returns the device nonce plus HMAC-SHA256; `FINISH 0x05`
  completes it. The session key is the XOR of both nonces, then AES: ECB for
  3.4, GCM for 3.5 with IV = the first 12 bytes of the client nonce.
- **Commands:** status is `0x0A` (`DP_QUERY`), or `0x10` (`DP_QUERY_NEW`) on
  3.4+. Control is `0x07` (`CONTROL`), or `0x0D` (`CONTROL_NEW`) on 3.4+ and
  on "device22" units.
- **On the wire:** TCP **6668**, and UDP broadcast discovery on 6666/6667.
  Persistent connections keep the negotiated session key.

In the architecture's terms: framing, crypto, the handshake and the discovery
packets are the protocol. The sockets are the `lan` transport. What each
datapoint means is the device type's.

## 2. This device family is already mapped elsewhere

[`make-all/tuya-local`](https://github.com/make-all/tuya-local), a Home Assistant integration, lists
**"Atorch S1BW, S1WP energy monitoring switches with display"** among its supported devices. Its
configuration files are the closest thing to a published datapoint map for this plug. They are also
the model for how many sockets become supportable: one type, with a profile of data per socket,
rather than code per model (ARCHITECTURE.md §2, *Device type*).

Datapoints gathered from its issue tracker:

| DP | Meaning | Notes |
| --- | --- | --- |
| 1 | `switch_1`, the relay | boolean; **but see the warning below** |
| 9 | countdown timer | seconds, 0–360000 |
| 17 | `add_ele`, energy increment | |
| 18 | `cur_current` | scale 3 → mA |
| 19 | `cur_power` | scale 2 |
| 20 | `cur_voltage` | scale 2 |
| 101 / 102 / 103 | price / cost / added cost | |
| 104 / 105 / 106 | over-voltage / over-current / over-power protection | |
| 123 | `ele`, total energy (kWh) | |
| 131 / 132 | relay mode, warning flags | |
| 133 / 134 / 135 | frequency, power factor, CPU temperature | |

Product ids seen in the wild: **S1WP `sqrf2g1amfutn4co`** and **S1BW `pl28o0wkaopyft8u`** (the
S1BW is described as "the same as S1WP but with bluetooth").

> ⚠️ **Sources disagree about which datapoint switches the relay.** The Tuya product
> specification lists DP 1. The OpenBeken community reports that on this ATORCH S1 "the real
> relay control" is **dpId 131**, and that DP 1 does not do the job. Do not pick one. The
> ATORCH's setup settles it on the unit, in its check step, and records the answer in the
> device's config.

[`Windear/local_tuya_3.5`](https://github.com/Windear/local_tuya_3.5), a Home Assistant component
written for Atorch-branded Tuya energy meters on protocol **3.4/3.5**, is evidence that at least
some Atorch units are on the newer protocol. A 3.3-only client is not safe to assume.

## 3. Libraries that exist

| Project | Language | Protocols | Assessment |
| --- | --- | --- | --- |
| [`codetheweb/tuyapi`](https://github.com/codetheweb/tuyapi) | JS | 3.1–3.3 | Mature, but only bug fixes now; 3.4/3.5 are open requests ([#481](https://github.com/codetheweb/tuyapi/issues/481)) |
| [`@tuyapi/driver`](https://github.com/tuyaapi/driver) | TypeScript | unverified | Young and unproven |
| [`jasonacox/tinytuya`](https://github.com/jasonacox/tinytuya) | Python | 3.1–3.5 | The reference implementation and the spec author: the commissioning tool of choice, not a runtime dependency |
| [`tuyaapi/stub`](https://github.com/tuyaapi) | JS | — | A stub of the protocol for local testing, worth mining for the ATORCH simulator |

None of them is a dependency. Implementing from `PROTOCOL.md` kept the protocol code free of
runtime dependencies, as ARCHITECTURE.md §3 requires, and covers 3.4/3.5.

## 4. Commissioning: key, discovery, datapoints

- **Local key and device id.** `npm run keys:tuya` fetches them through a free Tuya cloud
  project; [`TUYA-LOCAL-KEY.md`](TUYA-LOCAL-KEY.md) is the five-minute guide. The plug must first
  be activated in the Smart Life app. `python -m tinytuya wizard` does the same.
- **LAN scan.** `npm run scan:tuya` (or `python -m tinytuya scan`) prints each device's address,
  id and **protocol version** from its UDP broadcast, with no credentials.
- **Datapoint dump.** Reading every datapoint with its raw value and type, so the map is recorded
  rather than assumed. Today that is the plugin's *Test* action. From step 9 it is the ATORCH's
  check step.

## 5. The escape hatch: replace the firmware

The ATORCH S1-B/W/T/H is built on a **BK7231N (CB2S/C3BS) module**, which
[OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) supports — a Tasmota/ESPHome-style
open firmware — and [tuya-cloudcutter](https://www.elektroda.com/rtvforum/topic3979215.html) can
flash it **over Wi-Fi, without opening the case or soldering**. Community reports say that from
OpenBeken 1.17.406 this ATORCH S1 works with nine mapped channels and relay control on dpId 131.

An OpenBeken plug speaks plain MQTT, and this server already runs an MQTT broker. In the
architecture that is a new protocol (`openbeken`) with a binding for the existing `mqtt` transport,
plus a connection method on the ATORCH type: no local key, no cloud account and no handshake.

The costs are real: flashing can brick the plug, it voids any warranty, and in practice it is a
one-way door. It is recorded as an option, not a recommendation.

## 6. What the network has shown

Found on the owner's LAN with `npm run scan:tuya`, with no credentials (addresses replaced with
documentation addresses):

| Device | Address | Protocol | Product key |
| --- | --- | --- | --- |
| `bf8dc9…96h6ff` | 192.0.2.74 | **3.4** | `keym557nqw3p8p7m` |
| `505660…f4d5` | 192.0.2.17 | **3.3** | `toidnjcqfwlzqnlp` |

Two Tuya devices on two protocol versions, which is why the code implements both and defaults to
**Detect**: it tries 3.4, then 3.3, then 3.5, and reports which one answered. The second device's id
embeds its MAC (`bcddc23af4d5`, an Espressif OUI). The ATORCH S1 uses a Beken BK7231N, so the 3.4
device is the likelier plug, but neither is confirmed until a datapoint dump.

Connecting with a deliberately wrong key produced the diagnostic the design wants: a socket that
opens proves nothing about whether it can be read.

```
3.4: Connection closed | 3.3: connected, but no datapoints could be decoded —
usually a wrong local key | 3.5: The device did not answer command 0x3 in 5000ms
```

## 7. Still to be established on the actual unit

Nothing above replaces these:

1. **Exact model and product id.** The listing points at the S1W; the published configs are for
   the S1BW and S1WP.
2. **Protocol version**, from the scan.
3. **Which datapoint really switches the relay:** DP 1 or DP 131.
4. **Scaling** of voltage, current, power and energy, confirmed against the plug's own LCD.
5. **Power-on relay behaviour:** on, off, or last state. The fail-safe design depends on it, and it
   must be tested with a real power cut, not assumed.
6. **Sustained current and plug temperature** during a full P280 AC charge. Marketing says 16 A,
   but a reseller specification gives the **internal relay as 10 A / 2650 W at 265 V**. The P280's
   1800 W input is about 7.8 A at 230 V, inside that figure but not by a wide margin.

### The hardware sequence

In order, each logged: scan → datapoint dump → 20 manual toggles with no critical load → a power
cut, to establish boot behaviour → relay off with a small load, confirming the P280's AC input
disappears in **both** station telemetry and the plug's meter → a transfer test → a full charge
cycle, watching current and plug temperature. The acceptance checklist before any automation may
switch it is in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md#s1w-discovery-and-acceptance-checklist).

---

## Sources

- [tinytuya](https://github.com/jasonacox/tinytuya) and its
  [PROTOCOL.md](https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md): the Tuya LAN
  protocol specification, wizard, scan and datapoint detection
- [make-all/tuya-local](https://github.com/make-all/tuya-local):
  [DEVICES.md](https://github.com/make-all/tuya-local/blob/main/DEVICES.md) lists Atorch S1BW/S1WP;
  [issue #3253](https://github.com/make-all/tuya-local/issues/3253) (S1BW datapoints, product id)
  and [issue #1103](https://github.com/make-all/tuya-local/issues/1103) (S1WP datapoint dump)
- [Windear/local_tuya_3.5](https://github.com/Windear/local_tuya_3.5): Atorch energy meters on
  protocol 3.4/3.5
- [codetheweb/tuyapi](https://github.com/codetheweb/tuyapi) and
  [issue #481](https://github.com/codetheweb/tuyapi/issues/481): Node client, 3.4 support request
- [@tuyapi/driver](https://github.com/tuyaapi/driver): TypeScript next-generation driver
- [OpenBK7231T_App / OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) and the
  [ATORCH S1 teardown thread](https://www.elektroda.com/rtvforum/topic4003739.html): BK7231N
  module, relay on dpId 131, MQTT firmware replacement
- [tuya-cloudcutter device list](https://www.elektroda.com/rtvforum/topic3979215.html):
  over-the-air flashing without soldering
- [Tuya Local and Protocol 3.5 support](https://limbenjamin.com/articles/tuya-local-and-protocol-35-support.html)
- [ATORCH S1W manual / product identification](https://device.report/m/0f4c63795525e741cd5ec2098faecbcdc8e00882380fe744b53d6516a9130932)
- [S1W reseller specification, with the 10 A relay statement](https://fr.sdtek.com/e/120701-6555723/)
