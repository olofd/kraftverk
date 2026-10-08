/*
  The node's own database (docs/PLAN-WORLD-MODEL.md §7): who may use this
  node's HTTP entrance, and their sign-ins. Accounts are the server's — a
  phone or a browser keeping a home has none — so they are not in the
  family's schema (\`@kraftverk/store\`'s \`SCHEMA\`), nor in its file:
  \`node.db\` beside it, set aside only when this schema changes. A family's
  database set aside for its own new schema signs nobody out.
*/

/*
  What the node's database, set aside for a new schema of its own, hands to
  the new one (`platform/database.ts`): the logins — name, password hash,
  the person each is, when and by whom made — so the owner is not asked to
  claim their own server again. Never the sign-ins: a new schema signs
  everyone out. Kept nowhere else: this database is the one place a
  password lives, and the configuration kept beside the family's, which
  may leave the server, never holds one.
*/
export const ACCOUNTS_CARRIED = ['login'] as const;
export const NODE_SCHEMA = `
  /* What this database is: its schema, when, and by which version — as the family's says of itself. */
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY CHECK (key IN ('schema_hash', 'created_at', 'created_by_version')),
    value TEXT NOT NULL
  );

  /*
    A way in at this server's entrance (docs/PLAN-WORLD-MODEL.md §10.5): a
    username and its password, naming the person it is in the family this
    node serves — from anywhere, the home network included. A person's own
    device signs in by its key instead, and needs none.
  */
  CREATE TABLE login (
    id                  TEXT PRIMARY KEY,
    /* The person it is: p-…, in the family's database. */
    person_id           TEXT NOT NULL CHECK (person_id GLOB 'p-*'),
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    /* The username of the login that added it; null for the first. */
    created_by          TEXT,
    password_changed_at TEXT NOT NULL,
    last_login_at       TEXT
  );

  /* A sign-in: a person, and a random token in an httpOnly cookie, kept only as its hash. */
  CREATE TABLE login_session (
    token_hash   TEXT PRIMARY KEY,
    person_id    TEXT NOT NULL CHECK (person_id GLOB 'p-*'),
    /* The login it was opened with; null: the person's own key opened it. */
    login_id     TEXT REFERENCES login (id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    client_ip    TEXT,
    user_agent   TEXT
  );
  CREATE INDEX login_session_person ON login_session (person_id);
`;
