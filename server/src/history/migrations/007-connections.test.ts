import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { migrate, MIGRATIONS } from '../db.ts';

/*
  Migration 7 against a database shaped like a real one before it: a P280 on
  Wi-Fi with its history, a plug from the old plugin system with a sealed key,
  the relay paired with the station — and the awkward cases: a saved simulated
  plug, a second record naming the same station, and a station never bound.
  Its own handle on its own file: nothing here touches the shared database.
*/

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function beforeSeven() {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-m7-'));
  dirs.push(dir);
  const path = join(dir, 'kraftverk.db');
  const handle = new Database(path, { create: true });
  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle, path, MIGRATIONS.filter((migration) => migration.id < 7));

  const at = '2026-09-01T10:00:00.000Z';
  const device = handle.query('INSERT INTO device (id, type, model, driver, name, config, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  device.run('power-station:16757b71', 'power-station', 'P280', 'core.station', 'Power station', JSON.stringify({ transport: 'mqtt', boundId: 'aa:bb:cc:00:11:22' }), at);
  device.run('power-station:dup', 'power-station', null, 'core.station', 'Same station again', JSON.stringify({ transport: 'ble', boundId: 'AABBCC001122' }), '2026-09-02T10:00:00.000Z');
  device.run('power-station:unbound', 'power-station', null, 'core.station', 'Never bound', '{}', '2026-09-03T10:00:00.000Z');
  device.run('smart-plug:tuya', 'smart-plug', null, 'com.tuya-local.grid-relay', 'Heater plug', '{}', '2026-09-04T10:00:00.000Z');
  device.run('smart-plug:fake', 'smart-plug', null, 'dev.kraftverk.fake-grid-relay', 'Simulated plug', '{}', '2026-09-05T10:00:00.000Z');

  const sample = handle.query('INSERT INTO sample (device_id, key, at, value) VALUES (?, ?, ?, ?)');
  for (let minute = 0; minute < 5; minute++) sample.run('power-station:16757b71', 'soc', `2026-09-27T19:4${minute}:00.000Z`, 80 + minute);
  sample.run('smart-plug:fake', 'watts', '2026-09-27T19:40:00.000Z', 240);

  handle
    .query('INSERT INTO plugin_config (plugin_id, json, enabled, updated_at) VALUES (?, ?, 1, ?)')
    .run('com.tuya-local.grid-relay', JSON.stringify({ host: '192.0.2.41', deviceId: 'bf8dc9aa', protocolVersion: '3.4', profile: 'atorch-s1', relayDp: 131, bootBehaviour: 'last', pollSeconds: 10 }), at);
  handle.query("INSERT INTO plugin_secret (plugin_id, field, value, encrypted) VALUES ('com.tuya-local.grid-relay', 'localKey', 'iv.tag.sealed', 1)").run();
  handle.query("INSERT INTO plugin_kv (plugin_id, key, value) VALUES ('com.tuya-local.grid-relay', 'protocolVersion', '\"3.4\"')").run();
  handle.query("INSERT INTO capability_grant (plugin_id, capability, granted_at) VALUES ('com.tuya-local.grid-relay', 'gridRelay.switch', ?)").run(at);
  handle.query("INSERT INTO active_provider (resource, plugin_id, chosen_at) VALUES ('gridRelay', 'com.tuya-local.grid-relay', ?)").run(at);
  const state = handle.query('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
  state.run('gridRelay.stationDeviceId', 'power-station:16757b71', at);
  state.run('gateway.lastSwitchAt.com.tuya-local.grid-relay', '1790000000000', at);
  state.run('legacy-import.decision', 'declined', at);
  return { handle, path };
}

type Row = Record<string, unknown>;
const one = <T = Record<string, unknown>>(handle: Database, sql: string, ...params: string[]): T | null => handle.query(sql).get(...params) as T | null;
const all = <T = Record<string, unknown>>(handle: Database, sql: string, ...params: string[]): T[] => handle.query(sql).all(...params) as T[];

describe('migration 7', () => {
  test('is copied first, then applied in full', () => {
    const { handle, path } = beforeSeven();
    const backup = migrate(handle, path, MIGRATIONS);
    expect(backup).toContain('before-migration-7');
    expect(all<{ id: number }>(handle, 'SELECT id FROM migration ORDER BY id').map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    handle.close();
  });

  test('the station becomes a P280, reached over Wi-Fi, known by its MAC — with every sample kept', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);

    expect(one<Row>(handle, 'SELECT id, type_id, identity, name, removed_at FROM device WHERE id = ?', 'power-station:16757b71')).toEqual({
      id: 'power-station:16757b71',
      type_id: 'aferiy.p280',
      identity: 'sydpower:AABBCC001122',
      name: 'Power station',
      removed_at: null,
    });
    expect(one<Row>(handle, 'SELECT method, transport, address, held_by, priority FROM device_connection WHERE device_id = ?', 'power-station:16757b71')).toEqual({
      method: 'wifi',
      transport: 'mqtt',
      address: 'AABBCC001122',
      held_by: null,
      priority: 0,
    });
    expect(one<{ n: number }>(handle, 'SELECT COUNT(*) n FROM sample WHERE device_id = ?', 'power-station:16757b71')?.n).toBe(5);
    handle.close();
  });

  test('a second record naming the same station keeps its history but gets no connection, and says why', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);
    expect(one<Row>(handle, 'SELECT type_id, identity FROM device WHERE id = ?', 'power-station:dup')).toEqual({ type_id: 'aferiy.p280', identity: null });
    expect(one<Row>(handle, 'SELECT 1 x FROM device_connection WHERE device_id = ?', 'power-station:dup')).toBeNull();
    expect(one<{ summary: string }>(handle, "SELECT summary FROM audit WHERE kind = 'migration.duplicate'")?.summary).toContain('Same station again');
    expect(one<Row>(handle, 'SELECT type_id, identity FROM device WHERE id = ?', 'power-station:unbound')).toEqual({ type_id: 'aferiy.p280', identity: null });
    handle.close();
  });

  test('the plugin’s plug becomes an ATORCH, with its settings, its connection, its sealed key and its store', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);

    const plug = one<{ type_id: string; identity: string; config: string }>(handle, 'SELECT type_id, identity, config FROM device WHERE id = ?', 'smart-plug:tuya')!;
    expect(plug.type_id).toBe('atorch.s1w');
    expect(plug.identity).toBe('tuya-local:bf8dc9aa');
    expect(JSON.parse(plug.config)).toEqual({ profile: 'atorch-s1', relayDp: 131, bootBehaviour: 'last', pollSeconds: 10 });

    const connection = one<{ id: string; method: string; transport: string; address: string; config: string }>(
      handle,
      'SELECT id, method, transport, address, config FROM device_connection WHERE device_id = ?',
      'smart-plug:tuya'
    )!;
    expect(connection).toMatchObject({ method: 'lan', transport: 'lan', address: '192.0.2.41' });
    expect(JSON.parse(connection.config)).toEqual({ deviceId: 'bf8dc9aa', protocolVersion: '3.4' });
    // Byte for byte, still sealed: it opens with the same KRAFTVERK_SECRET_KEY.
    expect(one<Row>(handle, 'SELECT field, value, encrypted FROM connection_secret WHERE connection_id = ?', connection.id)).toEqual({
      field: 'localKey',
      value: 'iv.tag.sealed',
      encrypted: 1,
    });
    expect(one<Row>(handle, 'SELECT value FROM device_kv WHERE device_id = ? AND key = ?', 'smart-plug:tuya', 'protocolVersion')).toEqual({ value: '"3.4"' });
    handle.close();
  });

  test('the relay pairing becomes a feeds link, and the gateway remembers the plug by its device id', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);
    expect(one<Row>(handle, 'SELECT kind, source_id, target_id FROM device_link')).toEqual({
      kind: 'feeds',
      source_id: 'smart-plug:tuya',
      target_id: 'power-station:16757b71',
    });
    expect(one<Row>(handle, "SELECT value FROM app_state WHERE key = 'gridRelay.stationDeviceId'")).toBeNull();
    expect(one<Row>(handle, "SELECT value FROM app_state WHERE key = 'gateway.lastSwitchAt.smart-plug:tuya'")).toEqual({ value: '1790000000000' });
    expect(one<Row>(handle, "SELECT value FROM app_state WHERE key = 'legacy-import.decision'")).toEqual({ value: 'declined' });
    handle.close();
  });

  test('a saved simulated plug is removed with its samples, and the timeline says so', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);
    expect(one<Row>(handle, 'SELECT 1 x FROM device WHERE id = ?', 'smart-plug:fake')).toBeNull();
    expect(one<{ n: number }>(handle, 'SELECT COUNT(*) n FROM sample WHERE device_id = ?', 'smart-plug:fake')?.n).toBe(0);
    expect(one<{ summary: string }>(handle, "SELECT summary FROM audit WHERE kind = 'device.removed'")?.summary).toContain('Simulated plug');
    handle.close();
  });

  test('the old shape is gone', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);
    const tables = all<{ name: string }>(handle, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
    for (const gone of ['plugin_config', 'plugin_secret', 'plugin_kv', 'capability_grant', 'active_provider']) expect(tables).not.toContain(gone);
    const columns = all<{ name: string }>(handle, 'PRAGMA table_info(device)').map((row) => row.name);
    expect(columns).toEqual(['id', 'name', 'config', 'added_at', 'type_id', 'identity', 'removed_at']);
    handle.close();
  });

  test('two devices may not share an identity — unless one of them has been removed', () => {
    const { handle, path } = beforeSeven();
    migrate(handle, path, MIGRATIONS);
    const add = handle.query("INSERT INTO device (id, name, config, added_at, type_id, identity, removed_at) VALUES (?, 'X', '{}', '2026-09-28T00:00:00Z', 'aferiy.p280', 'sydpower:AABBCC001122', ?)");
    expect(() => add.run('d-clash', null)).toThrow();
    handle.query("UPDATE device SET removed_at = '2026-09-28T00:00:00Z' WHERE id = 'power-station:16757b71'").run();
    expect(() => add.run('d-again', null)).not.toThrow();
    handle.close();
  });

  test('a fresh database migrates to the same shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-m7-fresh-'));
    dirs.push(dir);
    const path = join(dir, 'kraftverk.db');
    const handle = new Database(path, { create: true });
    handle.exec('PRAGMA foreign_keys = ON');
    expect(migrate(handle, path, MIGRATIONS)).toBeNull();
    const columns = all<{ name: string }>(handle, 'PRAGMA table_info(device)').map((row) => row.name);
    expect(columns).toContain('type_id');
    handle.close();
  });
});
