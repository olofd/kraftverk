import { Database } from 'bun:sqlite';

import { createSchema, prepareDatabase, type SqlDatabase } from '@kraftverk/store';

/**
 * A home's database for a test: SQLite in memory, with the schema, and gone
 * when the test is. Nothing here can reach a file — let alone the owner's —
 * which is the trap the server's tests once fell into (docs/HANDOFF.md).
 */
export function testDatabase(): SqlDatabase {
  const db = new Database(':memory:') as unknown as SqlDatabase;
  prepareDatabase(db);
  createSchema(db, 'test');
  return db;
}
