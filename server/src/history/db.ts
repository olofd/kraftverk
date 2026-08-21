import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { Database } from 'bun:sqlite';

/**
 * One SQLite file for everything that has to outlive a restart: plugin
 * configuration, secrets, capability grants and the audit timeline.
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
  migrate(handle);
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
const MIGRATIONS: { id: number; sql: string }[] = [
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
        register map differs between a P280 and an F2400, so it must not be
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
];

function migrate(handle: Db): void {
  handle.exec('CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    handle.query<{ id: number }, []>('SELECT id FROM migration').all().map((row) => row.id)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    handle.transaction(() => {
      handle.exec(migration.sql);
      handle.query('INSERT INTO migration (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString()
      );
    })();
  }
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
const secretKey = (): Buffer | null => {
  const passphrase = process.env.KRAFTVERK_SECRET_KEY;
  if (!passphrase) return null;
  return scryptSync(passphrase, 'kraftverk-plugin-secrets', 32);
};

export const secretsAreEncrypted = (): boolean => secretKey() !== null;

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
