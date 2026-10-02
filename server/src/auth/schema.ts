/*
  The server's own tables, beside the home's in the same database: who may
  use this node's HTTP entrance, and their sign-ins. Accounts are the
  server's — a phone or a browser keeping a home has none — so they are not
  in the schema every node carries (\`@kraftverk/store\`'s \`SCHEMA\`), and the
  home's reset leaves them alone. One definition still: the server's
  database is made from both, and its fingerprint covers both.
*/
export const ACCOUNTS_SCHEMA = `
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
