# @kraftverk/ui — the kit screens are built from

## What it is

The interface primitives every screen uses: cards, rows, toggles,
selectors, schema-driven forms, icons, and how values and units are shown.
React, React Native and Tamagui.

## What it does — and does not

- **Does:** draw; draw a form from a config schema, so a device's
  settings need no screen of their own; work out what drawing needs — how a
  value and its unit read, a chart's axis and gaps, the flow of energy
  through a device from its description; and hold what a control shows
  between a person's touch and the device's answer (the write gate, a
  slider's value while it moves), what the device confirmed until its
  readings say it too (`useConfirmed`), and a number as it is typed
  (`useNumberText`).
- **Does not:** fetch, keep anything past the screen, decide what a device
  does (the gateway's), or know any device type.

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md): the app's screens and a device
package's own (`ui/`) use it; nothing below the edges may.

## Why a package of its own

Because a device brings its own screens in its package, and they must look
like the app's without importing the app.
