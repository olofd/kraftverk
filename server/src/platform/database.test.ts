import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { openSchema } from './database.ts';
import { SCHEMA, schemaFingerprint, type SqlDatabase } from '@kraftverk/store';

/*
  One schema, strict version 1 (docs/ARCHITECTURE.md §9, decision 21): a new
  database gets it, one made by it is used as it is, and one made by anything
  else is set aside — never changed, never deleted. These use their own
  handles on their own files: nothing here touches the shared database.
*/

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-schema-'));
  dirs.push(dir);
  return join(dir, 'kraftverk.db');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tables = (handle: SqlDatabase) =>
  handle
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

describe('the schema', () => {
  test('a new database gets it, fingerprinted', () => {
    const path = scratch();
    const handle = openSchema(path);
    expect(tables(handle)).toContain('device');
    expect(handle.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(schemaFingerprint());
    expect(handle.setAside).toBeUndefined();
    // What it is, said by itself: the schema, when, and by which version.
    const meta = Object.fromEntries(handle.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
    expect(meta.schema_hash).toBe(String(schemaFingerprint()));
    expect(Date.parse(meta.created_at!)).not.toBeNaN();
    expect(meta.created_by_version).toMatch(/^\d+\.\d+\.\d+/);
    handle.close();
  });

  test('a database made by it is used as it is, data and all', () => {
    const path = scratch();
    const first = openSchema(path);
    first.query("INSERT INTO app_state (key, value, updated_at) VALUES ('kept', 'yes', '2026-09-29T00:00:00Z')").run();
    first.close();

    const again = openSchema(path);
    expect(again.query<{ value: string }, []>("SELECT value FROM app_state WHERE key = 'kept'").get()?.value).toBe('yes');
    expect(again.setAside).toBeUndefined();
    again.close();
  });

  test('a database made by another schema is set aside, untouched, and a new one started', () => {
    const path = scratch();
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE thing (name TEXT); INSERT INTO thing (name) VALUES ('station')");
    old.close();

    const handle = openSchema(path);
    expect(handle.setAside).toContain('.set-aside.');
    expect(tables(handle)).not.toContain('thing');
    handle.close();

    const kept = new Database(handle.setAside!, { readonly: true });
    expect(kept.query<{ name: string }, []>('SELECT name FROM thing').all()).toEqual([{ name: 'station' }]);
    kept.close();
    expect(existsSync(path)).toBe(true);
  });

  test('rewording a comment is not a new schema; changing a column is', () => {
    expect(schemaFingerprint(SCHEMA.replace('/* People who may use this server — from anywhere, the home network included. */', '/* Who may come in. */'))).toBe(schemaFingerprint());
    expect(schemaFingerprint(SCHEMA.replace('summary       TEXT NOT NULL,', 'summary       TEXT,'))).not.toBe(schemaFingerprint());
  });

  test('a sample holds a number or text, never both and never neither', () => {
    const handle = openSchema(scratch());
    handle.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES ('d-1', 'd-1', 'test.lamp', 'Lamp', '{\"attributes\":[]}', '2026-09-29T00:00:00Z')").run();
    const insert = handle.query("INSERT INTO sample (device_id, part, key, at, value, text) VALUES (?, 'main', ?, ?, ?, ?)");
    insert.run('d-1', 'soc', '2026-09-29T00:00:00Z', 80, null);
    insert.run('d-1', 'state', '2026-09-29T00:00:00Z', null, 'charging');
    expect(() => insert.run('d-1', 'both', '2026-09-29T00:00:00Z', 1, 'one')).toThrow();
    expect(() => insert.run('d-1', 'neither', '2026-09-29T00:00:00Z', null, null)).toThrow();
    handle.close();
  });
});
