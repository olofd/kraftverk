# @kraftverk/device-sdk — the contract every package keeps

## What it is

The contract between kraftverk and everything that plugs into it: what a
device type, a protocol and a transport are, and how a device describes
itself. Types, validation and a few pure helpers; no runtime, no
dependencies.

## What it does — and does not

- **Does:** values and their types; meanings (`battery.soc`, `power.draw`)
  and their units; capabilities and their commands; descriptions — parts,
  attributes, events; links between parts; categories; config schemas;
  `DeviceType`, `DeviceSession`, `ConnectionMethod`, `Protocol`,
  `Transport` and the channels they hand each other; identity and health;
  keys; time on a home's clock; what a description offers to be switched
  and told, for a device nobody drew a screen for (`togglesOf`,
  `settingsForms`). `validateDeviceType` and the contract suite every
  package runs (`@kraftverk/device-sdk/testing`).
- **Declares the ports packages are handed:** a device's own store, a
  transport's store, a scoped HTTP client, and the home's `Clock` — real
  time, or a `scaledClock` a test of simulated devices runs fast — which a
  device's context carries, with a simulator's world (`Simulation`: what it
  was set up with, the type's `simulation` fields; whether a simulated switch
  that feeds one of its parts gives it power).
- **Does not:** run anything, hold a device, keep anything, or know any
  product. Automations are `@kraftverk/automation`'s, not the contract's: a
  package that brings recipes imports that language beside this.

## Where it fits

The bottom of the layers (docs/PLAN-SHARED-CORE.md): every other package
depends on it, and it on nothing. `everywhere.d.ts` beside it declares the
globals every place kraftverk runs has — the server, a browser, a phone —
and shared code is typechecked against those alone.

## Why a package of its own

Because a device type is written against it and nothing else. A package
author needs one small, stable thing to depend on — not the server, the
app, or the runtime that will run their code — and the server, the app and
every package agree on one definition of what a device is, how it is
reached, what it reports and what it can do. The design is
docs/ARCHITECTURE.md §4.
