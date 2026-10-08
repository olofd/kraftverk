# @kraftverk/identity — who a person is

## What it is

A person as kraftverk knows them (docs/PLAN-WORLD-MODEL.md §10): a stable
id — `p-` and a ULID, made where they signed up — and a chain of
statements, each signed by a key they hold. The first says who they are
and is signed by their first key; later ones add a key (another device,
the recovery key) or revoke one, change their profile, or link an
identity they have at a sign-in provider. Whoever is shown the chain checks it, so no one can claim to be
someone else: they cannot sign as them.

## What it does — and does not

- **Does:**
  - the chain: `createPerson`, `addKey` (signed in by a key the person
    has, and proven by the new key's own signature), `say` (a key revoked,
    the profile, an identity linked or unlinked), and `checkChain` — each
    statement in order after the one it names, no earlier, signed by a key
    held then and not revoked; a person keeps at least one key;
  - keys: the `SigningKey` port (a public JWK and `sign`), P-256 ECDSA over
    SHA-256, signatures as r ‖ s; `verify` that takes Web Crypto's
    signatures as they are; a key's id as its RFC 7638 thumbprint;
    `webCryptoKey` (a non-extractable pair, as a browser keeps it) and
    `softwareKey` (a private scalar held in memory while it signs, as a
    phone reads it from its keystore);
  - recovery words: twelve of BIP 39's English list, the key made from them
    each time they are typed;
  - signing in at a node: a challenge, its answer, and the check;
  - a sign-in provider's ID token (OpenID Connect): reading it, and
    checking its signature against the provider's published keys, its
    audience, its age and its nonce. Which providers there are is their
    packages' (`packages/sign-in/*`): this names none.
- **Does not:** keep anything, or know any platform. Where a key's private
  half lives — IndexedDB, a phone's keystore — is the place's
  (`client/src/platform/`); which people a family has, and which keys a
  node signs people in by, are the store's and the hub's; fetching Apple's
  key set is whoever checks a token.

## Where it fits

At the bottom of the layers beside `device-sdk`: it imports neither, only
`@noble/curves`, `@noble/hashes` and `@scure/bip39`, which run everywhere
kraftverk does — a phone's Hermes has no Web Crypto, so verifying never
needs it. The contract, the store, the hub and the app's client import it.

## Why a package of its own

Because a person's chain must be checked the same way by every node and
every app that is shown it: one implementation, with no storage and no
platform, tested by itself. Its dependencies — elliptic curves, recovery
words — are no one else's business, and stay here.
