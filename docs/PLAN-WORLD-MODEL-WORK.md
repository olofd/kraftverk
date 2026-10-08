# Building the world model: the work, step by step

How [PLAN-WORLD-MODEL.md](PLAN-WORLD-MODEL.md) gets built. That document
is the design: what each table holds and why. This one is the work: each
step cut into slices that are each green, what each slice changes and
where, how it is tested, and when it is done. 2026-10-08.

The first steps are planned to the file. The later ones are planned to the
package, and are cut finer when they are reached, since what is learnt
building W1 to W3 will change them.

## How every slice is done

- **Green on every commit**: `npm run typecheck`, `npm test`,
  `npm run check:architecture`, `npx knip`. The layout check
  (`node e2e/run.mjs e2e/layout.e2e.ts`) runs for every slice that changes
  a screen.
- **Strict version 1.** Each change reaches every package, holder, API,
  screen and doc at once. Nothing is left beside what replaces it.
- **The configuration file** gets a new version only where its shape
  changes. Each new version brings a migration from the last, a kept
  fixture, and a test that the fixture reads and writes back the same
  (`packages/home-file`).
- **Schema changes are pushed together, once per step.** A changed schema
  sets the family's database aside: everyone is signed out, and history
  starts over. So a step's slices are committed one by one, and pushed when
  the step is done. The owner is told before that push what it resets. That
  is the one exception to pushing as each slice is done.
- **After each push**, the NUC's pipeline is watched to the end
  (`ssh nuc-claude "sudo forgejo-log <sha> --wait"`). The server's log is
  read for the restore line, and the app is checked in the browser.
- **The docs move with the code.** DATA-MODEL.md takes each table as it is
  built. A package README stays true. The world model's §20 records what
  building it changed.
- **Only our own files are staged.** Others may be working in this
  checkout.

## Before W1: the owner's answers

From PLAN-WORLD-MODEL.md §19, these shape W1 and are asked first:

1. The word: `family`, with a kind that changes only the words on screen.
2. One family is one database, one master and one writer.
3. A person is a signed chain of keys under a stable id. W1 does not build
   it, but W1 sets the id format it uses.
4. Moving house is a new home.
5. New ids everywhere are a prefix and a ULID.
6. The configuration file's keys for the new entities.

A different answer to 1 or 2 changes W1's rename. To 5, it changes W1.1.

## W1. The foundation

**Built, 2026-10-08** (commits W1.1 to W1.7). What building it changed:

- **The device SDK's port** for a device's home moves to W2, where devices
  stand in homes. Until then the first home is the family's place, policy
  and clock.
- **`for_person` and `via_node`** on the timeline move to W3, when there are
  people to point at. A nullable column waiting for its first use would
  break strict version 1.
- **Sign-ins:** `node.db` keeps the server's schema in `server/src/auth`, not
  `packages/store`. Only a node with an HTTP entrance has sign-ins
  (PLAN-WORLD-MODEL.md §7).
- **Homes have keys** (`place.key`), as devices and automations have. An
  import plans homes like devices, and never leaves one: leaving a home is a
  person's decision.
- **Adding a picture on a phone** is not there yet. It needs a reviewed image
  dependency. The web re-encodes through a canvas.
- **Exporting pictures** in a downloaded file (a zip) is not there yet. The
  snapshot beside the database keeps them.

Nothing a person sees changes much. What changes is what everything after
it is built on: the ids, who did what, where sign-ins live, the root's
name, and homes.

### W1.1 Ids: a prefix and a ULID

- `packages/device-sdk`:
  - `newId` makes `<prefix>-<ULID>`: 48 bits of milliseconds and 80 random
    bits, Crockford base32, from Web Crypto. It is written here, about 30
    lines, with no dependency.
  - `randomHex` stays only where a random secret is meant.
- The node's own id (`newNodeId`, the `node-id` file beside the database)
  takes the same form.
- **Tests:**
  - The id's shape and that ids sort by time.
  - 100 000 ids made with no collision.
  - That the time part is the time made.
- **No schema change.** Ids are opaque, and rows made earlier keep theirs.
- *Done when* every id made from here on is a ULID, and nothing parses an
  id's inside.

### W1.2 Who did it: one actor shape

- **`packages/device-sdk`:** `Actor = { kind: 'person' | 'automation' |
  'node' | 'integration' | 'system'; id: string | null; name: string }`,
  and the helpers to say one.
- **`packages/gateway`:**
  - An intent's `by` and `LedgerMark.by` become an `Actor`.
  - "Leave what another automation set" reads `actor.kind` and `actor.id`,
    where today it parses `automation:a-…` out of text.
