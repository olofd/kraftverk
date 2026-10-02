import { Database } from 'bun:sqlite';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { createSchema, fromSqliteWasm, prepareDatabase, type SqlDatabase, type SqliteWasmDatabase } from '../src/index.ts';

/**
 * The SQLite each place keeps a home in, as the store's tests open it: the
 * server's bun:sqlite, and SQLite's own WebAssembly build — a browser's, in
 * memory here where a browser's worker keeps it on its private file system
 * (docs/PLAN-SHARED-CORE.md, "SQLite in the app"). Every store test runs on
 * each, so the port is proven where the app will use it. A phone's
 * expo-sqlite is the same SQLite again, through its own adapter.
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
];

const fresh = (db: SqlDatabase): SqlDatabase => {
  prepareDatabase(db);
  createSchema(db, 'test');
  return db;
};
