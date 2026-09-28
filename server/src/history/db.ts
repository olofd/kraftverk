import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { Database } from 'bun:sqlite';

import * as connections from './migrations/007-connections.ts';

/**
 * One SQLite file for everything that has to outlive a restart: devices,
 * their connections and sealed secrets, history, links and the audit timeline.
 *
 * `bun:sqlite` is built into the runtime, so this adds no dependency. The file
 * lives beside the station's other state in `server/data/`, which is gitignored.
 */

/**
 * `KRAFTVERK_DB` exists for tests, which must not write to the database the
 * owner's devices live in. Point it at a temp file — or `:memory:` — and the
 * same migrations run against a throwaway. Read when the database is first
 * opened rather than when this module loads, so a test can set it.
 */
const DEFAULT_FILE = () => resolve(import.meta.dirname, '../../data/kraftverk.db');

/**
 * A test may never open the real database. This is not a style rule.
 *
 * Every server test sets `KRAFTVERK_DB` in `beforeAll` and cleared it again in
 * `afterAll` — but bun runs all test files in one process, sharing this
 * module's handle and `process.env`. So the moment one file finished and
 * cleared the variable, the next file's `beforeEach` — several of which begin
 * `DELETE FROM device; DELETE FROM sample` — reopened *this* path and truncated
 * the owner's catalog and every sample it had ever recorded.
 *
 * It did exactly that, and the tests still passed, because they were deleting
 * from a database that happened to satisfy them. Refusing to open the default
 * path under a test runner turns a silent, order-dependent data loss into a
 * failure on the first line that causes it.
 */
const file = () => {
  const configured = process.env.KRAFTVERK_DB;
  if (configured) return configured;

  if (process.env.NODE_ENV === 'test') {
    throw new Error(
      'A test tried to open the real database. Set KRAFTVERK_DB to a temp file ' +
        'before anything calls db(), and do not clear it while other files may still run.'
    );
  }

  return DEFAULT_FILE();
};

export type Db = Database;

let database: Db | null = null;

export function db(): Db {
  if (database) return database;

  const path = file();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const handle = new Database(path, { create: true });
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  // The recovery CLI may write while the server does: wait for the lock
  // rather than failing at once with SQLITE_BUSY.
  handle.exec('PRAGMA busy_timeout = 5000');
  migrate(handle, path);
  database = handle;
  return handle;
}

/**
 * Closes the handle, so the next `db()` opens whatever `KRAFTVERK_DB` now says.
 *
 * For tests, which need a database of their own rather than the one the owner's
 * devices live in. Nothing in the running server closes the database.
 */
export function closeDb(): void {
  database?.close();
  database = null;
}