- **`packages/hub`:**
  - `api/caller.ts`: `intentOf` returns an actor.
  - `configuration`: its `by: string` arguments become actors.
  - Every place the timeline is written.
- **`packages/store`:**
  - `audit` gets `actor_kind`, `actor_id` and `actor_name`, and gains
    `for_person`, `via_node` and `home_id`, nullable until W3 and W2 use
    them.
  - So do `device_switch`, `device_write` and `automation_run.started_by`.
  - The `AuditLog`, ledger and run stores follow.
- **`packages/api-contract`:** the timeline's entries and run logs carry
  the actor. The app shows `actor.name` where it showed `actor`.
- **Tests:**
  - The gateway's ownership rules over actors.
  - The audit store round-trips an actor.
  - An automation's run and its switch name the same automation.
- *Done when* nothing writes or parses "who" as free text.

### W1.3 The node's own database

- **`server/src/auth/schema.ts`** stays where it is. `ACCOUNTS_SCHEMA`
  moves into its own database file, `node.db`, beside the family's, with
  its own fingerprint.
- **`server/src/platform/database.ts`:**
  - Opens both databases.
  - Carrying accounts across a set-aside family database is no longer
    needed and goes, with `ACCOUNTS_CARRIED`. Accounts were only ever in
    the family's file by accident.
  - The node's database is set aside, with its accounts carried, only
    when its own schema changes.
- **`server/src/index.ts`:** `new Accounts(nodeDatabase)`.
- **Tests:**
  - The family's database set aside leaves every account and sign-in as
    it was.
  - The node's database set aside still carries its accounts (the test
    from 03d535d, moved).
- **Docs:** SECURITY.md "Where accounts live" and DOCKER.md's data table
  name `node.db`.
- *Done when* a change to the family's schema signs nobody out.

### W1.4 The root is the family

The rename. Mechanical, large (about 350 files mention "home"), and done
in one slice so nothing reads half and half. Only the root changes name.
The app's home screen keeps its name, and from W1.5 shows the current
home.

| Today | After |
| --- | --- |
| `home` table, `HomeStore`, `HomeRecord` | `family`, `FamilyStore`, `FamilyRecord`; with `kind` and `locale` (§8.1) |
| `HomeView`, `KraftverkApi.home()` | `FamilyView`, `family()` |
| `homeFor` (server routes) | `familyFor` |
| `HomeProvider`, `useHome` (the app's API provider) | `FamilyProvider`, `useFamily` |
| `GET /api/home` | `GET /api/family` |
| `HomeElsewhere`, `homeKept` (follower) | `FamilyElsewhere`, `familyKept` |
| "a home, running" (hub), "everything a home answers" | "a family's", in every comment and README |
| ARCHITECTURE.md's vocabulary | family, home (a property), node, master, follower |

- How: TypeScript's rename where it reaches, the rest by search. Then
  every comment and doc that says "home" for the root is read again by
  hand.
- `scripts/architecture.mjs`: a ratchet so the old names (`HomeStore`,
  `homeFor`, `useHome`, `HomeView`) can never come back.
- *Done when* nothing names the root a home, and the ratchet holds.

### W1.5 Places and homes

- **`packages/store`:**
  - `place` and `home` (§8.4), with `home_setting` per home.
  - `automation` gains `home_id`. Its `time_zone` becomes nullable,
    meaning the home's.
  - A `PlaceStore` for homes and zones: zones come in W4, the table now.
- **`packages/hub`:**
  - `api/homes.ts`: list, add, update, archive. At least one home is
    open at all times.
  - The family's location getter becomes per home.
  - The policy (`HomePolicy`) becomes per home.
  - The engine's `location` (sun times) and an automation's clock come
    from its home.
- **`packages/automation-engine`:** `location()` takes the automation's
  home.
- **`packages/home-file`:**
  - Version 10: `family:` (name, kind, locale) and `homes:` (key, name,
    type, location, time zone, policy, prices).
  - The migration from 9 turns `home:` into `family:` plus one home,
    `home`.
  - An automation gains `home:`, and an automation that names no home and
    no clock gets the family's first home. The fixture is `v10.yaml`.
- **The app:**
  - App settings › **Homes**: a list, and one home's page (name, type,
    where it is, its time zone, its policy). This replaces `HomeLocation`
    and `HomePolicy`.
  - `useHomePlace` becomes the current home's place.
  - The home screen shows the current home, with a switcher once there is
    more than one.
  - Maps offers the home's country, per home.
