import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Database, type Statement } from 'bun:sqlite';

import { createSchema, metaOf, prepareDatabase, SCHEMA, schemaStateOf, type SqlDatabase, type SqlStatement } from '@kraftverk/store';

import { ACCOUNTS_SCHEMA } from '../auth/schema.ts';

/** The server's database is the home's, and its own accounts beside it: one definition, one fingerprint. */
export const SERVER_SCHEMA = SCHEMA + ACCOUNTS_SCHEMA;

/**
 * The server's database: one SQLite file for everything that has to outlive a
 * restart — devices, their connections and sealed secrets, history, links,
 * automations and the timeline. The schema and every store are
 * `@kraftverk/store`'s, shared with the app; what is the server's is here: the
 * file, opening it through bun:sqlite (built into the runtime), and setting
 * an old one aside. Nothing here is kept between calls: the process opens it
 * once (`index.ts`) and hands the handle on; a test opens its own.
 *
 * The file lives in `server/data/`, which is gitignored.
 */

/** Where the database is kept unless `KRAFTVERK_DB` says (`config.ts`): beside the server, gitignored. */
export const DEFAULT_DATABASE_FILE = resolve(import.meta.dirname, '../../data/kraftverk.db');

/** The version of kraftverk this is, as its package says: what a new database records it was made by. */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/*
  bun:sqlite's Database is nearly the port — get, all and run, exec,
  transaction, close — but its own statement cache keeps twenty: one prepared
  past those is never finalized, and its close leaves the file open (on
  Windows, a file that cannot be removed). So each statement is prepared once
  and kept here, and all are let go on close, as the phone's and the
  browser's adapters do.
*/
function open(path: string): SqlDatabase {
  const handle = new Database(path, { create: true });
  handle.exec('PRAGMA journal_mode = WAL');
  // The recovery CLI may write while the server does: wait for the lock rather than failing at once with SQLITE_BUSY.
  handle.exec('PRAGMA busy_timeout = 5000');
  const prepared = new Map<string, Statement>();
  const db: SqlDatabase = {
    query: <Row, Params extends readonly unknown[]>(sql: string) => {
      let statement = prepared.get(sql);
      if (!statement) prepared.set(sql, (statement = handle.prepare(sql)));
      return statement as unknown as SqlStatement<Row, Params>;
    },
    exec: (sql) => handle.exec(sql),
    transaction: (fn) => handle.transaction(fn),
    close: () => {
      for (const statement of prepared.values()) statement.finalize();
      prepared.clear();
      handle.close();
    },
  };
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
export function openSchema(path: string, schema = SERVER_SCHEMA): SqlDatabase & { setAside?: string; created?: boolean } {
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

/** The database the server opened, and whether this run started it: new, or new after one of another schema was set aside. */
export type Opened = { database: SqlDatabase; fresh: boolean; setAside: string | null };

/**
 * Opens the server's database — its folder made if need be — with this
 * schema (`openSchema`), once, at the start.
 *
 * A test may never open the real one. This is not a style rule: when tests
 * shared one handle and one environment, a file that cleared its database's
 * path had the next one truncate the owner's catalog and every sample it had
 * recorded — and the tests passed. Refusing the default path under a test
 * runner turns that silent loss into a failure on the line that causes it.
 */
export function openDatabase(path: string): Opened {
  if (process.env.NODE_ENV === 'test' && resolve(path) === DEFAULT_DATABASE_FILE) throw new Error('A test tried to open the real database: open one of its own, a temp file or :memory:');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = openSchema(path);
  return { database, fresh: Boolean(database.created), setAside: database.setAside ?? null };
}