/**
 * Migrations run transactionally at boot, in order, once each.
 *
 * Deliberately plain: a numbered list and a table of what has been applied. A
 * migration framework would be more code than the thing it manages.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE plugin_config (
        plugin_id  TEXT PRIMARY KEY,
        json       TEXT NOT NULL DEFAULT '{}',
        enabled    INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE plugin_secret (
        plugin_id  TEXT NOT NULL,
        field      TEXT NOT NULL,
        value      TEXT NOT NULL,
        encrypted  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (plugin_id, field)
      );
      CREATE TABLE plugin_kv (
        plugin_id TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
      CREATE TABLE capability_grant (
        plugin_id  TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, capability)
      );
      CREATE TABLE audit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT NOT NULL,
        kind     TEXT NOT NULL,
        actor    TEXT NOT NULL,
        resource TEXT,
        summary  TEXT NOT NULL,
        detail   TEXT
      );
      CREATE INDEX audit_at ON audit (at);
    `,
  },
  {
    id: 2,
    sql: `
      CREATE TABLE active_provider (
        resource  TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        chosen_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    sql: `
      /*
        The devices you have added, and they stay added.

        Deliberately not derived from whatever happens to be reachable: a plug
        that is unplugged for a week is still yours, and should still be in the
        list — greyed, with its history intact — rather than silently vanishing
        and taking its charts with it.

        The model is stored because it changes how the thing is read: the
        register map differs between two models of one stack, so it must not be
        guessed.
      */
      CREATE TABLE device (
        id        TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        model     TEXT,
        driver    TEXT NOT NULL,
        name      TEXT NOT NULL,
        config    TEXT NOT NULL DEFAULT '{}',
        added_at  TEXT NOT NULL
      );

      /*
        One row per device, per measurement, per sample. Narrow on purpose: a
        column per quantity would need a migration every time any device learns
        to measure something new, and could never hold a device nobody has
        written yet.
      */
      CREATE TABLE sample (
        device_id TEXT NOT NULL,
        key       TEXT NOT NULL,
        at        TEXT NOT NULL,
        value     REAL,
        PRIMARY KEY (device_id, key, at)
      );
      CREATE INDEX sample_lookup ON sample (device_id, key, at);
    `,
  },
  {
    id: 4,
    sql: `
      /*
        Decisions the app has already put to the user, so it stops asking.

        The first of them is the legacy station import: someone who bound a
        station before there was a device catalog gets offered it once, and
        whether they took it or waved it away has to outlive the restart. A
        banner that reappears every boot is a banner people learn to ignore.
      */
      CREATE TABLE app_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 5,
    sql: `
      /*
        People who may use this server — from anywhere, the home network included.

        Every account is an administrator: there is one kind of person here,
        the owner and whoever they trust with the house. The password is an
        argon2id hash; the name is unique regardless of case, because "Olof"
        and "olof" being two different accounts is a support call, not a
        feature.
      */
      CREATE TABLE users (
        id                  TEXT PRIMARY KEY,
        username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        created_by          TEXT,
        password_changed_at TEXT NOT NULL,
        last_login_at       TEXT
      );

      /*
        Signed-in browsers. The token itself is never stored — only its SHA-256
        — so a copy of this database cannot be replayed as a live session.
      */
      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        client_ip    TEXT,
        user_agent   TEXT
      );
      CREATE INDEX sessions_user ON sessions (user_id);
    `,
  },
  {
    id: 6,
    sql: `
      /*
        Each device's own storage: what its session keeps between runs — a
        simulated station's settings, a plug's detected protocol version.

        Keyed by the device, not by the code that wrote it, so two plugs of the
        same type cannot read each other's; and it goes with the device when the
        device is forgotten. See docs/ARCHITECTURE.md §4.5.
      */
      CREATE TABLE device_kv (
        device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (device_id, key)
      );
    `,
  },
  // Devices reached through connections; the plugin tables go. See the file.
  { id: 7, sql: connections.SQL, run: connections.run },
];

/**
 * One step of the schema's history.
 *
 * `sql` for a change of shape; `run` as well when data has to move in ways SQL
 * alone says badly — both inside the same transaction, so a migration that
 * fails part-way leaves nothing behind.
 */
export type Migration = { id: number; sql: string; run?: (handle: Db) => void };

/**
 * Brings a database up to date, copying it first if it holds anything.
 *
 * The copy is the way back. Migrations change the owner's only record of their
 * devices and everything they measured, on a server nobody is watching when it
 * restarts after a deploy — so before the first pending migration touches a
 * database that has already been migrated, the whole file is copied beside
 * itself. Rolling back is stopping the server and putting the copy in place.
 *
 * A copy that cannot be made stops the migration, and with it the server:
 * starting on the old schema is safe, changing data with no way back is not.
 *
 * Exported for tests, which bring their own list.
 */
export function migrate(handle: Db, path: string, migrations: readonly Migration[] = MIGRATIONS): string | null {
  handle.exec('CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    handle.query<{ id: number }, []>('SELECT id FROM migration').all().map((row) => row.id)
  );

  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (pending.length === 0) return null;

  // A fresh database has nothing to lose, and one in memory nowhere to copy to.
  const backup = applied.size > 0 && path !== ':memory:' ? copyBefore(handle, path, pending[0]!.id) : null;

  for (const migration of pending) {
    handle.transaction(() => {
      handle.exec(migration.sql);
      migration.run?.(handle);
      handle.query('INSERT INTO migration (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      );
    })();
  }

  return backup;
}

/** `kraftverk.db` → `kraftverk.db.before-migration-6.2026-09-27T10-15-00Z` */
function copyBefore(handle: Db, path: string, id: number): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
  const target = `${path}.before-migration-${id}.${stamp}`;
  // A consistent copy of a live WAL database in one statement, unlike copying
  // the file, which can catch it half-written.
  handle.query('VACUUM INTO ?').run(target);
  console.log(`[db] Copied the database to ${target} before migrating it. To roll back, stop the server and put that file in place of ${path}.`);
  return target;
}

