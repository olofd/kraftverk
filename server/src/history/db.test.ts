import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { migrate, type Migration } from './db.ts';

/*
  The copy before a migration is the owner's way back from a bad one, on a
  server that migrates itself unattended after a deploy. These use their own
  handles on their own files: nothing here touches the shared database.
*/

const FIRST: Migration[] = [{ id: 1, sql: 'CREATE TABLE thing (name TEXT)' }];
const SECOND: Migration[] = [...FIRST, { id: 2, sql: 'ALTER TABLE thing ADD COLUMN size INTEGER' }];

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-migrate-'));
  dirs.push(dir);
  return join(dir, 'kraftverk.db');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrating', () => {
  test('a fresh database is not copied: it has nothing to lose', () => {
    const path = scratch();
    const handle = new Database(path, { create: true });
    expect(migrate(handle, path, FIRST)).toBeNull();
    handle.close();
  });

  test('a database with data is copied, as it was, before it changes', () => {
    const path = scratch();
    const handle = new Database(path, { create: true });
    migrate(handle, path, FIRST);
    handle.query("INSERT INTO thing (name) VALUES ('station')").run();

    const backup = migrate(handle, path, SECOND);
    handle.close();

    expect(backup).not.toBeNull();
    expect(existsSync(backup!)).toBe(true);
    expect(backup!).toContain('before-migration-2');

    const copy = new Database(backup!, { readonly: true });
    // The data came along, and the schema is the old one.
    expect(copy.query<{ name: string }, []>('SELECT name FROM thing').all()).toEqual([{ name: 'station' }]);
    const columns = copy.query<{ name: string }, []>('PRAGMA table_info(thing)').all().map((c) => c.name);
    expect(columns).toEqual(['name']);
    copy.close();
  });

  test('nothing pending, nothing copied', () => {
    const path = scratch();
    const handle = new Database(path, { create: true });
    migrate(handle, path, SECOND);
    expect(migrate(handle, path, SECOND)).toBeNull();
    handle.close();
  });

  test('a migration that fails part-way leaves nothing behind', () => {
    const path = scratch();
    const handle = new Database(path, { create: true });
    migrate(handle, path, FIRST);

    const broken: Migration[] = [
      ...FIRST,
      {
        id: 2,
        sql: 'CREATE TABLE other (x TEXT)',
        run: () => {
          throw new Error('the data did not fit');
        },
      },
    ];
    expect(() => migrate(handle, path, broken)).toThrow('the data did not fit');

    const tables = handle
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'other'")
      .all();
    expect(tables).toEqual([]);
    expect(handle.query<{ id: number }, []>('SELECT id FROM migration').all()).toEqual([{ id: 1 }]);
    handle.close();
  });
});
