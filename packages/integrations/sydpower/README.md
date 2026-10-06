# @kraftverk/integration-sydpower — the Sydpower stations' platform

## What it is

Sydpower as a platform: the power stations built on its stack — sold as
AFERIY, FOSSiBOT, ABOK and Eco Play — the protocol they speak, and the two
ways one is reached: **Wi-Fi**, the station publishing to this home's MQTT
broker, and **Bluetooth**, from whatever holds it within reach.

## What it does — and does not

- **Does:** speak the Sydpower protocol (`src/protocol/`): MODBUS-style
  frames with a big-endian CRC, register blocks, the MQTT topics and the
  broker's policy, the Bluetooth service and framing — and the
  **register-68 guard** (never written 0: it bricks the station), applied by
  every holder on the channel and by the broker on every publish. Declare
  the platform's ways in (`SYDPOWER_WAYS`), each the protocol over its
  transport, with what each means for whoever holds it. Give a station's
  device package the link it reads registers through (`linkOver`), as calls:
  nobody above it sees a topic.
- **Does not:** know a product — a station's registers, settings, screens
  and pictures are its device package's (`@kraftverk/device-aferiy-p280`) —
  or open a channel: it speaks over one its transport gives. It declares no
  device type of its own yet: a generic Sydpower station is a type it may
  take on when a second product shows what is common.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1): the one place kraftverk
meets the Sydpower stack. It imports the SDK only; device packages for
Sydpower stations import it — and what they need of the wire from
`@kraftverk/integration-sydpower/protocol`.

## Why a package of its own

Because the stack is shared by several brands, and its guard must stand
wherever bytes are sent — a server, a phone, the broker — whichever station
sends them: the ways in and the protocol belong to the platform, so the next
station is a product that names this, not a copy of the P280's.
