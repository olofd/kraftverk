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
    The home this database keeps: one. What every node and device here is
    part of; and its master — the node whose database is the home's, the
    one that writes it. Another node follows it, and can take its place.
  */
  CREATE TABLE home (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    master_id  TEXT NOT NULL REFERENCES node (id),
    created_at TEXT NOT NULL,
    /* Where it is, in degrees — what the sun's times are told by. Both null: not said. */
    latitude   REAL CHECK (latitude BETWEEN -90 AND 90),
    longitude  REAL CHECK (longitude BETWEEN -180 AND 180),
    CHECK ((latitude IS NULL) = (longitude IS NULL))
  );

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
      Which picture it shows, its owner's pick: one of its type's (type:N), or
      — not built yet — a photo of its own (own:<id>). NULL: its type's first.
    */
    picture     TEXT CHECK (picture IS NULL OR picture GLOB 'type:[0-9]*' OR picture GLOB 'own:?*'),
    added_at    TEXT NOT NULL,
    /* When its owner paused it: kept, and not reached, until resumed. NULL: it is not paused. */
    paused_at   TEXT,
    removed_at  TEXT
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
    switched_by TEXT NOT NULL,
    PRIMARY KEY (device_id, part)
  );

  /* And when each setting it wrote was written, last, and by whom: one write per setting per dwell. */
  CREATE TABLE device_write (
    device_id  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    attribute  TEXT NOT NULL,
    written_at TEXT NOT NULL,
    written_by TEXT NOT NULL,
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
    not yet. home_place: its place among the shortcuts on the home page;
    NULL, not there.
  */
  CREATE TABLE automation (
    id              TEXT PRIMARY KEY,
    /* Its name in configuration, as a device's key is. */
    key             TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) <= 63),
    name            TEXT NOT NULL,
    rule            TEXT NOT NULL,
    made_from       TEXT,
    time_zone       TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('off', 'watch', 'act')),
    recheck_minutes INTEGER CHECK (recheck_minutes IS NULL OR recheck_minutes BETWEEN 1 AND 1440),
    home_place      INTEGER CHECK (home_place IS NULL OR home_place >= 0),
    looked_at       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX automation_home ON automation (home_place) WHERE home_place IS NOT NULL;

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
    how its conditions stood and each step it took. started_by: the person or
    assistant who started it — or who started the run that started it; NULL,
    triggers did. started_by_run: the run of another automation whose step
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
    started_by    TEXT,
    started_by_run TEXT REFERENCES automation_run (id) ON DELETE SET NULL,
    why           TEXT NOT NULL,
    summary       TEXT NOT NULL,
    detail        TEXT NOT NULL,
    CHECK ((ended_at IS NULL) = (outcome = 'running'))
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
    What this node has settled for the home it keeps, by name, each one
    named here: its policy values (how much is a load); and, in an app,
    whether its own home has moved to a server (home.moved), or the copy it
    kept of a server's has been brought in (home.kept). Nothing about one
    device or one automation: those are theirs.
  */
  CREATE TABLE home_setting (
    key        TEXT PRIMARY KEY CHECK (key IN ('policy.values', 'home.moved', 'home.kept')),
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
    actor         TEXT NOT NULL,
    resource_kind TEXT CHECK (resource_kind IN ('device', 'node', 'automation', 'account', 'transport')),
    resource      TEXT,
    summary       TEXT NOT NULL,
    detail        TEXT,
    CHECK ((resource IS NULL) = (resource_kind IS NULL))
  );
  CREATE INDEX audit_at ON audit (at);
  /* One entry once, when it is about something: a node that sends its timeline again adds nothing. */
  CREATE UNIQUE INDEX audit_once ON audit (at, kind, actor, resource_kind, resource, summary) WHERE resource IS NOT NULL;
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
