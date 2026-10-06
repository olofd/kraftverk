# @kraftverk/integration-sydpower — the Sydpower stations' platform

## What it is

Sydpower as a platform: the power stations built on its stack — sold as
AFERIY, FOSSiBOT, ABOK and Eco Play — and the two ways one is reached:
**Wi-Fi**, the station publishing to this home's MQTT broker, and
**Bluetooth**, from whatever holds it within reach.

## What it does — and does not

- **Does:** declare the platform's ways in (`SYDPOWER_WAYS`), each the
  Sydpower protocol over its transport, with what each means for whoever
  holds it.
- **Does not:** know a product — a station's registers, settings, screens
  and pictures are its device package's (`@kraftverk/device-aferiy-p280`) —
  or speak the protocol, which is `@kraftverk/protocol-sydpower`'s, guard
  and all. It declares no device type of its own yet: a generic Sydpower
  station is a type it may take on when a second product shows what is
  common.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1): the layer between a protocol
and the products on it. It imports the SDK and the Sydpower protocol; device
packages for Sydpower stations import it.

## Why a package of its own

Because the ways in belong to the platform, not to one station: every
Sydpower station is reached over the same broker and the same Bluetooth
service, so the next one is a product that names this, not a copy of the
P280's connections.
