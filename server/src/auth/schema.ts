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
  the new one (`platform/database.ts`): the accounts — name, password hash,
  when and by whom made — so the owner is not asked to claim their own
  server again. Never the sign-ins: a new schema signs everyone out. Kept
  nowhere else: this database is the one place an account lives, and the
  configuration kept beside the family's, which may leave the server, never
  holds one.
*/
export const ACCOUNTS_CARRIED = ['users'] as const;
export const NODE_SCHEMA = `
  /* What this database is: its schema, when, and by which version — as the family's says of itself. */
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

  /* A sign-in: a random token in an httpOnly cookie, kept only as its hash. */
  CREATE TABLE login_session (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    client_ip    TEXT,
    user_agent   TEXT
  );
  CREATE INDEX login_session_user ON login_session (user_id);
`;
