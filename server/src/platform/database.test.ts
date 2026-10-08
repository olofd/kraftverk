import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { Accounts } from '../auth/accounts.ts';
import { ACCOUNTS_SCHEMA } from '../auth/schema.ts';
import { openSchema, SERVER_SCHEMA } from './database.ts';
import { SCHEMA, schemaFingerprint, type SqlDatabase } from '@kraftverk/store';

/*
  One schema, strict version 1 (docs/ARCHITECTURE.md §9, decision 21): a new
  database gets it, one made by it is used as it is, and one made by anything
  else is set aside — never changed, never deleted — its accounts carried
  into the new one, their sign-ins not. These use their own
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
    expect(handle.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(schemaFingerprint(SERVER_SCHEMA));
    expect(handle.setAside).toBeUndefined();
    // What it is, said by itself: the schema, when, and by which version.
    const meta = Object.fromEntries(handle.query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
    expect(meta.schema_hash).toBe(String(schemaFingerprint(SERVER_SCHEMA)));
    expect(Date.parse(meta.created_at!)).not.toBeNaN();
    expect(meta.created_by_version).toMatch(/^\d+\.\d+\.\d+/);
    handle.close();
  });

  test('a database made by it is used as it is, data and all', () => {
    const path = scratch();
    const first = openSchema(path);
    first.query("INSERT INTO home_setting (key, value, updated_at) VALUES ('home.kept', 'yes', '2026-09-29T00:00:00Z')").run();
    first.close();

    const again = openSchema(path);
    expect(again.query<{ value: string }, []>("SELECT value FROM home_setting WHERE key = 'home.kept'").get()?.value).toBe('yes');
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

  test('set aside twice in a moment, both are kept', () => {
    const path = scratch();
    const made = (schema: string) => openSchema(path, schema);
    const first = made(SERVER_SCHEMA + 'CREATE TABLE one (name TEXT);');
    first.close();
    const second = made(SERVER_SCHEMA + 'CREATE TABLE two (name TEXT);');
    second.close();
    const third = made(SERVER_SCHEMA);
    third.close();
    expect(second.setAside).toBeDefined();
    expect(third.setAside).toBeDefined();
    expect(second.setAside).not.toBe(third.setAside);
    for (const [aside, table] of [[second.setAside!, 'one'], [third.setAside!, 'two']] as const) {
      const kept = new Database(aside, { readonly: true });
      expect(kept.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.name).toBe(table);
      kept.close();
    }
  });

  test('a database set aside hands its accounts to the new one, and not their sign-ins', async () => {
    const path = scratch();
    const first = openSchema(path);
    const accounts = new Accounts(first);
    const owner = await accounts.createFirstUser('owner', 'a-long-test-password');
    await accounts.createUser('guest', 'another-test-password', owner.id);
    accounts.createSession(owner.id, '192.0.2.10', null);
    first.close();

    // Any change to the schema: here, a table more.
    const handle = openSchema(path, SERVER_SCHEMA + 'CREATE TABLE thing (name TEXT);');
    expect(handle.setAside).toContain('.set-aside.');
    const again = new Accounts(handle);
    expect(again.listUsers().map((user) => [user.id, user.username, user.createdBy])).toEqual([
      [again.findUserByName('guest')!.id, 'guest', owner.id],
      [owner.id, 'owner', null],
    ]);
    // The same password signs in; the old session does not.
    expect((await again.verifyLogin('owner', 'a-long-test-password'))?.id).toBe(owner.id);
    expect(handle.query<{ n: number }, []>('SELECT COUNT(*) n FROM login_session').get()?.n).toBe(0);
    handle.close();

    // The file set aside still holds them as they were.
    const kept = new Database(handle.setAside!, { readonly: true });
    expect(kept.query<{ n: number }, []>('SELECT COUNT(*) n FROM login_session').get()?.n).toBe(1);
    kept.close();
  });

  test('an account’s own table changed carries the columns both have — unless the new one requires one the old lacked', async () => {
    const path = scratch();
    const first = openSchema(path);
    await new Accounts(first).createFirstUser('owner', 'a-long-test-password');
    first.close();

    // A column more, which may be empty: carried, the column empty.
    const nullable = SERVER_SCHEMA.replace('last_login_at       TEXT\n', 'last_login_at       TEXT,\n    nickname            TEXT\n');
    expect(nullable).not.toBe(SERVER_SCHEMA);
    const second = openSchema(path, nullable);
    expect(second.query<{ username: string; nickname: string | null }, []>('SELECT username, nickname FROM users').all()).toEqual([{ username: 'owner', nickname: null }]);
    second.close();

    // A column more that is required: nothing carried, and the server starts with no accounts.
    const required = SERVER_SCHEMA.replace('last_login_at       TEXT\n', 'last_login_at       TEXT,\n    role                TEXT NOT NULL\n');
    const third = openSchema(path, required);
    expect(third.query<{ n: number }, []>('SELECT COUNT(*) n FROM users').get()?.n).toBe(0);
    third.close();
  });

  test('a database set aside with no accounts in it starts the new one with none', () => {
    const path = scratch();
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE thing (name TEXT); INSERT INTO thing (name) VALUES ('station')");
    old.close();
    const handle = openSchema(path);
    expect(new Accounts(handle).countUsers()).toBe(0);
    handle.close();
  });

  test('the server’s is the home’s with the accounts beside it, and its fingerprint covers both', () => {
    expect(SERVER_SCHEMA).toBe(SCHEMA + ACCOUNTS_SCHEMA);
    const handle = openSchema(scratch());
    expect(tables(handle)).toEqual(expect.arrayContaining(['device', 'sample', 'users', 'login_session']));
    handle.close();
    // A column of an account changed is a new schema for the server, as a column of the home's is.
    expect(schemaFingerprint(SERVER_SCHEMA.replace('last_login_at       TEXT', 'last_login_at       TEXT NOT NULL'))).not.toBe(schemaFingerprint(SERVER_SCHEMA));
    expect(schemaFingerprint(SERVER_SCHEMA)).not.toBe(schemaFingerprint(SCHEMA));
  });
});
