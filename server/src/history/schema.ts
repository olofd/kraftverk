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

  /* People who may use this server — from anywhere, the home network included. */
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    created_by          TEXT,
    password_changed_at TEXT NOT NULL,
    last_login_at       TEXT
  );

  /* The phones and browsers that hold connections, each belonging to a person. */
  CREATE TABLE client (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL,
    transports   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    client_id    TEXT REFERENCES client (id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    client_ip    TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  /*
    The devices you added, and they stay added: removing one keeps its history
    until that is deleted too. A device keeps what it is — its description:
    parts, attributes, events — and what it has said about itself, so a device
    that is closed or removed is still described.
  */
  CREATE TABLE device (
    id          TEXT PRIMARY KEY,
    type_id     TEXT NOT NULL,
    identity    TEXT,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL,
    /* Whose word the description is: its type's, for its config, or the device's own. */
    description_source TEXT NOT NULL DEFAULT 'type' CHECK (description_source IN ('type', 'device')),
    info        TEXT,
    added_at    TEXT NOT NULL,
    removed_at  TEXT
  );
  CREATE UNIQUE INDEX device_identity ON device (identity) WHERE identity IS NOT NULL AND removed_at IS NULL;

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

  /* Each device's own storage: what its session keeps between runs. */
  CREATE TABLE device_kv (
    device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (device_id, key)
  );

  /* How a device is reached: one row per way, held by the server or by one app. */
  CREATE TABLE device_connection (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    method            TEXT NOT NULL,
    transport         TEXT NOT NULL,
    held_by           TEXT REFERENCES client (id) ON DELETE CASCADE,
    address           TEXT NOT NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    config            TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    last_connected_at TEXT
  );
  CREATE INDEX device_connection_address ON device_connection (transport, address);
  CREATE UNIQUE INDEX device_connection_once ON device_connection (device_id, method, IFNULL(held_by, 'server'));

  /* A server-held connection's secrets, sealed when a key is given. */
  CREATE TABLE connection_secret (
    connection_id TEXT NOT NULL REFERENCES device_connection (id) ON DELETE CASCADE,
    field         TEXT NOT NULL,
    value         TEXT NOT NULL,
    encrypted     INTEGER NOT NULL,
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
  CREATE INDEX device_event_problems ON device_event (level, at) WHERE level <> 'info';

  /*
    Automations: a recipe, the parts of devices that fill its roles, its
    settings and the owner's clock. Devices are named in roles, not by foreign
    key: an automation whose device is removed stays, and says it cannot run.
    recheck_minutes: how often a condition that still holds is looked at
    again, to keep things so; NULL, never — what it did stays until a
    condition turns true again.
  */
  CREATE TABLE automation (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    recipe          TEXT NOT NULL,
    roles           TEXT NOT NULL,
    params          TEXT NOT NULL,
    time_zone       TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'armed')),
    recheck_minutes INTEGER CHECK (recheck_minutes IS NULL OR recheck_minutes BETWEEN 1 AND 1440),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    last_run_at TEXT,
    last_result TEXT
  );

  /* What a transport keeps between runs, its own: a Bluetooth bond, a Matter fabric, a broker's credentials. */
  CREATE TABLE transport_kv (
    transport TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (transport, key)
  );

  /* Decisions the server keeps: the gateway's memory of each part's last switch, each trigger's state. */
  CREATE TABLE app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  /*
    The timeline: who did what, and what came of it. What an entry is about is
    a kind and an id — a device, an app, an automation, an account, what a
    transport saw — so the timeline can be asked for one thing's.
  */
  CREATE TABLE audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    actor         TEXT NOT NULL,
    resource_kind TEXT CHECK (resource_kind IN ('device', 'client', 'automation', 'account', 'transport')),
    resource      TEXT,
    summary       TEXT NOT NULL,
    detail        TEXT,
    CHECK ((resource IS NULL) = (resource_kind IS NULL))
  );
  CREATE INDEX audit_at ON audit (at);
  CREATE INDEX audit_resource ON audit (resource_kind, resource, at);
`;

/**
 * The schema's fingerprint, kept in the database's \`user_version\`: the SQL with
 * comments and spacing taken out, hashed to a positive 31-bit number. Any
 * change to what the schema says changes it; a reworded comment does not.
 */
export function schemaFingerprint(schema = SCHEMA): number {
  const statements = schema
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < statements.length; index++) hash = Math.imul(hash ^ statements.charCodeAt(index), 0x01000193) >>> 0;
  return (hash & 0x7fffffff) || 1;
}
