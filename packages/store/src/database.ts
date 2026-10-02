import { SCHEMA, schemaFingerprint } from './schema.ts';

/**
 * A SQLite database, as the stores use it: what each place that keeps a home
 * provides (docs/PLAN-SHARED-CORE.md). The server's is a file through
 * bun:sqlite; a phone's expo-sqlite; a browser's SQLite's own WebAssembly
 * build, in a worker. Synchronous, as
 * bun:sqlite and expo-sqlite are, so a store reads like a plain function.
 *
 * Positional parameters only (`?`), as every query here writes them.
 */
export interface SqlDatabase {
  query<Row = unknown, Params extends readonly unknown[] = unknown[]>(sql: string): SqlStatement<Row, Params>;
  /** Statements with no answer: the schema, a pragma. */
  exec(sql: string): void;
  /** A function run as one transaction; a transaction within it is a savepoint. */
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export interface SqlStatement<Row, Params extends readonly unknown[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): { changes: number };
}

/** What a database is, before it is used: the schema it was made with, or none. */
export type SchemaState = 'current' | 'empty' | 'other';

/** What every connection to a home's database needs, wherever it is opened: deleting a device deletes what belongs to it. */
export function prepareDatabase(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = ON');
}

/** Whether a database has this schema, none yet, or another — whose file the place it runs sets aside (strict version 1, no migrations). */
export function schemaStateOf(db: SqlDatabase, schema = SCHEMA): SchemaState {
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  const tables = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.n ?? 0;
  if (tables === 0) return 'empty';
  return version === schemaFingerprint(schema) ? 'current' : 'other';
}

/** An empty database given the schema, its fingerprint, and what made it: `madeBy` is the version of kraftverk. */
export function createSchema(db: SqlDatabase, madeBy: string, schema = SCHEMA): void {
  db.transaction(() => {
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${schemaFingerprint(schema)}`);
    const remember = db.query<unknown, [string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)');
    remember.run('schema_hash', String(schemaFingerprint(schema)));
    remember.run('created_at', new Date().toISOString());
    remember.run('created_by_version', madeBy);
  })();
}

/** What a database says it is, from its `meta` table — or nothing, for one with none. */
export function metaOf(db: SqlDatabase): Record<string, string> {
  try {
    return Object.fromEntries(db.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}

/**
 * Empties every table, keeping the schema.
 *
 * Only the store's own tables (`SCHEMA`): what a place keeps beside them in
 * the same file — a server's accounts — is the place's, and stays. Of the
 * store's, `node` and `home` are kept: erasing the house is not erasing what
 * the home is and which nodes are part of it. `meta` is kept: it is what the
 * database is, not what is in it. Everything else goes — devices, samples,
 * connections, secrets, links and the audit timeline — which is the point:
 * "back to a blank canvas".
 *
 * Deliberately not `DROP TABLE`: the schema is `schema.ts`'s business, and
 * recreating it here would be a second definition to drift.
 */
export function resetDatabase(db: SqlDatabase): { tables: string[]; rows: number } {
  const kept = new Set(['node', 'home', 'meta']);
  const own = new Set([...SCHEMA.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]!).filter((table) => !kept.has(table)));
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)
    .filter((table) => own.has(table));

  let rows = 0;
  db.transaction(() => {
    for (const table of tables) {
      rows += db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()?.n ?? 0;
      db.query(`DELETE FROM ${table}`).run();
    }
    // AUTOINCREMENT keeps its high-water mark here: clearing it means a reset database starts from one.
    db.query("DELETE FROM sqlite_sequence").run();
  })();
  // Reclaims the space rather than leaving a file describing nothing.
  db.exec('VACUUM');
  return { tables, rows };
}
