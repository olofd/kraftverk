import { ruleShape } from '@kraftverk/automation';
import { CURRENT_VERSION } from '@kraftverk/home-file';

/**
 * The database, as one definition (AGENTS.md, docs/ARCHITECTURE.md §9
 * decision 21).
 *
 * kraftverk is in research and development, so there is no chain of
 * migrations: the schema is this, and a database built from any other is set
 * aside rather than changed (`db.ts`). Every column that can be required is;
 * a null left is one that means something — a device that has not said who it
 * is, a device that has not been removed.
 */
export const SCHEMA = `
  /*
    What this database is: the schema it was made with, when, and by which
    version of kraftverk. What the set-aside rule reports, and what the
    compatibility rules will read on the day there is data to keep.
  */
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY CHECK (key IN ('schema_hash', 'created_at', 'created_by_version')),
    value TEXT NOT NULL
  );

  /*
    Every kraftverk node of the home: the hub running somewhere — an
    always-on machine on the network, a phone, a browser — holding the
    connections it can reach. The one this database belongs to (self), and
    the others it shares the home with, each known by the same id in every
    database that knows it: made by the node itself, once. What a node is,
    it declares: always on, reachable by others, trusted with what must stay
    put. A node joined from a person's account acts for them; the home's own
    act for nobody.
  */
  CREATE TABLE node (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    /* What its transports' entries are for: a system process, a browser's page, a phone. */
    platform     TEXT NOT NULL CHECK (platform IN ('system', 'web', 'native')),
    always_on    INTEGER NOT NULL CHECK (always_on IN (0, 1)),
    reachable    INTEGER NOT NULL CHECK (reachable IN (0, 1)),
    trusted      INTEGER NOT NULL CHECK (trusted IN (0, 1)),
    transports   TEXT NOT NULL DEFAULT '[]',
    /* The account it joined from, where the master keeps accounts — a server's (its accounts are its own: server/src/auth/schema.ts); null for this node, and where there are none. */
    account_id   TEXT,
    self         INTEGER NOT NULL CHECK (self IN (0, 1)),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX node_self ON node (self) WHERE self = 1;

  /*
    The family this database is (docs/PLAN-WORLD-MODEL.md §8.1): one. The
    people who share its devices, nodes and homes — a family, a household,
    friends with a cabin. What every node and device here is part of; and its
    master — the node whose database is the family's, the one that writes
    it. Another node follows it, and can take its place.
  */
  CREATE TABLE family (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    /* Only the words on screen: "your family", "your household", "your friends", "your group". */
    kind       TEXT NOT NULL DEFAULT 'family' CHECK (kind IN ('family', 'household', 'friends', 'other')),
    /* BCP 47: what is said to all of it — an announcement, a speaker. */
    locale     TEXT NOT NULL,
    master_id  TEXT NOT NULL REFERENCES node (id),
    created_at TEXT NOT NULL,
    /* The person who founded it; null: a node made it before anyone was in it — a server, at its first start. */
    created_by TEXT REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED
  );

  /*
    Pictures (docs/PLAN-WORLD-MODEL.md §8.12) — of homes and devices — kept by
    their content: the id is the SHA-256 of their bytes, so one is kept once.
    No SVG: a picture never runs script. Collected when nothing shows one.
  */
  CREATE TABLE media (
    id       TEXT PRIMARY KEY CHECK (length(id) = 64),
    type     TEXT NOT NULL CHECK (type IN ('image/webp', 'image/jpeg', 'image/png')),
    bytes    INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2097152),
    width    INTEGER NOT NULL CHECK (width > 0),
    height   INTEGER NOT NULL CHECK (height > 0),
    added_at TEXT NOT NULL
  );
  /* The bytes apart, so listing pictures never reads them. */
  CREATE TABLE media_data (
    media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
    data     BLOB NOT NULL
  );

  /*
    People, as this family knows them (docs/PLAN-WORLD-MODEL.md §8.2, §10).
    A person owns their profile, and proves it: their chain of signed
    statements (@kraftverk/identity) is kept as it was shown, and what this
    row says is what it says — a newer chain replaces an older. A person an
    admin keeps for someone with no device yet, a small child, has no chain,
    and is managed_by that admin. Never deleted while history names them:
    erased, they keep their id and lose the rest.
  */
  CREATE TABLE person (
    id         TEXT PRIMARY KEY CHECK (id GLOB 'p-*'),
    kind       TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human')),
    /* Whole, as they write it. */
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    /* What screens and speakers call them; null: their name. */
    short_name TEXT CHECK (length(short_name) BETWEEN 1 AND 30),
    picture_id TEXT REFERENCES media (id),
    /* BCP 47: the language they are told things in; null: the family's. */
    locale     TEXT,
    /* The admin who keeps them; null: they keep themselves. */
    managed_by TEXT REFERENCES person (id),
    /* Their statements, as JSON; null for one with no key yet — an admin keeps them, or a node made them where they signed in with a password. */
    chain      TEXT,
    /* Their profile's own time: a newer copy replaces an older. */
    updated_at TEXT NOT NULL,
    /* Erased (§11.6): name and picture gone, the row kept for history. */
    erased_at  TEXT,
    CHECK (managed_by IS NULL OR chain IS NULL)
  );

  /*
    The public keys a person signs with (§10): those their chain adds, and
    those this family vouched for when they came back without one — by a
    sign-in provider, or an admin — which no other family takes. The private
    halves never leave their devices.
  */
  CREATE TABLE person_key (
    id          TEXT PRIMARY KEY CHECK (id GLOB 'k-*'),
    person_id   TEXT NOT NULL REFERENCES person (id),
    kind        TEXT NOT NULL CHECK (kind IN ('device', 'recovery')),
    /* A P-256 JWK: its x and y. */
    public_key  TEXT NOT NULL,
    /* Which device holds it: "Anna's phone"; null for a recovery key. */
    device_name TEXT,
    added_at    TEXT NOT NULL,
    /* The key that signed it in; null for their first, and for one vouched for. */
    added_with  TEXT REFERENCES person_key (id),
    /* How this family took a key that is not in their chain: provider:<id>, or the admin's person id; null: the chain says it. */
    vouched     TEXT,
    revoked_at  TEXT
  );
  CREATE INDEX person_key_person ON person_key (person_id) WHERE revoked_at IS NULL;

  /* An identity a person linked to themselves, in their chain: at a sign-in provider, by the subject it gives this app. */
  CREATE TABLE person_identity (
    provider  TEXT NOT NULL,
    subject   TEXT NOT NULL,
    person_id TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
    /* Their email there, when they let it be given. */
    email     TEXT,
    PRIMARY KEY (provider, subject)
  );

  /*
    Being in the family (§8.3): a row, with a role. What this family calls
    them, and their colour, are the family's. Left, the row stays for the
    history that names them.
  */
  CREATE TABLE member (
    person_id  TEXT PRIMARY KEY REFERENCES person (id),
    /* At least one admin, always: the store's rule. */
    role       TEXT NOT NULL CHECK (role IN ('admin', 'member', 'child')),
    /* What this family calls them: "Mum". */
    nickname   TEXT CHECK (length(nickname) BETWEEN 1 AND 30),
    color      TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
    joined_at  TEXT NOT NULL,
    invited_by TEXT REFERENCES person (id),
    left_at    TEXT
  );
  CREATE UNIQUE INDEX member_color ON member (color) WHERE left_at IS NULL;

  /*
    What each person shares with the family of where they are, and how long
    their stays are kept (§11): their own to set, an admin's for a child.
    By the person, not their membership: one waiting to be let in has
    already chosen. No row: the family's default — places, 90 days.
  */
  CREATE TABLE sharing (
    person_id    TEXT PRIMARY KEY REFERENCES person (id),
    level        TEXT NOT NULL CHECK (level IN ('precise', 'places', 'home-away', 'off')),
    /* Off until then, and the level after. */
    paused_until TEXT,
    keep_days    INTEGER NOT NULL DEFAULT 90 CHECK (keep_days BETWEEN 1 AND 366),
    set_by       TEXT NOT NULL REFERENCES person (id),
    changed_at   TEXT NOT NULL
  );

  /*
    An invitation into the family (§8.3): a one-time secret in a link or a
    code, kept here only as its hash. Taken by someone showing who they are
    — their chain — who then is a member in its role, or waits for an admin
    to let them in. Used once; until it expires, or is taken back.
  */
  CREATE TABLE invitation (
    id             TEXT PRIMARY KEY CHECK (id GLOB 'i-*'),
    role           TEXT NOT NULL CHECK (role IN ('admin', 'member', 'child')),
    /* Who it is meant for, as the inviter said: "Grandma"; null: anyone with it. */
    for_name       TEXT CHECK (length(for_name) BETWEEN 1 AND 60),
    /* SHA-256 of its secret, in hex. */
    secret_hash    TEXT NOT NULL,
    needs_approval INTEGER NOT NULL CHECK (needs_approval IN (0, 1)),
    made_by        TEXT NOT NULL REFERENCES person (id),
    made_at        TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_by        TEXT REFERENCES person (id),
    used_at        TEXT,
    approved_by    TEXT REFERENCES person (id),
    approved_at    TEXT,
    revoked_at     TEXT,
    CHECK (expires_at > made_at),
    CHECK ((used_by IS NULL) = (used_at IS NULL)),
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CHECK (approved_by IS NULL OR used_by IS NOT NULL)
  );

  /*
    Places on the globe the family names (docs/PLAN-WORLD-MODEL.md §8.4): its
    homes, and the zones it knows — school, work. Presence asks both the same
    way, so the geofence lives here once; a home has more, beside it in home.
    A place history points at is archived (removed_at), never deleted.
  */
  CREATE TABLE place (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('home', 'zone')),
    /* Its name in configuration, as a device's key is: one home, or one zone, to a key. */
    key         TEXT NOT NULL CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    icon        TEXT,
    /* Where it is, in degrees: what the sun's times are told by. A home may not have said yet; a zone always has. */
    latitude    REAL CHECK (latitude BETWEEN -90 AND 90),
    longitude   REAL CHECK (longitude BETWEEN -180 AND 180),
    /* Metres: the geofence, a circle round it. */
    radius      REAL CHECK (radius > 0),
    /* A GeoJSON Polygon, when drawn: then it is the geofence, and radius its circle's. */
    outline     TEXT,
    /* IANA: what its clocks keep. A home's always. */
    time_zone   TEXT,
    /* The address, as written: each part optional. */
    street      TEXT,
    postal_code TEXT,
    locality    TEXT,
    region      TEXT,
    /* ISO 3166-1 alpha-2: what Maps offers to download for it. */
    country     TEXT CHECK (country GLOB '[A-Z][A-Z]'),
    created_at  TEXT NOT NULL,
    removed_at  TEXT,
    UNIQUE (id, kind),
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
    CHECK ((latitude IS NULL) = (radius IS NULL)),
    CHECK (kind = 'home' OR latitude IS NOT NULL),
    CHECK (kind <> 'home' OR time_zone IS NOT NULL)
  );
  CREATE UNIQUE INDEX place_key ON place (kind, key) WHERE removed_at IS NULL;

  /* A home: a place the family lives in, or spends time at — and what a home has that a zone does not. */
  CREATE TABLE home (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'home' CHECK (kind = 'home'),
    type        TEXT NOT NULL CHECK (type IN ('house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other')),
    picture_id  TEXT REFERENCES media (id),
    /* Degrees from north to the home's y axis: where its floor plans sit on the globe. */
    bearing     REAL NOT NULL DEFAULT 0 CHECK (bearing >= 0 AND bearing < 360),
    /* Its order among the family's homes. */
    position    INTEGER NOT NULL CHECK (position >= 0),
    FOREIGN KEY (id, kind) REFERENCES place (id, kind)
  );

  /*
    A home's spaces (docs/PLAN-WORLD-MODEL.md §8.5): a tree, its root the
    home's site — where "in the cabin, room not said" stands — its parent
    always in the same home, which the composite key makes so. A space may
    have a frame of its own: an origin and a turn within its parent's, in
    metres. Archived when it goes, since what stood there is history.
  */
  CREATE TABLE space (
    id          TEXT PRIMARY KEY,
    home_id     TEXT NOT NULL REFERENCES home (id),
    parent_id   TEXT,
    /* Its name in configuration: one space of a home to a key. The site has none in a file: it is the home. */
    key         TEXT NOT NULL CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    kind        TEXT NOT NULL CHECK (kind IN ('site', 'building', 'floor', 'room', 'area', 'stairs', 'outdoor')),
    /* What a room is for: icons, defaults, "every bathroom". NULL: not said. */
    purpose     TEXT CHECK (purpose IN ('kitchen', 'living', 'dining', 'bedroom', 'children', 'guest', 'bathroom', 'toilet', 'hallway', 'office', 'laundry', 'storage', 'utility', 'garage', 'gym', 'sauna', 'other')),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    icon        TEXT,
    picture_id  TEXT REFERENCES media (id),
    /* Its order among its siblings. */
    position    INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    /* A floor's: 0 the ground floor, -1 below it; and metres above the site's ground. */
    level       INTEGER,
    elevation   REAL,
    /* Metres floor to ceiling. */
    height      REAL CHECK (height > 0),
    /* Its frame within its parent's: origin in metres, turn in degrees. NULL: its parent's. */
    frame_x     REAL,
    frame_y     REAL,
    frame_turn  REAL CHECK (frame_turn >= 0 AND frame_turn < 360),
    /* A GeoJSON Polygon in metres, in its own frame: not WGS 84. */
    outline     TEXT,
    created_at  TEXT NOT NULL,
    removed_at  TEXT,
    UNIQUE (home_id, id),
    FOREIGN KEY (home_id, parent_id) REFERENCES space (home_id, id),
    CHECK ((kind = 'site') = (parent_id IS NULL)),
    CHECK ((kind = 'floor') = (level IS NOT NULL)),
    CHECK (kind = 'floor' OR elevation IS NULL),
    CHECK ((frame_x IS NULL) = (frame_y IS NULL) AND (frame_x IS NULL) = (frame_turn IS NULL))
  );
  CREATE UNIQUE INDEX space_site ON space (home_id) WHERE kind = 'site';
  CREATE UNIQUE INDEX space_key ON space (home_id, key) WHERE removed_at IS NULL;
  CREATE INDEX space_parent ON space (parent_id);

  /*
    A floor's drawing, placed in its frame: what rooms are traced over
    (docs/PLAN-WORLD-MODEL.md §8.5). The picture's top-left corner falls at
    x, y; a pixel is scale metres; turned turn degrees about that corner.
    Only a floor has one: the store's rule.
  */
  CREATE TABLE floor_plan (
    space_id   TEXT PRIMARY KEY REFERENCES space (id),
    media_id   TEXT NOT NULL REFERENCES media (id),
    scale      REAL NOT NULL CHECK (scale > 0),
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    turn       REAL NOT NULL DEFAULT 0 CHECK (turn >= 0 AND turn < 360)
  );

  /*
    Where two spaces meet, or a space meets the outside: a door, the stairs,
    a window — what presence moves along. A device on one (a contact sensor,
    a lock) is placed at it. Two between the same spaces are allowed: a room
    may have two doors.
  */
  CREATE TABLE opening (
    id          TEXT PRIMARY KEY,
    home_id     TEXT NOT NULL,
    key         TEXT NOT NULL CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    from_id     TEXT NOT NULL,
    /* NULL: outside. */
    to_id       TEXT,
    kind        TEXT NOT NULL CHECK (kind IN ('door', 'opening', 'stairs', 'window', 'gate', 'garage-door', 'elevator')),
    name        TEXT CHECK (length(name) <= 60),
    /* A GeoJSON LineString in metres, in from_id's frame: where in the wall. */
    shape       TEXT,
    created_at  TEXT NOT NULL,
    removed_at  TEXT,
    FOREIGN KEY (home_id, from_id) REFERENCES space (home_id, id),
    FOREIGN KEY (home_id, to_id) REFERENCES space (home_id, id),
    CHECK (to_id IS NULL OR to_id <> from_id)
  );
  CREATE UNIQUE INDEX opening_key ON opening (home_id, key) WHERE removed_at IS NULL;

  /*
    Where a device stands (docs/PLAN-WORLD-MODEL.md §8.7), as an interval:
    moving it closes one and opens the next, so a reading is the room's it
    stood in when it was read. In a space — the site when no room is said —
    perhaps at an opening, perhaps at coordinates in the space's frame.
    "based": where something that moves belongs, a car's garage.
  */
  CREATE TABLE placement (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part        TEXT NOT NULL DEFAULT 'main',
    space_id    TEXT NOT NULL REFERENCES space (id),
    opening_id  TEXT REFERENCES opening (id),
    /* Metres in the space's frame; z above the floor. */
    x           REAL,
    y           REAL,
    z           REAL,
    /* Degrees in the space's frame: a radar's, a camera's. */
    facing      REAL CHECK (facing >= 0 AND facing < 360),
    role        TEXT NOT NULL DEFAULT 'stands' CHECK (role IN ('stands', 'based')),
    since       TEXT NOT NULL,
    until       TEXT,
    actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    actor_id    TEXT,
    actor_name  TEXT NOT NULL,
    CHECK ((x IS NULL) = (y IS NULL)),
    CHECK (z IS NULL OR x IS NOT NULL),
    CHECK (until IS NULL OR until > since)
  );
  CREATE UNIQUE INDEX placement_now ON placement (device_id, part) WHERE until IS NULL;
  CREATE INDEX placement_space ON placement (space_id, since);

  /*
    Any grouping the family wants (docs/PLAN-WORLD-MODEL.md §8.13): "upstairs",
    "heating", across devices, spaces and automations. A label on a space is
    on what stands in it too, as the app filters. People join in W3.
  */
  CREATE TABLE label (
    id    TEXT PRIMARY KEY,
    key   TEXT NOT NULL UNIQUE,
    name  TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 30),
    color TEXT CHECK (color IS NULL OR color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
    icon  TEXT
  );

  CREATE TABLE labelled (
    label_id      TEXT NOT NULL REFERENCES label (id) ON DELETE CASCADE,
    device_id     TEXT REFERENCES device (id) ON DELETE CASCADE,
    space_id      TEXT REFERENCES space (id) ON DELETE CASCADE,
    automation_id TEXT REFERENCES automation (id) ON DELETE CASCADE,
    CHECK ((device_id IS NOT NULL) + (space_id IS NOT NULL) + (automation_id IS NOT NULL) = 1)
  );
  CREATE UNIQUE INDEX labelled_device ON labelled (label_id, device_id) WHERE device_id IS NOT NULL;
  CREATE UNIQUE INDEX labelled_space ON labelled (label_id, space_id) WHERE space_id IS NOT NULL;
  CREATE UNIQUE INDEX labelled_automation ON labelled (label_id, automation_id) WHERE automation_id IS NOT NULL;

  /*
    The devices you added, and they stay added: removing one keeps its history
    until that is deleted too. A device keeps what it is — its description:
    parts, attributes, events — and what it has said about itself, so a device
    that is closed or removed is still described.
  */
  CREATE TABLE device (
    id          TEXT PRIMARY KEY,
    /* Its name in configuration (docs/CONFIG.md): what a file and an import know it by. One device you have to a key. */
    key         TEXT NOT NULL CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    type_id     TEXT NOT NULL,
    identity    TEXT,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL,
    /* Whose word the description is: its type's, for its config, or the device's own. */
    description_source TEXT NOT NULL DEFAULT 'type' CHECK (description_source IN ('type', 'device')),
    info        TEXT,
    /*
      Which picture it shows, its owner's pick: one of its type's (its Nth,
      picture_type), or a photo of its own (picture_id). Both NULL: its type's
      first.
    */
    picture_type INTEGER CHECK (picture_type >= 0),
    picture_id  TEXT REFERENCES media (id),
    added_at    TEXT NOT NULL,
    /* When its owner paused it: kept, and not reached, until resumed. NULL: it is not paused. */
    paused_at   TEXT,
    /* How many days where it has been is kept (the track table), its owner's choice. NULL: none of it is kept. */
    track_days  INTEGER CHECK (track_days IS NULL OR track_days BETWEEN 1 AND 366),
    removed_at  TEXT,
    CHECK (picture_type IS NULL OR picture_id IS NULL)
  );
  CREATE UNIQUE INDEX device_identity ON device (identity) WHERE identity IS NOT NULL AND removed_at IS NULL;
  CREATE UNIQUE INDEX device_key ON device (key) WHERE removed_at IS NULL;

  /* Every attribute a device has ever had: what its history is labelled by, after a part is gone. */
  CREATE TABLE device_attribute (
    device_id  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    part       TEXT NOT NULL,
    spec       TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (device_id, key)
  );

  /*
    What the gateway remembers of each part it switched: when, last, and by
    whom (the intent's by: "olof", "automation:a-…"). The dwell counts from
    it, so a restart is no way around it; a part with no row has never been
    switched from here, and its first switch through a link that makes it
    consequential is confirmed. Who is what lets an automation that keeps
    things so leave what another automation set (docs/SHARED-PARTS-AND-RESERVE.md).
  */
  CREATE TABLE device_switch (
    device_id   TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part        TEXT NOT NULL,
    switched_at TEXT NOT NULL,
    /* Who switched it: an actor, as everything names one (docs/PLAN-WORLD-MODEL.md §6). */
    by_kind     TEXT NOT NULL CHECK (by_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    by_id       TEXT,
    by_name     TEXT NOT NULL,
    PRIMARY KEY (device_id, part)
  );

  /* And when each setting it wrote was written, last, and by whom: one write per setting per dwell. */
  CREATE TABLE device_write (
    device_id  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    attribute  TEXT NOT NULL,
    written_at TEXT NOT NULL,
    by_kind    TEXT NOT NULL CHECK (by_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    by_id      TEXT,
    by_name    TEXT NOT NULL,
    PRIMARY KEY (device_id, attribute)
  );

  /* Each device's own storage: what its session keeps between runs. */
  CREATE TABLE device_kv (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (device_id, key)
  );

  /*
    What each device last said of each attribute, and when it said it: what
    it shows as it was — never as it is now — until its session says again,
    after a restart. One row per attribute, replaced as it changes; the value
    as JSON, any shape a reading has.
  */
  CREATE TABLE device_reading (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    at        TEXT NOT NULL,
    PRIMARY KEY (device_id, key)
  );

  /*
    How a device is reached: one row per way. Each is held by a node of the
    home, or goes through a bridge — another device the way's members are
    reached through (docs/PLAN-INTEGRATIONS.md §4.3): then it is held wherever
    that device is, rides the bridge's own transport, and its address is its
    key within the bridge. Never both, never neither.
  */
  CREATE TABLE device_connection (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    method            TEXT NOT NULL,
    transport         TEXT NOT NULL,
    held_by           TEXT REFERENCES node (id) ON DELETE CASCADE,
    through           TEXT REFERENCES device (id) ON DELETE CASCADE,
    address           TEXT NOT NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    config            TEXT NOT NULL DEFAULT '{}',
    /* Whether its secrets may leave in an export as plain text: its owner's choice, warned against, off unless chosen. */
    secrets_exportable INTEGER NOT NULL CHECK (secrets_exportable IN (0, 1)),
    created_at        TEXT NOT NULL,
    last_connected_at TEXT,
    CHECK ((held_by IS NULL) <> (through IS NULL)),
    CHECK ((through IS NOT NULL) = (transport = 'bridge')),
    CHECK (through IS NULL OR through <> device_id)
  );
  CREATE INDEX device_connection_address ON device_connection (transport, address);
  CREATE INDEX device_connection_through ON device_connection (through) WHERE through IS NOT NULL;
  CREATE UNIQUE INDEX device_connection_once ON device_connection (device_id, method, coalesce(held_by, through));

  /* The secrets of the connections this database's node holds, sealed when a key is given. A connection another node holds has none here. */
  CREATE TABLE connection_secret (
    connection_id TEXT NOT NULL REFERENCES device_connection (id) ON DELETE CASCADE,
    field         TEXT NOT NULL,
    value         TEXT NOT NULL,
    encrypted     INTEGER NOT NULL,
    /* Who gave it: a person, at setup or since; or the session, keeping what it needs — a sign-in token. */
    source        TEXT NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'session')),
    written_at    TEXT NOT NULL,
    PRIMARY KEY (connection_id, field)
  );

  /*
    Facts about the house, between parts of two devices: this plug's relay
    feeds that station's mains input. A kind with one target per source — a
    plug feeds one thing — says so in its row, as its kind declares it, and
    the database holds it to that: no concurrent add or direct write can give
    one source part two, whatever the code above does.
  */
  CREATE TABLE device_link (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    source_device  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    source_part    TEXT NOT NULL,
    target_device  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    target_part    TEXT NOT NULL,
    one_per_source INTEGER NOT NULL CHECK (one_per_source IN (0, 1)),
    created_at     TEXT NOT NULL,
    CHECK (source_device <> target_device)
  );
  CREATE UNIQUE INDEX device_link_once ON device_link (kind, source_device, source_part, target_device, target_part);
  CREATE UNIQUE INDEX device_link_one_per_source ON device_link (kind, source_device, source_part) WHERE one_per_source = 1;
  CREATE INDEX device_link_target ON device_link (target_device);

  /*
    One row per device, attribute and minute. Narrow on purpose: no schema knows
    what a watt is, so nothing changes here when something new starts measuring
    one. A number or an on/off in value; an enum or text in text. The part it
    belongs to is kept beside its key, so history is asked for per part
    without reading keys.
  */
  CREATE TABLE sample (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part      TEXT NOT NULL,
    key       TEXT NOT NULL,
    at        TEXT NOT NULL,
    value     REAL,
    text      TEXT,
    PRIMARY KEY (device_id, key, at),
    CHECK ((value IS NULL) <> (text IS NULL))
  );
  CREATE INDEX sample_part ON sample (device_id, part, at);
  /* By time alone: what the hourly roll-up and the pruning of old samples look through. */
  CREATE INDEX sample_at ON sample (at);

  /*
    Every change of an on/off or an enum, when the device observed it: one row
    per change, kept two years. Small and exact — what a timeline wants ("AC
    outlets off 14:02–14:19"), where an hourly mean of an on/off is a duty
    cycle nobody asked for.
  */
  CREATE TABLE sample_change (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part      TEXT NOT NULL,
    key       TEXT NOT NULL,
    at        TEXT NOT NULL,
    value     REAL,
    text      TEXT,
    PRIMARY KEY (device_id, key, at),
    CHECK ((value IS NULL) <> (text IS NULL))
  );

  /* Each numeric attribute's hours, rolled up, kept for two years. */
  CREATE TABLE sample_hour (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part      TEXT NOT NULL,
    key       TEXT NOT NULL,
    hour      TEXT NOT NULL,
    min       REAL NOT NULL,
    avg       REAL NOT NULL,
    max       REAL NOT NULL,
    n         INTEGER NOT NULL,
    PRIMARY KEY (device_id, key, hour)
  );

  /*
    Where a device has been, while its owner keeps it (device.track_days):
    one point per place it was located, at the time it was located there.
    Never in an export; let go after its days, and all of it when keeping
    it is turned off or the device is removed.
  */
  CREATE TABLE track (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    at        TEXT NOT NULL,
    latitude  REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    /* Within how many metres. NULL: the device did not say. */
    accuracy  REAL,
    PRIMARY KEY (device_id, at)
  );

  /* What happened, rather than what a value was: an overload trip, a button. */
  CREATE TABLE device_event (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part      TEXT NOT NULL,
    event     TEXT NOT NULL,
    level     TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    data      TEXT,
    at        TEXT NOT NULL
  );
  CREATE INDEX device_event_lookup ON device_event (device_id, at);
  /* One event once: a node that sends again what it is not sure arrived adds nothing. */
  CREATE UNIQUE INDEX device_event_once ON device_event (device_id, part, event, at);
  CREATE INDEX device_event_problems ON device_event (level, at) WHERE level <> 'info';

  /*
    Automations (docs/AUTOMATIONS.md, docs/SEQUENCES.md,
    docs/AUTOMATION-EDITOR.md): each owns its rule — what starts it, what it
    checks, the steps it takes — built by its owner from blocks (JSON: a
    Rule with no settings, checked before it is kept). made_from: the
    recipe it was copied from, to say so; NULL, built from nothing. The
    owner's clock, and whether it acts on its own. recheck_minutes: how
    often a condition that still holds is looked at again, to keep things
    so; NULL, never. looked_at: when it last did, or started afresh; NULL,
    not yet. Whose home page it is on is each person's: shortcut.
  */
  CREATE TABLE automation (
    id              TEXT PRIMARY KEY,
    /* Its name in configuration, as a device's key is. */
    key             TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    name            TEXT NOT NULL,
    rule            TEXT NOT NULL,
    made_from       TEXT,
    /* The home it is for: its clock, and its "home". NULL: the family's, on the first home's clock. */
    home_id         TEXT REFERENCES home (id),
    /* IANA, when it keeps a clock of its own; NULL: its home's. */
    time_zone       TEXT,
    mode            TEXT NOT NULL CHECK (mode IN ('off', 'watch', 'act')),
    recheck_minutes INTEGER CHECK (recheck_minutes IS NULL OR recheck_minutes BETWEEN 1 AND 1440),
    looked_at       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  /*
    Who a device is with (docs/PLAN-WORLD-MODEL.md §8.8): carries — its
    position is theirs — drives, its usual driver; owns, it is theirs; uses,
    theirs to use. Intervals: who carried it when is history. One carrier
    and one usual driver at a time. A device deleted takes its rows with it.
  */
  CREATE TABLE device_person (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES person (id),
    role      TEXT NOT NULL CHECK (role IN ('carries', 'drives', 'owns', 'uses')),
    since     TEXT NOT NULL,
    until     TEXT,
    PRIMARY KEY (device_id, person_id, role, since),
    CHECK (until IS NULL OR until > since)
  );
  CREATE UNIQUE INDEX device_person_one ON device_person (device_id, role) WHERE until IS NULL AND role IN ('carries', 'drives');
  CREATE INDEX device_person_person ON device_person (person_id) WHERE until IS NULL;

  /*
    Where people have been (docs/PLAN-WORLD-MODEL.md §8.9): stays at a home
    or in a zone — later a room — as intervals; the open ones are where each
    is now. Worked out from what they carry, as far as they share; kept as
    long as each says; never on the timeline.
  */
  CREATE TABLE presence_stay (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES person (id),
    place_id   TEXT,
    place_kind TEXT CHECK (place_kind IN ('home', 'zone')),
    space_id   TEXT REFERENCES space (id),
    since      TEXT NOT NULL,
    until      TEXT,
    /* What placed them there: the device they carry that said so. */
    device_id  TEXT REFERENCES device (id) ON DELETE SET NULL,
    FOREIGN KEY (place_id, place_kind) REFERENCES place (id, kind),
    CHECK ((place_id IS NULL) = (place_kind IS NULL)),
    CHECK ((place_id IS NULL) <> (space_id IS NULL)),
    CHECK (until IS NULL OR until > since)
  );
  /* At one home at a time, and in one room. Zones may overlap: a workplace in a town. */
  CREATE UNIQUE INDEX presence_stay_home ON presence_stay (person_id) WHERE until IS NULL AND place_kind = 'home';
  CREATE UNIQUE INDEX presence_stay_room ON presence_stay (person_id) WHERE until IS NULL AND space_id IS NOT NULL;
  CREATE INDEX presence_stay_place ON presence_stay (place_id, since);

  /*
    What a person is told (docs/PLAN-WORLD-MODEL.md §8.14): their inbox, by
    whom, delivered and read or not. Kept 90 days.
  */
  CREATE TABLE notification (
    id           TEXT PRIMARY KEY,
    person_id    TEXT NOT NULL REFERENCES person (id),
    /* The home it is about, if one. */
    home_id      TEXT REFERENCES home (id),
    level        TEXT NOT NULL CHECK (level IN ('info', 'warning', 'alarm')),
    title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    body         TEXT CHECK (length(body) <= 1000),
    /* Who said it: an automation, a device's event, a person. */
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    actor_id     TEXT,
    actor_name   TEXT NOT NULL,
    at           TEXT NOT NULL,
    delivered_at TEXT,
    read_at      TEXT
  );
  CREATE INDEX notification_person ON notification (person_id, at);

  /*
    Where one app — a node — can be woken with a message, and whose app it
    is: its push subscription, replaced as the platform renews it. A secret
    in effect: whoever has it can wake that app.
  */
  CREATE TABLE push_endpoint (
    node_id    TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES person (id),
    provider   TEXT NOT NULL CHECK (provider IN ('webpush', 'apns', 'fcm')),
    token      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX push_endpoint_person ON push_endpoint (person_id);

  /*
    Each person's own shortcuts on their home page (docs/PLAN-WORLD-MODEL.md
    §8.3): the automations they start from it, in their order. A person's
    own, never the family's; an automation deleted, or a person erased,
    takes theirs with it, and the others close up.
  */
  CREATE TABLE shortcut (
    person_id     TEXT NOT NULL REFERENCES person (id) ON DELETE CASCADE,
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (person_id, automation_id),
    UNIQUE (person_id, position)
  );

  /*
    What fills each of an automation's roles: a part of a device, or —
    for a step that starts one — another automation. A device removed stays
    a device (removed_at), so its automations stay and say they cannot run;
    one deleted takes its roles with it, and they say a role has no device.
    An automation deleted takes with it the roles that would start it, and
    the automations that used it say a role has nothing to start. What uses
    a device is asked here: a device's page lists the automations it is in.
  */
  CREATE TABLE automation_role (
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    device_id     TEXT REFERENCES device (id) ON DELETE CASCADE,
    part          TEXT,
    starts        TEXT REFERENCES automation (id) ON DELETE CASCADE,
    PRIMARY KEY (automation_id, role),
    CHECK ((device_id IS NOT NULL AND part IS NOT NULL AND starts IS NULL)
        OR (device_id IS NULL AND part IS NULL AND starts IS NOT NULL))
  );
  CREATE INDEX automation_role_device ON automation_role (device_id);
  CREATE INDEX automation_role_starts ON automation_role (starts);

  /*
    The parts filling each of an automation's groups — the roles a "for
    each" goes through — in their order (place 0, 1, …), each part once. A
    device deleted takes its place in them with it; one removed stays, and
    says it cannot run.
  */
  CREATE TABLE automation_group_part (
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    place         INTEGER NOT NULL CHECK (place >= 0),
    device_id     TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    part          TEXT NOT NULL,
    PRIMARY KEY (automation_id, role, place),
    UNIQUE (automation_id, role, device_id, part)
  );
  CREATE INDEX automation_group_part_device ON automation_group_part (device_id);

  /*
    Each "becomes" trigger's state, by its key — its id, or its place among
    its rule's triggers when it has none ("#2", triggerKey):
    whether its condition held when last looked at, since when it has held,
    and whether this hold has run it. Kept so a restart continues where it
    was: a hold resumes with the time it had left, and nothing fires twice.
    None kept — an automation just made, changed or let act — and a
    condition already true is its edge. Forgotten whenever it starts afresh.
  */
  CREATE TABLE automation_trigger (
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    trigger       TEXT NOT NULL CHECK (trigger <> ''),
    holds         INTEGER NOT NULL CHECK (holds IN (0, 1)),
    held_since    TEXT,
    fired         INTEGER NOT NULL CHECK (fired IN (0, 1)),
    PRIMARY KEY (automation_id, trigger),
    CHECK (holds = 1 OR (held_since IS NULL AND fired = 0))
  );

  /*
    When each of an automation's triggers, by its key, last started a run of
    it: what "at most every" is counted from, across a restart. Forgotten,
    as what its triggers saw is, whenever it starts afresh.
  */
  CREATE TABLE automation_trigger_start (
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    trigger       TEXT NOT NULL CHECK (trigger <> ''),
    started_at    TEXT NOT NULL,
    PRIMARY KEY (automation_id, trigger)
  );

  /*
    What each automation remembers (its memory), by name: the value a run
    last left it, as JSON, in its field's unit. Kept across runs, restarts
    and changes to the automation — a count goes on counting; a value its
    field no longer takes, or a name it no longer declares, is read as the
    value it starts from. Gone with the automation.
  */
  CREATE TABLE automation_memory (
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (name <> ''),
    value         TEXT NOT NULL,
    PRIMARY KEY (automation_id, name)
  );

  /*
    Each time an automation ran, or runs now (docs/SEQUENCES.md): when it
    started and ended, how it came out, why, and — in detail — what it read,
    how its conditions stood and each step it took. started_by_*: the person or
    assistant who started it — or who started the run that started it — as an
    actor; all NULL, triggers did. started_by_run: the run of another automation whose step
    started it; NULL, none did (or that run is gone). ended_at NULL: it is
    running, and its row is written at every step, so a screen follows it and
    a restart finds it: a run found unended on start was interrupted, and is
    ended as such, not resumed. One run of an automation at a time, held
    here. An automation's last run is its latest ended one; the timeline
    names a run by its id. What it would do, asked, is not a run: not kept.
  */
  CREATE TABLE automation_run (
    id            TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    outcome       TEXT NOT NULL CHECK (outcome IN ('acted', 'unverified', 'would-act', 'idle', 'unknown', 'refused', 'failed', 'running', 'stopped', 'interrupted')),
    started_by_kind TEXT CHECK (started_by_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    started_by_id   TEXT,
    started_by_name TEXT,
    started_by_run TEXT REFERENCES automation_run (id) ON DELETE SET NULL,
    why           TEXT NOT NULL,
    summary       TEXT NOT NULL,
    detail        TEXT NOT NULL,
    CHECK ((ended_at IS NULL) = (outcome = 'running')),
    CHECK ((started_by_kind IS NULL) = (started_by_name IS NULL) AND (started_by_id IS NULL OR started_by_kind IS NOT NULL))
  );
  CREATE INDEX automation_run_recent ON automation_run (automation_id, started_at);
  CREATE INDEX automation_run_started_by_run ON automation_run (started_by_run);
  CREATE UNIQUE INDEX automation_run_one_at_a_time ON automation_run (automation_id) WHERE ended_at IS NULL;

  /*
    A run's log (docs/SEQUENCES.md): what every device a run that takes
    steps used said while it ran, second by second — kept with the run, gone
    with it, and readable on its own whatever happens to the devices after:
    renamed, re-described, removed, or a role filled by another.

    automation_run_device: each device the run used, as it was then — its
    name and its type. Not a reference to device: a device removed since
    leaves its runs' logs whole.
  */
  CREATE TABLE automation_run_device (
    run_id    TEXT NOT NULL REFERENCES automation_run (id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    name      TEXT NOT NULL,
    type_id   TEXT NOT NULL,
    PRIMARY KEY (run_id, device_id)
  );

  /* Which part of which device filled each of the run's roles as it ran: "The charger's plug" was Smart plug, main — a group's, a row each part. */
  CREATE TABLE automation_run_role (
    run_id    TEXT NOT NULL,
    role      TEXT NOT NULL,
    label     TEXT NOT NULL,
    device_id TEXT NOT NULL,
    part      TEXT NOT NULL,
    PRIMARY KEY (run_id, role, device_id, part),
    FOREIGN KEY (run_id, device_id) REFERENCES automation_run_device (run_id, device_id) ON DELETE CASCADE
  );

  /*
    What each value the run kept was, as its device described it then: its
    part, its label, its kind — a number (with its unit and quantity, NULL
    where it has none), on/off, one of some options, or text (anything else,
    kept as JSON) — and, for on/off and options, the words its values are
    said in (JSON: {"true","false"}, or [{value,label}]; NULL when none).
  */
  CREATE TABLE automation_run_key (
    run_id    TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    part      TEXT NOT NULL,
    label     TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('number', 'boolean', 'enum', 'text')),
    unit      TEXT,
    quantity  TEXT,
    words     TEXT,
    PRIMARY KEY (run_id, device_id, key),
    FOREIGN KEY (run_id, device_id) REFERENCES automation_run_device (run_id, device_id) ON DELETE CASCADE,
    CHECK (kind = 'number' OR (unit IS NULL AND quantity IS NULL)),
    CHECK (words IS NULL OR kind IN ('boolean', 'enum'))
  );

  /*
    Every reading the run's devices gave while it ran: each time its value
    or its time changed. at: when the device took it; heard_at: when the run
    saw it — the two apart say how late a reading came. value: JSON, null
    for "the device has not said". Looked at every second; at most 20 000
    readings a run, so a run left waiting long cannot fill the disk.
  */
  CREATE TABLE automation_run_reading (
    run_id    TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    at        TEXT NOT NULL,
    heard_at  TEXT NOT NULL,
    value     TEXT NOT NULL,
    FOREIGN KEY (run_id, device_id, key) REFERENCES automation_run_key (run_id, device_id, key) ON DELETE CASCADE
  );
  CREATE INDEX automation_run_reading_by_time ON automation_run_reading (run_id, at);

  /* Whether each device could be reached while the run ran, each time that changed — and why not, in its holder's words. */
  CREATE TABLE automation_run_reach (
    run_id    TEXT NOT NULL,
    device_id TEXT NOT NULL,
    at        TEXT NOT NULL,
    reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
    detail    TEXT NOT NULL,
    FOREIGN KEY (run_id, device_id) REFERENCES automation_run_device (run_id, device_id) ON DELETE CASCADE
  );
  CREATE INDEX automation_run_reach_by_time ON automation_run_reach (run_id, at);

  /*
    What a person said not to offer again: something a transport sees, or a
    member behind a bridge, they do not mean to add. Found again, it is listed
    among the ignored, where it can be brought back. Named as a connection
    names a device: its transport and address, and — for a member — its
    bridge, the device it is behind.
  */
  CREATE TABLE sighting_ignored (
    transport  TEXT NOT NULL,
    through    TEXT REFERENCES device (id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    ignored_at TEXT NOT NULL,
    CHECK ((through IS NOT NULL) = (transport = 'bridge'))
  );
  CREATE UNIQUE INDEX sighting_ignored_once ON sighting_ignored (transport, coalesce(through, ''), address);

  /* What a transport keeps between runs, its own: a Bluetooth bond, a Matter fabric, a broker's credentials. */
  CREATE TABLE transport_kv (
    transport TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (transport, key)
  );

  /*
    What an integration's setups keep between them — an account's listing
    with its keys, a code given once — sealed as a connection's secrets are.
  */
  CREATE TABLE integration_kv (
    integration TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    encrypted   INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
    label       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (integration, key)
  );

  /*
    A home's own values, by a name listed here: its policy (how much is a
    load, the reserve). Nothing about one device or one automation: those
    are theirs.
  */
  CREATE TABLE home_setting (
    home_id    TEXT NOT NULL REFERENCES home (id),
    key        TEXT NOT NULL CHECK (key IN ('policy.values')),
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (home_id, key)
  );

  /*
    What this node has settled about the family it keeps, by name: in an
    app, whether its own family has moved to a server (family.moved), or the
    copy it kept of a server's has been brought in (family.kept).
  */
  CREATE TABLE node_setting (
    key        TEXT PRIMARY KEY CHECK (key IN ('family.moved', 'family.kept')),
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  /*
    The timeline: who did what, and what came of it. What an entry is about is
    a kind and an id — a device, a node, an automation, an account, what a
    transport saw — so the timeline can be asked for one thing's.
  */
  CREATE TABLE audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    /* Who did it, as they were called then: no reference, so a rename or a removal never rewrites what happened. */
    actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'automation', 'node', 'integration', 'system')),
    actor_id      TEXT,
    actor_name    TEXT NOT NULL,
    resource_kind TEXT CHECK (resource_kind IN ('device', 'node', 'automation', 'account', 'transport', 'family', 'home', 'zone', 'person')),
    resource      TEXT,
    summary       TEXT NOT NULL,
    detail        TEXT,
    CHECK ((resource IS NULL) = (resource_kind IS NULL))
  );
  CREATE INDEX audit_at ON audit (at);
  /* One entry once, when it is about something: a node that sends its timeline again adds nothing. */
  CREATE UNIQUE INDEX audit_once ON audit (at, kind, actor_kind, actor_name, resource_kind, resource, summary) WHERE resource IS NOT NULL;
  CREATE INDEX audit_resource ON audit (resource_kind, resource, at);

  /*
    What a node holding connections for the home's master owes it, in the
    order it was owed (docs/PLAN-SHARED-CORE.md, phase 6): what its devices
    read and said happened, what its gateway wrote on the timeline, what a
    session kept — sent when the master can be reached, and gone once it
    has them. Empty in a home that holds only for itself. No reference to a
    device: what is owed for one this node no longer holds is still sent, and
    refused there.
  */
  CREATE TABLE send_queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL CHECK (kind IN ('readings', 'event', 'audit', 'store')),
    device_id TEXT,
    body      TEXT NOT NULL,
    queued_at TEXT NOT NULL
  );
  /* What is owed of a kind, newest first: what trimming each kind to its most finds. */
  CREATE INDEX send_queue_kind ON send_queue (kind, id);

  /*
    In a node that follows: what its master last said, by what was asked —
    its devices, its automations, the home's values — each as it was
    answered, and when (docs/PLAN-SHARED-CORE.md, phase 6). What the app
    shows, read only and saying so, while the master cannot be reached.
    Empty on a master — a server, or a home the app keeps itself.
  */
  CREATE TABLE last_heard (
    what     TEXT PRIMARY KEY,
    body     TEXT NOT NULL,
    heard_at TEXT NOT NULL
  );
`;

/**
 * The schema's fingerprint, kept in the database's \`user_version\`: the SQL with
 * comments and spacing taken out — and the shape its rules are kept in
 * (\`ruleShape\`), which the SQL's \`rule TEXT\` does not show — hashed to a
 * positive 31-bit number. Any change to what the schema says, or to how a
 * rule is kept, changes it; a reworded comment does not.
 *
 * And the configuration document's version: a database holds a home as that
 * version says one is — its devices' ways, an account a device of its own —
 * so a home of another version is not used as it is, but set aside and
 * carried over through its kept file, whose migrations make it this version's
 * (docs/CONFIG.md). Without it, a way an integration's migration moved would
 * be left in the database as it was, and written back to the kept file under
 * the new version, where no migration would ever see it again.
 */
export function schemaFingerprint(schema = SCHEMA): number {
  const statements = `${schema
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} -- rules: ${ruleShape()} -- home: ${CURRENT_VERSION}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < statements.length; index++) hash = Math.imul(hash ^ statements.charCodeAt(index), 0x01000193) >>> 0;
  return (hash & 0x7fffffff) || 1;
}
