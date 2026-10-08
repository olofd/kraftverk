# Accounts, homes and a hosted kraftverk

Where accounts are heading, and in what order. The first half is decided; the
rest is direction, written down now because the data model is the expensive
thing to change later.

## Two ways to run it, one codebase

- **Self-hosted** — the first and main case. Someone runs their own server on
  a NAS, a Raspberry Pi or a PC at home, and is its operator. Everything is
  open source: they can build and serve their own app too. They add the
  accounts — family, a friend they trust — and nobody signs up. This is what
  the author runs at home, deployed by its own pipeline (DEPLOY.md).
- **Hosted** — later. A service on the internet for people with no server at
  home, where strangers sign up — with a password, or with Apple or Google —
  and each sees only their own equipment.

Both run the same software. A self-hosted server can have several accounts
and several homes; it just never has strangers. The hosted service is the same
model with sign-up switched on, and one extra piece for reaching stations (see
[Stations on the internet](#stations-on-the-internet)).

## Today

*(Since W3, 2026-10-08, an account is a **person** — an id and a chain of
statements they sign — kept on their own devices, made in the app with no
server, locally or with Sign in with Apple. A server's logins each name a
person, and a person's device signs in by its key. See
[PLAN-WORLD-MODEL.md](PLAN-WORLD-MODEL.md) §10. What follows is the server
as it was before, and still is for a login with a password.)*

- Local password accounts, argon2id, cookie sessions. See
  [SECURITY.md](SECURITY.md).
- Everyone signs in, at home too, for reads as well as writes.
- Every account is an administrator of everything: one server, one set of
  devices. Every change to equipment is recorded in the
  audit timeline under the account that made it.

That is enough for a self-hosted server whose accounts are all people the
owner trusts with the house, and it is what gets deployed first.

## The model

Four things, kept deliberately separate. Documented here, not yet built.

### Account

A person. An internal id and a display name — nothing about *how* they sign in.

### Identity

One way of proving you are that account: a username and password, an Apple
ID, a Google account. An account can have several.

| provider | subject | secret |
| --- | --- | --- |
| `password` | the username | an argon2id hash |
| `google` | Google's `sub` claim | none — Google vouches |
| `apple` | Apple's `sub` claim | none — Apple vouches |

External identities are keyed by the provider's stable subject, never by
email, so an email change or a recycled address cannot hand an account to
someone else. Linking a new identity to an existing account is always an
explicit act by someone already signed in — never automatic because two emails
match.

### Home

*(Since 2026-10-08 this is the **family**: the root of one database, which
has homes — properties — inside it. See [PLAN-WORLD-MODEL.md](PLAN-WORLD-MODEL.md).
What follows says "home" as it was written.)*

What you create, and then add devices to. A home owns equipment and
everything about it: devices, how each is reached and its secrets, their
recorded history, the links between them, the audit timeline. How that looks in
the database is [DATA-MODEL.md §7](DATA-MODEL.md).

A home has one **owner** — the account that created it, who manages who else
is in it and may delete it — and any number of **members**, who use
everything in it. Ownership can be handed over. A read-only **viewer** can
come later without changing anything else.

A home, not an account, because equipment is shared: a household has one
station and two people, and one person may have a house and a cabin.

### Operator

Whoever runs the server — a flag on an account, separate from any home. The
operator adds and removes accounts, decides which device types are installed,
and sees the broker. On a self-hosted server the owner of the first home is
the operator too. On the hosted service the operator runs the installation and
has no business in anyone's home.

## Rules that follow

- **Every home-scoped route names its home**: `/api/homes/:home/devices/...`.
  No "current home" held in the session, for the same reason the server
  already refuses to guess which station a route means: a guess that is right
  while you have one home is wrong, silently, the day you have two.
- **Membership is checked in one place**, before any handler runs — the same
  shape as the sign-in gate — and a query that forgets to scope itself does not
  compile: the store takes a branded `HomeId`, the way it already takes a
  `SavedDeviceId`.
- **Isolation is tested as an attack**: every home-scoped route is called with
  another home's ids, and every one must answer as though they did not exist.
- **Sign-up is a setting**: `closed` (the operator adds accounts — every
  self-hosted server), `invite`, or `open` (the hosted service).

Until homes exist, new code keeps to the same shape so that adding them is a
migration rather than a rewrite: state about equipment belongs to a device or
a pairing, never to "the server"; every change is audited under an account.

## Stations on the internet

This is the one part of the hosted service that does not follow from the
model, and the reason is the station, not kraftverk.

### What is safe, and what is not

**Your own server, reachable from the internet, is fine** — that is the
self-hosted deployment. The internet reaches exactly one thing: the web app,
over HTTPS, behind a login. The station never leaves the LAN: it talks to the
broker on the same network, the broker to the server, and the server to you.

**A station talking to a server across the internet is not**, however the
server is built, because of three facts about the P280's firmware that no
server can change:

1. **It proves nothing about itself.** It connects to its broker with no
   username and no password — seen in the broker's journal, not assumed.
2. **The only name it has is public.** It identifies itself by its MAC,
   which it also broadcasts over Bluetooth to anyone within range, and which
   is printed in its topics.
3. **It speaks plain MQTT, unencrypted**, on the address BrightEMS gives it.

On a LAN those are harmless, because the LAN itself is the proof: to connect
to your broker you have to be on your network. Across the internet, the same
three facts mean:

- **Anyone can be your station.** A broker on the internet cannot tell your
  P280 from a laptop that connects with client id `device_<your MAC>`. That
  laptop receives the commands meant for your station, reports whatever
  battery level it likes, and — since MQTT allows one session per client id —
  knocks the real station off every time it connects.
- **Anyone who sees your MAC can claim your station**, on any service where
  claiming is "type in its id". Walking past it with a phone is enough.
- **Anyone on the path can read and rewrite the traffic** — every reading,
  and every command, including the ones that change settings. There is no TLS
  to stop them.

### What would have to change

Any one of these would make a direct connection safe, and none is ours to
make:

- the station accepting a **per-device secret** for its broker — a username
  and password we issue, entered in BrightEMS alongside the address;
- the station connecting over **TLS** and checking the broker's certificate;
- a vendor API that **proves ownership** — "this station belongs to the
  BrightEMS account signed in here" — that a service could ask.

If any of these appears in a future firmware, the hosted service can talk to
stations directly and this section gets shorter.

### What works with the firmware we have

Keep the station on the LAN, and let something *on the LAN* speak for it:

- **An edge at home.** The broker — already its own process — runs on a small
  always-on device at home and holds the station, as it does now. It connects
  *outbound* to the hosted service over TLS, with a credential issued when
  the owner pairs it using a one-time code from the app. Being on the LAN with
  the station is the proof of possession; nothing at home is exposed; devices
  reached over the home network, such as the Tuya plug, are held there too. A self-hosted server is
  exactly this edge with the service in the same box.
- **The phone as the edge**, over Bluetooth. No extra hardware, but only
  while the app is open — no history, no automations while you are away.

For self-hosting, none of this is needed.

## Getting there

Each step leaves a self-hosted server working, with its data migrated rather
than reset.

0. **Self-hosted, secure, deployed.** Accounts, sign-in everywhere and the
   broker on its own are done; the web container that serves the app beside
   the server, and the pipeline that deploys both to the NAS, are next.
1. **Homes.** Add identities (the password moves there), homes, memberships
   and the operator flag. Existing devices, history and settings move into one
   home owned by the first account, who also becomes operator. Home-scoped
   routes gain their `:home`; the app keeps the home you are looking at.
   Device types stay installed per server; each device, with its connections
   and secrets, belongs to one home.
2. **Sharing.** Invite an account into a home; owner and member roles; leave,
   remove, hand over. The app switches between homes.
3. **Links and automations per home.** Links and automations join only
   devices in the same home, and a recipe's roles offer only that home's
   devices.
4. **Signing up, and Apple and Google.** The sign-up setting, OpenID Connect
   with PKCE for both providers, and bearer tokens beside the cookie for the
   native apps. (An iOS app that offers Google sign-in must offer Sign in with
   Apple too.) Local password accounts on an open service need a verified
   email and a reset path, and so an email sender.
5. **The edge and the hosted service.** Pairing codes, the edge's outbound
   connection, and the service's side of it. By then SQLite may want to be
   Postgres; the store is kept behind one module so that is a change in one
   place.

## Open questions

- Should a device ever be shareable on its own, without sharing the whole home?
  The model allows adding it later; nothing needs it yet.
- Deleting an account that is the only owner of a home: delete the home, or
  require handing it over first?
- Who may see a home's audit timeline — the owner only, or members too?
