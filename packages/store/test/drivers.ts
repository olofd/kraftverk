import { Database } from 'bun:sqlite';
import initSqlJs from 'sql.js';

import { createSchema, fromSqlJs, prepareDatabase, type SqlDatabase } from '../src/index.ts';

/**
 * The SQLite each place keeps a home in, as the store's tests open it: the
 * server's bun:sqlite, and sql.js — a browser's. Every store test runs on
 * each, so the port is proven where the app will use it
 * (docs/PLAN-SHARED-CORE.md, phase 3). A phone's expo-sqlite is the same
 * SQLite, reached as bun:sqlite is.
 */
export const DRIVERS: readonly { name: string; open(): Promise<SqlDatabase> }[] = [
  {
    name: 'bun:sqlite',
    open: async () => fresh(new Database(':memory:') as unknown as SqlDatabase),
  },
  {
    name: 'sql.js',
    open: async () => {
      const SQL = await initSqlJs();
      return fresh(fromSqlJs(new SQL.Database()));
    },
  },
];

const fresh = (db: SqlDatabase): SqlDatabase => {
  prepareDatabase(db);
  createSchema(db, 'test');
  return db;
};
