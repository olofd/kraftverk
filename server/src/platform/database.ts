import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import type { AuditRecord, DeviceStore, PolicyValueName, PolicyValues, SavedDeviceId, TransportStore } from '@kraftverk/device-sdk';
import type { GatewayLedger } from '@kraftverk/gateway';
import {
  AppState,
  AuditLog,
  createSchema,
  databaseLedger as ledgerOf,
  deviceStore as deviceStoreOf,
  metaOf,
  policyValues as policyValuesOf,
  prepareDatabase,
  resetDatabase as resetOf,
  SCHEMA,
  schemaStateOf,
  setPolicyValue as setPolicyValueOf,
  transportStore as transportStoreOf,
  type SqlDatabase,
} from '@kraftverk/store';

/**
 * The server's database: one SQLite file for everything that has to outlive a
 * restart — devices, their connections and sealed secrets, history, links,
 * automations and the timeline. The schema and every store are
 * `@kraftverk/store`'s, shared with the app; what is the server's is here: the
 * file, opening it through bun:sqlite (built into the runtime), setting an
 * old one aside, and the one handle the server's code reaches.
 *
 * The file lives in `server/data/`, which is gitignored.
 */

/**
 * `KRAFTVERK_DB` exists for tests, which must not write to the database the
 * owner's devices live in. Point it at a temp file — or `:memory:` — and the
 * same schema is made in a throwaway. Read when the database is first opened
 * rather than when this module loads, so a test can set it.
 */
const DEFAULT_FILE = () => resolve(import.meta.dirname, '../../data/kraftverk.db');

/**
 * A test may never open the real database. This is not a style rule.
 *
 * bun runs all test files in one process, sharing this module's handle and
 * `process.env`. When one file cleared `KRAFTVERK_DB`, the next file's
 * `DELETE FROM device; DELETE FROM sample` reopened *this* path and truncated
 * the owner's catalog and every sample it had ever recorded — and the tests
 * passed. Refusing the default path under a test runner turns that silent,
 * order-dependent loss into a failure on the first line that causes it.
 */
const file = (): string => {
  const configured = process.env.KRAFTVERK_DB;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('A test tried to open the real database. Set KRAFTVERK_DB to a temp file before anything calls db(), and do not clear it while other files may still run.');
  }
  return DEFAULT_FILE();
};

/** Where the database is: `KRAFTVERK_DB`, or the default beside the server. What the configuration kept beside it is kept beside. */
export const databaseFile = (): string => file();

/** The version of kraftverk this is, as its package says: what a new database records it was made by. */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/*
  bun:sqlite's Database is the port as it stands — query with get, all and
  run, exec, transaction, close — so it is handed over as it is, and runs
  exactly as before.
*/
function open(path: string): SqlDatabase {
  const handle = new Database(path, { create: true });
  handle.exec('PRAGMA journal_mode = WAL');
  // The recovery CLI may write while the server does: wait for the lock rather than failing at once with SQLITE_BUSY.
  handle.exec('PRAGMA busy_timeout = 5000');
  const db = handle as unknown as SqlDatabase;
  prepareDatabase(db);
  return db;
}

/**
 * Opens the database with this schema — and only this one (docs/ARCHITECTURE.md
 * §9, decision 21: strict version 1, no migrations).
 *
 * A new file gets the schema. A file whose schema matches is used as it is. A
 * file built from any other schema is not changed: it is set aside beside
 * itself — `kraftverk.db.set-aside.<time>` — and a new one is started, saying
 * so in the log. Nothing is deleted. Exported for tests.
 */
export function openSchema(path: string, schema = SCHEMA): SqlDatabase & { setAside?: string; created?: boolean } {
  let handle = open(path);
  const state = schemaStateOf(handle, schema);
  if (state === 'current') return handle;

  let setAside: string | undefined;
  if (state === 'other') {
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
  createSchema(handle, VERSION, schema);
  return Object.assign(handle, { created: true }, setAside ? { setAside } : {});
}

let database: SqlDatabase | null = null;
/** Whether the database open now was started this run — new, or a new one after one of another schema was set aside — and what was set aside. */
let started: { fresh: boolean; setAside: string | null } = { fresh: false, setAside: null };

/** The server's database, opened the first time it is asked for. */
export function db(): SqlDatabase {
  if (database) return database;
  const path = file();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const opened = openSchema(path);
  started = { fresh: Boolean(opened.created), setAside: opened.setAside ?? null };
  database = opened;
  return database;
}

/** Whether the database was started afresh as it opened: what the server restores the configuration kept beside it into (docs/CONFIG.md). */
export const startedFresh = (): { fresh: boolean; setAside: string | null } => (db(), started);

/** Closes the handle, so the next `db()` opens whatever `KRAFTVERK_DB` now says. For tests; nothing in the running server closes it. */
export function closeDb(): void {
  database?.close();
  database = null;
  log = null;
}

// --- the server's stores, bound to its database ----------------------------------

/** Empties every table but accounts, apps and what the database is. */
export const resetDatabase = (): { tables: string[]; rows: number } => resetOf(db());

/** A decision the app has already made, or null if it never has. */
export const appState = (key: string): string | null => new AppState(db()).get(key);
export const setAppState = (key: string, value: string): void => new AppState(db()).set(key, value);

export const policyValues = (): PolicyValues => policyValuesOf(new AppState(db()));
export const setPolicyValue = (name: PolicyValueName, value: number | null): PolicyValues => setPolicyValueOf(new AppState(db()), name, value);

export const deviceStore = (deviceId: SavedDeviceId): DeviceStore => deviceStoreOf(db(), deviceId);
export const transportStore = (transport: string): TransportStore => transportStoreOf(db(), transport);
export const databaseLedger = (): GatewayLedger => ledgerOf(db());

/*
  The timeline. Who listens is the server's to keep across a reopened
  database (a test's), so its listeners are here, and each database's log
  tells them.
*/
let log: { db: SqlDatabase; audit: AuditLog } | null = null;
const listeners = new Set<(entry: AuditRecord) => void>();

const auditLog = (): AuditLog => {
  const current = db();
  if (log?.db !== current) {
    const audit = new AuditLog(current);
    audit.onRecord((entry) => {
      for (const listener of listeners) listener(entry);
    });
    log = { db: current, audit };
  }
  return log.audit;
};

/** Adds a line to the timeline. */
export const audit = (entry: AuditRecord): void => auditLog().record(entry);
/** Hears each line added, after it is added. Returns what stops it. */
export function onAudit(listener: (entry: AuditRecord) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
/** The timeline, newest first. */
export const recentAudit = (options?: Parameters<AuditLog['recent']>[0]) => auditLog().recent(options);