/**
 * Empties every table, keeping the schema.
 *
 * `migration` is kept: dropping those rows would make the next boot try to
 * create tables that already exist. So are `users` and `sessions`: erasing
 * the house is not erasing who may enter it, and a server left with no
 * accounts is one waiting to be claimed. Everything else goes —
 * devices, samples, connections, secrets, links and the audit
 * timeline — which is the point. This is "back to a blank canvas" without
 * asking anyone to find and delete a file on the server.
 *
 * Deliberately not `DROP TABLE`: the schema is the migrations' business, and
 * recreating it here would be a second definition to drift.
 */
export function resetDatabase(): { tables: string[]; rows: number } {
  const handle = db();
  const tables = handle
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('migration', 'users', 'sessions', 'client') ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  let rows = 0;

  handle.transaction(() => {
    for (const table of tables) {
      rows += handle.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()?.n ?? 0;
      handle.query(`DELETE FROM ${table}`).run();
    }
    // AUTOINCREMENT keeps its high-water mark in this table; clearing it means
    // a reset database really does start from one rather than from wherever
    // the last one left off.
    handle.query("DELETE FROM sqlite_sequence WHERE name <> 'migration'").run();
  })();

  // Reclaims the space rather than leaving a 20 MB file describing nothing.
  handle.exec('VACUUM');

  return { tables, rows };
}

// --- app state -------------------------------------------------------------

/** A decision the app has already made, or null if it never has. */
export function appState(key: string): string | null {
  return (
    db()
      .query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?')
      .get(key)?.value ?? null
  );
}

export function setAppState(key: string, value: string): void {
  db()
    .query(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}

// --- secrets ---------------------------------------------------------------

/**
 * Secrets are encrypted only if a key is supplied from outside.
 *
 * With `KRAFTVERK_SECRET_KEY` set, values are AES-256-GCM sealed. Without it
 * they are stored as given — and `secretsAreEncrypted()` reports that plainly
 * so the UI can say so, because a key kept next to the data it protects would
 * be decoration rather than encryption.
 */
/*
  Derived once per passphrase. scrypt is slow on purpose and synchronous here,
  and it ran on every secret read — and on every poll of a list of devices,
  just to learn whether a key exists — stalling the whole server each time.
*/
let derived: { passphrase: string; key: Buffer } | null = null;

const secretKey = (): Buffer | null => {
  const passphrase = process.env.KRAFTVERK_SECRET_KEY;
  if (!passphrase) return null;
  if (derived?.passphrase !== passphrase) {
    // The salt keeps its old name: changing it would make every stored secret unreadable.
    // The salt keeps its old name: changing it would make every stored secret unreadable.
    derived = { passphrase, key: scryptSync(passphrase, 'kraftverk-plugin-secrets', 32) };
  }
  return derived.key;
};

export const secretsAreEncrypted = (): boolean => Boolean(process.env.KRAFTVERK_SECRET_KEY);

export function sealSecret(value: string): { value: string; encrypted: boolean } {
  const key = secretKey();
  if (!key) return { value, encrypted: false };

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    value: `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${sealed.toString('base64')}`,
    encrypted: true,
  };
}

export function openSecret(stored: string, encrypted: boolean): string | null {
  if (!encrypted) return stored;

  const key = secretKey();
  if (!key) return null; // sealed with a key that is no longer present

  const [iv, tag, payload] = stored.split('.');
  if (!iv || !tag || !payload) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- audit -----------------------------------------------------------------

export type AuditEntry = {
  at: string;
  kind: string;
  actor: string;
  resource?: string;
  summary: string;
  detail?: unknown;
};

export function audit(entry: AuditEntry): void {
  db()
    .query('INSERT INTO audit (at, kind, actor, resource, summary, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      entry.at,
      entry.kind,
      entry.actor,
      entry.resource ?? null,
      entry.summary,
      entry.detail === undefined ? null : JSON.stringify(entry.detail)
    );
}

export function recentAudit(limit = 100): AuditEntry[] {
  return db()
    .query<{ at: string; kind: string; actor: string; resource: string | null; summary: string; detail: string | null }, [number]>(
      'SELECT at, kind, actor, resource, summary, detail FROM audit ORDER BY id DESC LIMIT ?'
    )
    .all(limit)
    .map((row) => ({
      at: row.at,
      kind: row.kind,
      actor: row.actor,
      resource: row.resource ?? undefined,
      summary: row.summary,
      detail: row.detail ? (JSON.parse(row.detail) as unknown) : undefined,
    }));
}
