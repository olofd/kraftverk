import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Database, type Statement } from 'bun:sqlite';

import { createSchema, metaOf, prepareDatabase, SCHEMA, schemaStateOf, type SqlDatabase, type SqlStatement } from '@kraftverk/store';

import { ACCOUNTS_CARRIED, NODE_SCHEMA } from '../auth/schema.ts';
import { DEFAULT_DATABASE_FILE, SERVER } from '../config.ts';
import { asideName } from './aside.ts';

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
 * so in the log. Nothing is deleted. The tables named in `carried` are
 * carried into the new one (`carry`): the node's accounts, so a new schema of
 * its own is not a server waiting to be claimed again. The family's carries
 * nothing: it is restored from the configuration kept beside it
 * (`snapshot.ts`). Exported for tests.
 */
export function openSchema(path: string, schema = SCHEMA, carried: readonly string[] = []): SqlDatabase & { setAside?: string; created?: boolean } {
  let handle = open(path);
  const state = schemaStateOf(handle, schema);
  if (state === 'current') return handle;

  let setAside: string | undefined;
  let kept: Carried[] = [];
  if (state === 'other') {
    if (path === ':memory:') throw new Error('An in-memory database with another schema: nothing to set aside');
    const old = metaOf(handle);
    // Read before it is set aside: the file set aside is never opened again, so it stays as it was.
    kept = carried.map((table) => readTable(handle, table)).filter((rows) => rows !== null);
    handle.close();
    // A name no file has: two set aside within one moment are both kept.
    setAside = asideName(`${path}.set-aside.`, '', ['-wal', '-shm']);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) renameSync(path + suffix, setAside + suffix);
    const madeBy = old.created_by_version ? `, made by kraftverk ${old.created_by_version} on ${old.created_at?.slice(0, 10)} with schema ${old.schema_hash},` : '';
    console.warn(`[db] ${path} was made by another schema${madeBy} and is set aside as ${setAside}; a new database is started. Nothing was deleted.`);
    handle = open(path);
  }
  createSchema(handle, SERVER.version, schema);
  for (const rows of kept) carry(handle, rows);
  return Object.assign(handle, { created: true }, setAside ? { setAside } : {});
}

/** A table's rows, as a database being set aside held them. */
type Carried = { table: string; columns: string[]; rows: Record<string, unknown>[] };

type Column = { name: string; notnull: number; dflt_value: string | null; pk: number };

const columnsOf = (handle: SqlDatabase, table: string) => handle.query<Column, []>(`PRAGMA table_info("${table}")`).all();

/** A table's rows from a database about to be set aside — or null, when it has no such table or it cannot be read. */
function readTable(handle: SqlDatabase, table: string): Carried | null {
  try {
    const columns = columnsOf(handle, table).map((column) => column.name);
    if (!columns.length) return null;
    return { table, columns, rows: handle.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all() };
  } catch (error) {
    console.warn(`[db] ${table} could not be read from the database being set aside, and is not carried: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Puts a table's rows from the database set aside into the new one: the
 * columns both have, as long as every column the new one requires is among
 * them. One it requires that the old one lacked, and nothing is carried
 * rather than something made up. All the rows or none; either way the log
 * says so, and the server starts.
 */
function carry(handle: SqlDatabase, { table, columns, rows }: Carried): void {
  if (!rows.length) return;
  const now = columnsOf(handle, table);
  if (!now.length) return;
  const missing = now.filter((column) => (column.notnull || column.pk) && column.dflt_value === null && !columns.includes(column.name)).map((column) => column.name);
  if (missing.length) {
    console.warn(`[db] ${table} is not carried from the database set aside: the new schema requires ${missing.join(', ')}, which it did not have`);
    return;
  }
  const shared = now.map((column) => column.name).filter((name) => columns.includes(name));
  const insert = handle.query<unknown, unknown[]>(`INSERT INTO "${table}" (${shared.map((name) => `"${name}"`).join(', ')}) VALUES (${shared.map(() => '?').join(', ')})`);
  try {
    handle.transaction(() => {
      for (const row of rows) insert.run(...shared.map((name) => row[name]));
    })();
    console.log(`[db] ${rows.length} rows of ${table} carried from the database set aside`);
  } catch (error) {
    console.warn(`[db] ${table} is not carried from the database set aside: ${(error as Error).message}`);
  }
}

/** The database the server opened, and whether this run started it: new, or new after one of another schema was set aside. */
export type Opened = { database: SqlDatabase; fresh: boolean; setAside: string | null };

/**
 * Opens the family's database — its folder made if need be — with the
 * store's schema (`openSchema`), once, at the start.
 *
 * A test may never open the real one. This is not a style rule: when tests
 * shared one handle and one environment, a file that cleared its database's
 * path had the next one truncate the owner's catalog and every sample it had
 * recorded — and the tests passed. Refusing the default path under a test
 * runner turns that silent loss into a failure on the line that causes it.
 */
export function openDatabase(path: string): Opened {
  return opened(path, SCHEMA, []);
}

/**
 * Opens the node's own database (`node.db` beside the family's,
 * docs/PLAN-WORLD-MODEL.md §7): its sign-ins, set aside — its accounts
 * carried — only when its own schema changes.
 */
export function openNodeDatabase(path: string): Opened {
  return opened(path, NODE_SCHEMA, ACCOUNTS_CARRIED);
}

function opened(path: string, schema: string, carried: readonly string[]): Opened {
  if (process.env.NODE_ENV === 'test' && dirname(resolve(path)) === dirname(DEFAULT_DATABASE_FILE)) throw new Error('A test tried to open a real database: open one of its own, a temp file or :memory:');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = openSchema(path, schema, carried);
  return { database, fresh: Boolean(database.created), setAside: database.setAside ?? null };
}
