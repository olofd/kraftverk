# @kraftverk/device-apple-tv — the Apple TV

## What it is

An Apple TV (HD, 4K) on the home network, reached the way Apple's own remote
reaches it — Companion — with no cloud. A product on the
[apple-media integration](../../integrations/apple-media/README.md), which
speaks Companion and pairs with the TV; ported from pyatv, the library behind
Home Assistant's `apple_tv`. `support: 'experimental'` until it has been
checked against a real Apple TV.

## What it does — and does not

- **Does:** `apple-media.tv`, one part that offers what a TV does, each a
  capability from the library:
  - `switch` — on is awake, off asleep (the remote's wake and sleep keys).
  - `mediaPlayback` — play or pause, next, previous; `playing` read from
    what the TV says can be done now (`_iMC`): something that can be paused
    is playing.
  - `keypadInput` — the remote's keys: arrows, select, back, home,
    play/pause, volume.
  - `applicationLauncher` — its apps listed (a query), and one opened.
  - `volume` — how loud, 0–100 %, where it controls a TV or a receiver
    that lets it; unknown otherwise.

  Kept current by what the TV tells as it changes (`_iMC`, `SystemStatus`),
  asked whether it is awake once a minute, and asked again a moment after
  every command, so the gateway reads back what changed. Every connection
  is verified again with what pairing left; a pairing the TV no longer
  keeps puts the device on Home as waiting on you. Known by the pairing id
  the TV verifies with. A simulator for trying it without one.
- **Does not:** speak Companion or pair: its integration does both. Nor
  does it say what is playing (title, artwork, position: MRP over AirPlay,
  not yet ported), turn the TV set on or off over HDMI-CEC beyond what the
  Apple TV does itself, or type text.

## Where it fits

A device package (docs/PLAN-INTEGRATIONS.md §1.1, §8.5): built on
`@kraftverk/integration-apple-media`, importing it and the SDK and nothing
else. Found by the `_companion-link._tcp` service an Apple TV announces,
its model code `AppleTV*` — the integration's way, narrowed to it;
paired in setup's credentials step, with the PIN it shows.

## Why a package of its own

Because what an Apple TV does — and what a HomePod, on the same integration,
does not — is the product's, and device-specific code stays in its package.

## Verified

Against an Apple TV played in the tests (`@kraftverk/integration-apple-media/testing`),
byte for byte over Companion, and end to end in the server's tests
(`server/test/apple-tv.test.ts`): found by its address, paired with
its PIN, saved, and paused by an automation through the gateway. Not yet
against a real Apple TV: whether a playing TV offers pause in `_iMC` — what
`playing` is read from — is the first thing to check on one.