- **The device SDK:** a session can ask for the place and time zone of
  the home its device is for (§17 of the world model). Open-Meteo and the
  price service use it when their own place is not set. Until W2 places
  devices, that home is the family's first.
- **Tests:**
  - Places' CHECKs: a zone without a centre is refused, and so is a home
    without a time zone.
  - Two homes with their own clocks.
  - An automation's sun times from its home.
  - The v9 to v10 migration.
- *Done when* a family has two homes with their own places and time
  zones, and an automation for each runs on its home's clock.

### W1.6 Pictures

- **`packages/store`:** `media` and `media_data` (§8.12), and a
  `MediaStore` that keeps a picture by its hash and collects the ones
  nobody uses.
- **The hub and server:** `PUT /api/media` (raw bytes; the type and size
  checked) and `GET /api/media/:hash` (immutable, cached for ever). The
  route goes in `server/src/routes/media.ts`, on the request body cap of
  2 MB, raised from 1 MB for this route only.
- **The app** (`client/src/platform/picture.ts`, one port with two
  implementations):
  - The web re-encodes through a canvas to WebP, at most 2048 px, which
    drops EXIF.
  - A phone uses `expo-image-manipulator`, which needs a reviewed
    dependency.
  - The first use is a home's picture. People's come in W3.
- **`device.picture`** becomes `picture_type` or `picture_id`. A photo of
  its own, the reserved `own:`, becomes possible.
- **The configuration file:** pictures are named by hash, with the files
  in `config/media/` beside the snapshot. An export gains a choice:
  with pictures, as a zip, or without.
- **Tests:**
  - The same picture is kept once.
  - SVG is refused, and so is anything over 2 MB.
  - Collection keeps what is used.
  - The web encoder's output has no EXIF, checked against a fixture
    photo that has GPS tags.
- *Done when* a home has a photo that survives a reset.

### W1.7 Checks and docs

- **A schema conventions test** (`packages/store/test/conventions.test.ts`)
  walks `SCHEMA` and holds every table to §6:
  - every `until` has its CHECK;
  - every table with `since` and `until` has a partial unique index or
    says why not;
  - every `*_at` column is named for an instant;
  - no free-text "by".
- **Docs:** DATA-MODEL.md (family, place, home, media, the actor),
  ARCHITECTURE.md (vocabulary; §3), CONFIG.md (version 10), ACCOUNTS.md
  (its home becomes the family), HANDOFF.md.
- **Push W1.** The owner is told first that everyone is signed in again
  only once, since logins now live apart, and that history starts over.
- *Done when* the NUC runs W1: the family restored from its file, one
  home with the old location, and nobody had to make an account again.

## W2. Spaces, and where devices stand

**Built, 2026-10-08** (commits W2.1 to W2.5). What building it changed:

- **History by space is by meaning**, not by key: a room's temperature is
  whatever stood there that reads `temperature`, one series per stay,
  clipped to it, the spaces inside it included (`spaces.history`).
- **An import adds and changes, never removes,** spaces, openings and
  labels; a device whose entry says no `place:` or no `labels:` is left as
  it is, since one device's YAML in the app knows neither.
- **A room may stand in the home itself**, with no building: an apartment's
  rooms are the home's own.
- **Labels have a key** besides their unique name, as everything a file
  names does; people join them in W3.
- **W2.5, the device SDK's home port** (from W1): `DeviceContext.home()` —
  the home a device stands in, or the family's first — asked each time;
  `identify` is told it too. Open-Meteo forecasts for its home when it has
  no place of its own. The gateway asks each device's own home for its
  values. The API's family-wide values (`policy`) are still the first
  home's: per-home values on a home's page come with W3's screens.
- **The app keeps no kept-file restore** of its own database: a schema
  change starts its home afresh, as before.

1. **W2.1 Spaces and openings.**
   - In the store: `space`, `opening`, with the composite keys.
   - In the hub: `api/spaces.ts`, which builds the tree, refuses a parent
     in another home, and archives rather than deletes a space with
     history.
   - The configuration file gains `spaces:` and `openings:` under a home,
     keyed within it.
   - Tests:
     - the tree's rules;
     - a space in another home refused;
     - archived spaces kept for history;
     - the file round-trips.
2. **W2.2 Placement.**
   - `placement`, and the hub's rules: moving a device closes one
     placement and opens the next in one transaction, and an opening must
     touch its space.
   - The history API gains "by space": the readings of every device that
     stood in a space, while it stood there.
   - Tests:
     - a sensor moved from the bedroom to the kitchen at 12:00, whose
       readings at 11:00 are the bedroom's and at 13:00 the kitchen's;
     - the interval invariant under concurrent moves.
