import { Database } from 'bun:sqlite';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { createSchema, fromExpoSqlite, fromSqliteWasm, prepareDatabase, type ExpoSqliteDatabase, type SqlDatabase, type SqliteWasmDatabase } from '../src/index.ts';

/**
 * The SQLite each place keeps a home in, as the store's tests open it: the
 * server's bun:sqlite, and SQLite's own WebAssembly build — a browser's, in
 * memory here where a browser's worker keeps it on its private file system
 * (docs/PLAN-SHARED-CORE.md, "SQLite in the app"). Every store test runs on
 * each, so the port is proven where the app will use it. A phone's
 * expo-sqlite is the same SQLite again, through its own adapter: run here
 * over bun:sqlite, shaped as expo-sqlite's synchronous API answers.
 */
export const DRIVERS: readonly { name: string; open(): Promise<SqlDatabase> }[] = [
  {
    name: 'bun:sqlite',
    open: async () => fresh(new Database(':memory:') as unknown as SqlDatabase),
  },
  {
    name: 'sqlite-wasm',
    open: async () => {
      // Quiet: a refusal the tests provoke on purpose is the thrown error, not a line on the console.
      const sqlite3 = await sqlite3InitModule();
      sqlite3.config.warn = () => {};
      return fresh(fromSqliteWasm(new sqlite3.oo1.DB(':memory:') as unknown as SqliteWasmDatabase));
    },
  },
  {
    // A phone's expo-sqlite cannot run here; its API can, over the same SQLite, so the adapter's every path is run.
    name: "expo-sqlite's API",
    open: async () => fresh(fromExpoSqlite(expoShaped(new Database(':memory:')))),
  },
];

/** bun:sqlite answering as expo-sqlite's synchronous API does: a statement executed, then read. */
function expoShaped(db: Database): ExpoSqliteDatabase {
  return {
    prepareSync: (source) => {
      const statement = db.prepare(source);
      return {
        executeSync: <T>(params: (string | number | null | boolean | Uint8Array)[]) => {
          const values = params as never[];
          if (!statement.columnNames.length) return { changes: statement.run(...values).changes, getFirstSync: () => null, getAllSync: () => [], resetSync: () => {} };
          const rows = statement.all(...values) as T[];
          return { changes: 0, getFirstSync: () => rows[0] ?? null, getAllSync: () => rows, resetSync: () => {} };
        },
        finalizeSync: () => statement.finalize(),
      };
    },
    execSync: (source) => db.exec(source),
    closeSync: () => db.close(),
  };
}

const fresh = (db: SqlDatabase): SqlDatabase => {
  prepareDatabase(db);
  createSchema(db, 'test');
  return db;
};
