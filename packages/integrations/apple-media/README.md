# @kraftverk/integration-apple-media

## What it is

Apple's media devices as a platform: an Apple TV — and, as it comes, a
HomePod — reached on the home network the way Apple's own remote reaches
it, with no cloud. Ported from pyatv, the library behind Home Assistant's
`apple_tv` integration.

## What it does — and does not

- **Does:** speak Companion (`src/protocol/`): its frames, a type byte and
  three of length (`frames.ts`); OPACK, Apple's binary form for its
  messages, references read as pyatv reads them (`opack.ts`); HomeKit's
  pairing (`pairing.ts`) — pair-setup once with the PIN the TV shows (SRP
  over the 3072-bit group with SHA-512, `srp.ts`, checked against HomeKit's
  published vectors), then pair-verify on every connection (X25519, each
  side signing with its Ed25519 key) — after which every frame is sealed
  with ChaCha20-Poly1305 (`companion.ts`); and the remote's session
  (`session.ts`): introduced, begun with the TV's remote service, its
  events asked for (`SystemStatus`, `_iMC`), the remote's keys (`_hidC`),
  media control and volume (`_mcc`), the apps and opening one, and whether
  it is awake. Pairing is a setup action in two turns — the TV shows a PIN
  while the connection the first turn opened stays open, and the second
  turn asks for it (`ask`) — and what it leaves is kept as the connection's
  sealed secret, in pyatv's own form. It finds an Apple TV by the
  `_companion-link._tcp` service it announces, on the port announced, its
  MAC (from AirPlay's announcement of the same host) as its identity.
- **Does not:** offer a device type: an Apple TV as a device — on and off,
  playback, apps, keys, volume, updates pushed — is the next step
  (docs/PLAN-INTEGRATIONS.md, step 20). Nor does it speak AirPlay or MRP
  (what is playing, artwork); pair a HomePod; or reach anything through
  Apple's cloud. Each comes when it is needed and can be checked.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1, §8.5): the one place
kraftverk meets Apple's media devices. Its protocol in `src/protocol/`
imports the SDK and the noble libraries alone (`@noble/hashes`,
`@noble/curves`, `@noble/ciphers`: audited, pure TypeScript) and is pure —
the home network's transport gives it a TCP connection, opened on the port
the TV announced (`Binding.open` with the connection's config) — so it runs
in the app as well as on a server. A setup action reaches the chosen TV
through the context's `open`, which the hub provides. Device packages build
on it.

## Why a package of its own

Because what every Apple media device shares — HomeKit's pairing, how
Companion is framed, sealed and spoken — is written once, and an Apple TV
is then a small package of its own.

## Ported from

| pyatv / Home Assistant | Here |
|---|---|
| `manifest.json`: zeroconf `_companion-link._tcp`, `_airplay._tcp`; `iot_class: local_push` | the `companion` way: `discovery` `_companion-link._tcp`, `reach: local`, `updates: push`; recognised by `rpMd` `AppleTV*` |
| `config_flow.py`: pair, then a PIN per protocol | the `pair` setup action: `ask` for the PIN on a connection kept open |
| `auth/hap_srp.py`, `auth/hap_pairing.py` | `pairing.ts`, `srp.ts`, `tlv8.ts`, `crypto.ts` |
| `protocols/companion/connection.py`, `protocol.py` | `frames.ts`, `companion.ts` |
| `support/opack.py` | `opack.ts` |
| `protocols/companion/api.py` | `session.ts` |
| credentials `ltpk:ltsk:atv_id:client_id` | the same, kept as the `credentials` secret |

## Verified

Nothing yet on a real Apple TV: the protocol is tested against one played in
the tests (`test/played.ts`), which takes the TV's side of pairing and
verification with the same cryptography, and the SRP against HomeKit's
published vectors. It stays experimental until checked on a real TV.

<!-- quality: written by npm run check:integrations -->
## Quality, measured

7 of 7 (docs/PLAN-INTEGRATIONS.md §10):

- ✓ Every type keeps the device-type contract, its simulator included
- ✓ Every value a person reads has a meaning or a quantity
- ✓ Every key, password or token is a secret: sealed, and left out of what is shown
- ✓ Every way says how far it reaches and how what it says arrives
- ✓ A device that announces itself says what it is found by
- ✓ Its packages have tests of their own
- ✓ Its packages say what they are
<!-- /quality -->
