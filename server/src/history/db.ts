import type { AuditEntry } from '@kraftverk/api-contract';
import type { AuditRecord, ResourceKind } from '@kraftverk/device-sdk';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { Database } from 'bun:sqlite';

import { SCHEMA, schemaFingerprint } from './schema.ts';

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
 * same schema is made in a throwaway. Read when the database is first
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

/** The version of kraftverk this is, as its package says: what a new database records it was made by. */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** What a database says it is, from its `meta` table — or nothing, for one from before there was one. */
function metaOf(handle: Db): Record<string, string> {
  try {
    return Object.fromEntries(handle.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}

function open(path: string): Db {
  const handle = new Database(path, { create: true });
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  // The recovery CLI may write while the server does: wait for the lock
  // rather than failing at once with SQLITE_BUSY.
  handle.exec('PRAGMA busy_timeout = 5000');
  return handle;
}

export function db(): Db {
  if (database) return database;

  const path = file();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  database = openSchema(path);
  return database;
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
 * Opens the database with this schema — and only this one (docs/ARCHITECTURE.md
 * §9, decision 21: strict version 1, no migrations).
 *
 * A new file gets the schema and its fingerprint. A file whose fingerprint
 * matches is used as it is. A file built from any other schema is not changed:
 * it is set aside beside itself — `kraftverk.db.set-aside.<time>` — and a new
 * one is started, saying so in the log. Nothing is deleted; history from the
 * old schema is simply not carried over. Returns the handle, and where the old
 * file went when one was set aside.
 *
 * Exported for tests.
 */
export function openSchema(path: string, schema = SCHEMA): Db & { setAside?: string } {
  const fingerprint = schemaFingerprint(schema);
  let handle = open(path);
  const version = handle.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  const tables = handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.n ?? 0;

  if (tables > 0 && version === fingerprint) return handle;

  let setAside: string | undefined;
  if (tables > 0) {
    if (path === ':memory:') throw new Error('An in-memory database with another schema: nothing to set aside');
    const old = metaOf(handle);
    handle.close();
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
    setAside = `${path}.set-aside.${stamp}`;
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) renameSync(path + suffix, setAside + suffix);
    const madeBy = old.created_by_version ? `, made by kraftverk ${old.created_by_version} on ${old.created_at?.slice(0, 10)} with schema ${old.schema_hash},` : '';
    console.warn(`[db] ${path} was made by another schema${madeBy} and is set aside as ${setAside}; a new database is started. Nothing was deleted.`);
    handle = open(path);
  }

  handle.transaction(() => {
    handle.exec(schema);
    handle.exec(`PRAGMA user_version = ${fingerprint}`);
    const remember = handle.query('INSERT INTO meta (key, value) VALUES (?, ?)');
    remember.run('schema_hash', String(fingerprint));
    remember.run('created_at', new Date().toISOString());
    remember.run('created_by_version', VERSION);
  })();
  return Object.assign(handle, setAside ? { setAside } : {});
}

/**
 * Empties every table, keeping the schema.
 *
 * `users`, `sessions` and `client` are kept: erasing the house is not erasing
 * who may enter it, and a server left with no accounts is one waiting to be
 * claimed. `meta` is kept: it is what the database is, not what is in it.
 * Everything else goes —
 * devices, samples, connections, secrets, links and the audit
 * timeline — which is the point. This is "back to a blank canvas" without
 * asking anyone to find and delete a file on the server.
 *
 * Deliberately not `DROP TABLE`: the schema is `schema.ts`'s business, and
 * recreating it here would be a second definition to drift.
 */
export function resetDatabase(): { tables: string[]; rows: number } {
  const handle = db();
  const tables = handle
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('users', 'sessions', 'client', 'meta') ORDER BY name"
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
    handle.query('DELETE FROM sqlite_sequence').run();
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

/** Every decision kept under a prefix, by the rest of its key: each device's picture, in one read. */
export function appStatesUnder(prefix: string): Map<string, string> {
  const rows = db()
    .query<{ key: string; value: string }, [string]>("SELECT key, value FROM app_state WHERE key LIKE ? ESCAPE '\\'")
    .all(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return new Map(rows.map((row) => [row.key.slice(prefix.length), row.value]));
}

/** Forgets every decision kept under a prefix: an automation's triggers, when it changes or goes. */
export function deleteAppState(prefix: string): void {
  db().query("DELETE FROM app_state WHERE key LIKE ? ESCAPE '\\'").run(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
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
    derived = { passphrase, key: scryptSync(passphrase, 'kraftverk-secrets', 32) };
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

/** Adds a line to the timeline. What the API returns of it is the contract's `AuditEntry`. */
export function audit(entry: AuditRecord): void {
  db()
    .query('INSERT INTO audit (at, kind, actor, resource_kind, resource, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      entry.at,
      entry.kind,
      entry.actor,
      entry.resource === undefined ? null : entry.resourceKind,
      entry.resource ?? null,
      entry.summary,
      entry.detail === undefined ? null : JSON.stringify(entry.detail)
    );
}

type AuditRow = { id: number; at: string; kind: string; actor: string; resource_kind: ResourceKind | null; resource: string | null; summary: string; detail: string | null };

/** The timeline, newest first: all of it, or what is about one kind of thing, or one thing. */
export function recentAudit(options: { limit?: number; resourceKind?: ResourceKind; resource?: string; before?: number } = {}): AuditEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (options.resourceKind) (where.push('resource_kind = ?'), args.push(options.resourceKind));
  if (options.resource) (where.push('resource = ?'), args.push(options.resource));
  if (options.before) (where.push('id < ?'), args.push(options.before));
  return db()
    .query<AuditRow, (string | number)[]>(
      `SELECT id, at, kind, actor, resource_kind, resource, summary, detail FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, options.limit ?? 100)
    .map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind,
      actor: row.actor,
      resourceKind: row.resource_kind,
      resource: row.resource,
      summary: row.summary,
      detail: row.detail ? (JSON.parse(row.detail) as unknown) : undefined,
    }));
}
