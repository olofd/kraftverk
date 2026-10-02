# @kraftverk/ui — the kit screens are built from

## What it is

The interface primitives every screen uses: cards, rows, toggles,
selectors, schema-driven forms, icons, and how values and units are shown.
React, React Native and Tamagui.

## What it does — and does not

- **Does:** draw; and draw a form from a config schema, so a device's
  settings need no screen of their own.
- **Does not:** fetch, decide or keep anything, or know any device type.

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md): the app's screens and a device
package's own (`ui/`) use it; nothing below the edges may.

## Why a package of its own

Because a device brings its own screens in its package, and they must look
like the app's without importing the app.
