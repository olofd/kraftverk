# @kraftverk/integration-icloud

## What it is

iCloud as a platform: an Apple ID signed into as icloud.com is, and Find My —
where the account's devices, and its family's, are and how charged. Ported
from Home Assistant's `icloud` integration and pyicloud
([docs/PORTING-FROM-HOME-ASSISTANT.md](../../../docs/PORTING-FROM-HOME-ASSISTANT.md)).

## What it does — and does not

- **Does:** sign in to an Apple ID as iCloud's web client does — SRP-6a
  (`src/protocol/srp.ts`: the 2048-bit group of RFC 5054, SHA-256, the
  password stretched with PBKDF2 and never sent), a second factor asked for
  in turns of the setup step (`ask`): a code from a trusted device, or texted
  to a trusted number, by choice or when Apple sends none to a device — then
  has Apple trust this client, so signing in again with the password asks no
  code (`auth.ts`); keep the session — its trust token, Apple's headers and
  its cookies (`cookies.ts`) — as a secret the session writes itself
  (`kept: 'session'`), and carry it on with no person, or say it waits on one
  (`NeedsSignIn`) when Apple asks for a code again; list Find My's devices,
  the family's included, with where each is, how sure, and its charge; play
  a sound on one; put one in lost mode (`findmy.ts`).
- **Does not:** yet offer the account and its devices as devices (step 18,
  `icloud.account` and `icloud.device`); Apple's newer trusted-device
  verifier (its "bridge" over Apple's push service) — a code is texted when
  Apple routes a sign-in there; people's own locations (Find My Friends is
  not on the web); China's iCloud (`icloud.com.cn`); anything in a browser,
  whose page Apple's hosts do not answer.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1): the one place kraftverk
meets iCloud. Its protocol in `src/protocol/` imports the SDK alone and is
pure. It reaches Apple's sign-in host and iCloud's hosts and no others: the
`https` transport's channel allows `https://idmsa.apple.com` and
`https://*.icloud.com` — the hosts iCloud names at sign-in are numbered
(`p42-fmipweb.icloud.com`).

## Why a package of its own

Because signing in to Apple and speaking to iCloud is written once, for
every device behind an Apple ID — a phone, a Mac, AirPods, a family
member's — and each is then a small package of its own, if it ever needs
one.

## Verified

Against Apple played in its tests (`test/apple.ts`), with made-up data: the
SRP proof checked by a server that holds only the password's verifier; the
second factor by device and by text; trust; the session carried on and
signed in again with no code; Find My, a family member's device included.
Not yet against Apple itself: that is the owner's Apple ID, at setup.

Apple changes this sign-in several times a year. pyicloud's issue tracker
(github.com/timlaing/pyicloud) is the early warning.

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
