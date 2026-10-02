# @kraftverk/protocol-sydpower — the Sydpower stations' protocol

## What it is

The protocol spoken by Sydpower-stack power stations (AFERIY, FOSSiBOT,
ABOK, Eco Play): MODBUS-style frames with a big-endian CRC, register
blocks, and bindings for MQTT and Bluetooth.

## What it does — and does not

- **Does:** build and read frames; the register-68 guard (never written
  0: it bricks the station), applied by every holder on the channel and by
  the broker on every publish; MQTT topics and broker policy; the Bluetooth
  service and framing.
- **Does not:** know a model — the P280 is its device type's — or open a
  channel: it speaks over one it is given.

## Where it fits

A protocol (docs/ARCHITECTURE.md §3): pure, importing only the SDK.
Device types use it; transports carry its bytes.

## Why a package of its own

Because several brands share the stack, and its guard must stand wherever
bytes are sent — a server, a phone, the broker — whichever device type
sends them.
