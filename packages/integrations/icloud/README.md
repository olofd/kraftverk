# @kraftverk/integration-icloud

## What it is

iCloud as a platform: an Apple ID signed into as icloud.com is, and Find My —
where the account's devices, and its family's, are and how charged. Ported
from Home Assistant's `icloud` integration and pyicloud
([docs/PORTING-FROM-HOME-ASSISTANT.md](../../../docs/PORTING-FROM-HOME-ASSISTANT.md)).

## What it does — and does not

- **Does:** sign in to an Apple ID as iCloud's web client does in 2026
  (docs/ICLOUD.md) — SRP-6a (`src/protocol/srp.ts`: the 2048-bit group of
  RFC 5054, SHA-256, padded as Apple's own client pads, the password
  stretched with PBKDF2 and never sent); then, when Apple asks, a code: asked
  for on the trusted devices (Apple shows none until asked), or texted or
  read out by a call to a trusted number, each one tap away under "Didn't get
  a code?", waiting longer each time (`sign-in.ts`); Apple's options read
  from its page's boot_args or its JSON, in either nesting (`options.ts`);
  Apple's escrow step — the password proved once more — when it asks; then
  trust, so signing in again with the password asks no code (`auth.ts`).
  Keep the session — its trust token, Apple's headers and its cookies
  (`cookies.ts`) — as a secret the session writes itself (`kept: 'session'`),
  and carry it on with no person: looked at every six hours, renewed with the
  trust token past half the trust's life (about 90 days), never two silent
  sign-ins within 15 minutes, and Apple refusing one waited out twice as long
  each time, the wait kept across restarts. Say until when it is signed in,
  warn a week before that ends unrenewed (`sign-in-ending`), and say it waits
  on a person (`NeedsSignIn`) when Apple asks for a code again. List Find My's devices,
  the family's included, with where each is, how sure, and its charge; play
  a sound on one; put one in lost mode (`findmy.ts`). Offer the account as a
  device of its own — `icloud.account`, a bridge to every device in its Find
  My (`account.ts`), asking every two minutes while one someone added moves
  (four on a low battery) and every fifteen while nobody does, as Home
  Assistant's iCloud account does, since asking locates every device and
  costs batteries — and each device in it as `icloud.device` (`device.ts`):
  where it is (a `position`, the `location` capability, which `distance`
  in an automation measures from the home: "when Sam's phone gets home"),
  its charge and whether it is charging, whose it is, a sound played
  (`identify`), and lost mode, a tool a person confirms, never an
  automation's. Where someone is, is not kept in history. A device in Find
  My has a screen of its own (`ui/`): where it is as a place, when it was
  located and when it is looked for next, what it is (drawn: a phone, a
  tablet, a Mac, a watch, earbuds), whose, how charged, and "Locate now"
  and "Play sound". While its own page is open its account asks Find My
  every minute — never for a list it is in, since every ask locates every
  device on the account.
- **Does not:** Apple's trusted-device "bridge" over its push service —
  where Apple routes a sign-in there, the code is asked for the plain way and
  a text or a call is one tap away; security keys; accept Apple's updated
  terms (a person does, at icloud.com); people's own locations (Find My
  Friends is not on the web); China's iCloud (`icloud.com.cn`); anything in a
  browser, whose page Apple's hosts do not answer.

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

Against Apple played in its tests (`test/apple.ts`), as Apple answers in
2026, with made-up data: the SRP proof checked by a server that holds only
the password's verifier, an A that begins with a zero byte included; the
options in boot_args and flat; a code asked for, shown again, texted,
called; escrow after a code and after a trust token; trust; the session
carried on, renewed past half its trust and waited out when Apple refuses;
Apple's terms; Find My, a family member's device included. Against Apple
itself: the password, Apple's options and its asking for a code, at the
owner's setup on 2026-10-08.

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
