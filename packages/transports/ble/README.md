# @kraftverk/transport-ble — Bluetooth LE

## What it is

Bluetooth LE, for every place kraftverk runs: the server's radio (noble),
a browser's Web Bluetooth, and a phone's.

## What it does — and does not

- **Does:** find devices, and open the GATT layout a protocol asks for,
  handing back its bytes; one entry per place (`server`, `web`,
  `native`).
- **Does not:** know a protocol or a device.

## Where it fits

A transport (docs/ARCHITECTURE.md §3): the platform layer, importing only
the SDK. Holders open its channels; protocols speak over them.

## Why a package of its own

Because radios are platform code, and kept here nothing else touches a
platform API — the app bundles the entries for where it runs, never the
server's.
