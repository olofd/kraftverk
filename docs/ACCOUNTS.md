# Accounts, homes and a hosted kraftverk

Where accounts are heading, and the order to get there in. Today a server has
local password accounts, every one an administrator, and every device belongs
to the server as a whole. The destination is one codebase that runs as either:

- **a home server** — a NAS or a Raspberry Pi, one household, as now; or
- **a hosted service** on the internet, where many unrelated people sign up —
  with a password, or with Apple or Google — and each sees only their own
  devices.

Nothing here is built yet beyond the first bullet of *Today*. It is written
first because the data model is the expensive thing to change later, and the
cheapest time to change it is before there is much data.

## Today

- Local password accounts, argon2id, cookie sessions. See
  [SECURITY.md](SECURITY.md).
- Everyone signs in — the home network gets no exemption, because devices are
  about to belong to accounts, and an anonymous visitor has no "own".
- Every account is an administrator of everything. One server, one set of
  devices, one set of extensions.

## The model

Four things, kept deliberately separate.

### Account

A person. An internal id and a display name — nothing about *how* they sign in.

### Identity

One way of proving you are that account: a username and password, an Apple ID,
a Google account. An account can have several, so someone who signed up with
Google can add a password, or the other way round.

| provider | subject | secret |
| --- | --- | --- |
| `password` | the username | an argon2id hash |
| `google` | Google's `sub` claim | none — Google vouches |
| `apple` | Apple's `sub` claim | none — Apple vouches |

Keying external identities by the provider's stable subject, never by email,
is what stops an email change or a recycled address from handing an account to
someone else. Linking a new identity to an existing account is always an
explicit act by someone already signed in — never automatic because two emails
match.

### Home

The owner of equipment and everything about it: devices, their recorded
history, extension settings and secrets, the grid-relay pairing, the audit
timeline. A home, not an account, because equipment is shared: a household has
one station and two people, and a person may have a house and a cabin.

Signing up creates a personal home. Sharing is inviting another account into
it, as a **member** (uses everything) or an **owner** (also manages members and
may delete the home). A read-only **viewer** can come later without changing
anything else.

### Operator

Whoever runs the installation — a flag on the account, separate from any home.
The operator decides who may sign up, which extensions are installed, and sees
the broker. On a home server the first account is both operator and owner of the
first home; on the hosted service, the operator is whoever runs it, and has no
business in anyone's home.

## Rules that follow

- **Every home-scoped route names its home**: `/api/homes/:home/devices/...`.
  No "current home" held in the session, for the same reason the server already
  refuses to guess which station a route means: a guess that is right while you
  have one home is wrong, silently, the day you have two.
- **Membership is checked in one place**, before any handler runs — the same
  shape as the sign-in gate — and a route that forgets to scope its queries
  cannot compile: the store takes a branded `HomeId` the way it already takes a
  `SavedDeviceId`.
- **Isolation is tested as an attack**: every home-scoped route is called with
  another home's ids, and every one must answer as though they did not exist.
- **Sign-up is a setting**: `closed` (the operator adds accounts — the home
  server default), `invite`, or `open` (the hosted service).

## The hard part: proving you own a station

On a home server, a station is yours because it is on your network. On a
hosted service that stops being true, and the protocol offers no help: a P280
connects to its broker **with no username and no password** — observed, not
assumed — and names itself only by its MAC, which it also broadcasts over
Bluetooth to anyone nearby. A hosted broker that let an account claim a station
by typing its MAC would let anyone who walked past it take control of it.

Candidates, and why the last is recommended:

| Approach | Problem |
| --- | --- |
| Claim by MAC | Anyone who can see the MAC can claim the station |
| Claim window — start pairing, then power-cycle the station | An attacker can start pairing for your MAC and wait for your routine reconnect |
| A broker port per home | Needs BrightEMS to accept a port, which is unverified; one exposed port per customer |
| **An edge at home** | Needs a small always-on box at home — which a home server already is |

**The edge.** The broker that now runs as its own process becomes the piece
that lives at home: it holds the station on the LAN, where it already is, and
connects *outbound* to the hosted service with a credential issued when the
owner enrolls it with a one-time code from the app. Possession is proven by
being on the LAN with the station; nothing at home is exposed to the internet;
and extensions that only work on a LAN — the Tuya plug is controlled over the
local network — run at the edge too.

A home server is then simply an edge and the service in one box, which is what
it is today.

## Getting there

Each step leaves a home server working, with its data migrated rather than
reset.

1. **Accounts become homes' members.** Add identities (the password moves
   there), homes and memberships, and the operator flag. Existing devices,
   history and settings move into one home owned by the first account, who
   also becomes operator. Home-scoped routes gain their `:home`; the app keeps
   the home you are looking at. Extensions stay installed per server, and are
   configured by the operator until step 3.
2. **Sharing.** Invite an account into a home; owner and member roles; leave or
   remove. The app switches between homes.
3. **Extensions per home.** One instance of an extension per home that enables
   it, with its own settings, secrets and grants; the grid relay per home.
4. **Signing up and signing in with Apple and Google.** The sign-up setting,
   OpenID Connect with PKCE for both providers, and bearer tokens beside the
   cookie for the native apps. (An iOS app that offers Google sign-in must offer
   Sign in with Apple too.) Local password accounts on an open service need a
   verified email and a reset path, and so an email sender.
5. **Edge and cloud.** Enrolment codes, the edge's outbound connection, and the
   hosted service's side of it. By then SQLite may want to be Postgres; the
   store layer is kept behind one module so that is a change in one place.

## Open questions

- Should a device ever be shareable on its own, without sharing the whole home?
  The model allows adding it later; nothing needs it yet.
- Deleting an account that is the only owner of a home: delete the home, or
  require handing it over first?
- On the hosted service, who may see the audit timeline of a home — owners
  only, or members too?