3. **W2.3 In the app.**
   - A home's page lists its buildings, floors and rooms, with add,
     rename, move and archive.
   - A device's settings ask where it is, with a room picker that offers
     "at an opening".
   - The home screen is grouped by room.
   - Layout checks at 320 and 375 px.
4. **W2.4 Labels.**
   - `label` and `labelled`, in the file, with a filter on the home screen.
5. **Push W2.**

*Done when* a home's devices are listed by room, and moving one keeps each
room's history right.

## W3. People

**Built, 2026-10-08** (commits W3.1 to W3.8). What building it changed:

- **An account works with no server**, made locally or with Sign in with
  Apple (the owner's ask: Apple is the one provider for now). Providers
  are packages, `packages/sign-in/*`; the core verifies any OpenID
  Connect ID token and names none.
- **A key proves itself when it is added**: the key's own signature over
  `{ kind: 'kraftverk key', key }` rides in its `key-added` statement.
  Chains made before that do not check, and are left out where kept.
- **A device's keys are kept by their key id** (`DeviceKeys`), so a second
  device makes its key before it is anyone's. On a phone they live in the
  secure store as software keys; the platform keystore is the upgrade
  behind the port (world model §10.7).
- **Invitations need a server.** A family kept on one phone has no door
  anyone else can knock on, so the People page says so. The *done when*
  below is met with a server between the two phones, not without one.
- **A second device** is linked by two codes, one each way, pasted or
  shared; a device that lost everything comes back with its twelve words
  and the family's server.
- **Shortcuts are each person's own** (`shortcut`), and the configuration
  file, version 11, keeps them under each person. Version 10's one home
  page becomes everyone's shortcuts.
- **A person's own name, short name and picture** are said in their chain
  from App settings; a family that heard an older copy is shown the newer
  when it is next opened. Nickname and colour stay the family's, set on
  the People page.
- **Erasure** (world model §11.6): oneself, or anyone by an admin. They
  leave, become "Someone who left" in the family and on its timeline, and
  lose keys, linked identities and shortcuts; at a server their logins and
  sessions go. The id stays. The last admin is not erased.
- **Left for later:** Sign in with Apple *at a server* (the server would
  find provider packages at run time); letting go of a lost device's key
  from the app; coming back by a provider a family vouches for;
  `private_place` and `sharing` (W4, where they are used);
  `person_contact`; managed people in the configuration file.

The step the owner named next. Its order matters: the personal store and
keys first, since everything else is signed by them.

1. **W3.1 Research, written down first:**
   - ECDSA P-256 on a phone with a non-extractable key. Expo has no
     signing API. Weigh `react-native-quick-crypto` against the platform's
     keystore through a small native module, against the rule that every
     port has a system, web and native implementation.
   - A recovery word list. Our own list, or one whose licence fits.
   - How a passkey and a device key relate when someone signs in at a
     server from a browser.

   The answers go in the world model's §10 before W3.2.
2. **W3.2 Identity, as a pure package.**
   - A new package, `packages/identity`:
     - the person record and its chain of signed statements: a key added,
       a key revoked, the profile changed;
     - checking a chain;
     - the challenge a node signs in with.
   - No storage and no platform; the signing key is a port. Its README has
     the four sections.
   - Tests:
     - a chain checks;
     - a forged statement, a revoked key's later signature and a
       reordered chain are each refused.
3. **W3.3 The personal store.**
   - The third schema in `packages/store`: `me`, `my_family`,
     `private_place`, `my_setting`.
   - Opened by the hub beside each family it follows.
   - The key port on web (Web Crypto, IndexedDB, as the sealing key is
     now) and on native (per W3.1).
4. **W3.4 People in the family's database.**
   - `person`, `person_key`, `person_contact`, `member`, `sharing`,
     `invitation`.
   - The store's rules: at least one admin, one colour each, a claim
     rewrites a managed id everywhere in one transaction.
   - The configuration file gains `people:`.
5. **W3.5 Signing up, and the first family.**
   - In the app, the first screen of a new install: your name, and a
     picture if you want one.
   - Then your family's name and kind, then your first home and where it
     is.
   - A recovery key is shown once.
   - The phone is the master: a family of one, on a phone, with no server.
6. **W3.6 Invitations and a second device.**
   - An invitation is a QR code and a link.
   - Joining presents a signed person record. An admin may need to approve.
   - A second device of one's own is signed in by scanning from the first.
7. **W3.7 Signing in at a server.**
   - The node's `users` become `login` with a `person_id`.
   - A person's device key signs in by challenge. A password and a
     passkey stay as other ways.
   - The Caller in the hub becomes a person, and the timeline's actor is
     that person.
   - Moving a phone's family to a server keeps everyone in it.
8. **W3.8 What is a person's own.**
   - Shortcuts per person, replacing `automation.home_place`.
   - A person's picture, nickname and colour.
   - Erasure.
9. **Push W3.**

*Done when* someone signs up on a phone with no server, makes a family and
a home, invites a second person who joins from their own phone, and both
see the same devices.

## W4. Who carries what, and where everyone is

- **`device_person`, and zones.** In the app: "who carries it" on a
  device, and a family's zones on a map.
- **Presence,** in `packages/hub` (`presence/`), as pure rules over
  positions:
  - stays opened and closed with hysteresis;
  - the freshest position among what a person carries;
  - retention by `keep_days`.
- **The levels:**
  - The hub's API answers per reader. A test calls every route that can
    show a position, as each kind of reader, against each level.
  - Stores keep a carried device's position only at `precise`.
  - The phone filters before sending when it is the source.
- **Notifications:**
  - `push_endpoint` and `notification`.
  - Web push (VAPID, a service worker) first.
  - APNs and FCM when there is a native build that can register.
  - A person's inbox in the app.
- **The family map:** everyone at what they share, homes and zones, and a
  person's page.
- *Done when* a person at `places` is shown "at work" and never their
  coordinates, whoever asks and from whichever node.

## W5. Things that move

- A type's `meta` declares its mobility, and the app offers placement or a
  carrier first accordingly.
- A vehicle's base is a placement whose role is `based`.
- Trips are found from positions as they arrive (`packages/hub`,
  `trips/`), and listed on a vehicle's page with driver and distance.
- *Done when* a car's trips are listed with their driver and distance.

## W6. Rooms and presence

- **Geometry:** `floor_plan` and frames. A floor's plan is traced into
  rooms, and a device is placed at coordinates. This is the home's map in
  the app, on the same MapLibre view, in the home's frame.
- **Occupancy** from motion, presence and contact sensors, with its
  evidence.
- **A person's room** when a signal tells people apart.
- **A position in a space's frame,** for a robot cleaner.
- *Done when* a home's map shows which rooms are occupied, from real
  sensors.

## W7. Automating people and places

- Modes on two axes, set by people, automations and presence.
- Waits on the automation language resuming
  ([AUTOMATION-LANGUAGE-STATUS.md](AUTOMATION-LANGUAGE-STATUS.md)):
  - roles filled by people, groups of people, homes, spaces and zones;
  - triggers: arrives, leaves, the first arrives, the last leaves, a room
    empty, a mode changes.
- *Done when* "when the last person leaves, set away" is a recipe.

## W8. Several homes, several nodes

- A node per home holding that home's ways, lending them to the master as
  phones lend Bluetooth now.
- Whether that node may run its home's automations while the link is down
  is decision 9, taken here.
- *Done when* the cabin's devices work from the house's master through the
  cabin's node.

## Risks, and how each is met

| Risk | Met by |
| --- | --- |
| The rename (W1.4) breaks something no test covers | It is one slice, with the e2e suites and the layout check run before it is committed, and the architecture ratchet after |
| A schema change signs everyone out at every step | W1.3 first: logins leave the family's database, so later steps sign nobody out |
| Keys on a phone have no good library (W3.1) | Researched and written down before any code. If no port is sound on native, W3 ships on the web and the server first, and the native app signs in with a password until it is |
| Privacy filtered in one route and missed in another | One filter in the hub's API layer, not per route, and a test that calls every route as every kind of reader |
| Intervals overlap after a crash mid-move | The store closes and opens in one transaction, and the conventions test and an invariant test hold it |
| The configuration file grows too complex to write by hand | People, homes and spaces are what an export writes, not what a person types. The schema's completion in an editor keeps it writable |
| W2's rooms without people (W3) feel half-built | Rooms are useful on their own: a home screen grouped by room is the most-asked-for view |

## Order, and why

W1 before everything, because every table after it uses its ids, actor and
homes. W2 before W3, because rooms are useful alone, need no identity, and
exercise placement as history early. W3 then gives the owner the step they
asked for. W4 needs W3's people. W5 to W8 can be taken in whatever order
the home asks for, once W4 is done.
