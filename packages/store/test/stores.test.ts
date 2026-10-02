import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MAIN_PART, nodeId, type AuditRecord } from '@kraftverk/device-sdk';

import {
  AppState,
  AuditLog,
  AutomationStore,
  HomeStore,
  NodeStore,
  PlaceStore,
  databaseLedger,
  DeviceCatalog,
  deviceStore,
  EventStore,
  policyValues,
  resetDatabase,
  schemaStateOf,
  setPolicyValue,
  type SqlDatabase,
} from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  Every other store, on each SQLite a home is kept in: what the server and the
  app both keep — the timeline, decisions, policy, what a device keeps for
  itself, the gateway's memory, events, the home's nodes and places, and
  automations with their runs. The catalog's are in catalog.test.ts.
*/

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();

for (const driver of DRIVERS) {
  describe(driver.name, () => {
    let database: SqlDatabase;
    let catalog: DeviceCatalog;

    beforeAll(async () => {
      database = await driver.open();
      catalog = new DeviceCatalog(database);
    });

    afterAll(() => database.close());

    const device = (name: string) => catalog.add({ description: { parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }], attributes: [] }, typeId: 'test.plug', name }).id;

    test('a new database has the schema, and an empty one none', async () => {
      expect(schemaStateOf(database)).toBe('current');
      const empty = await driver.open();
      empty.exec('PRAGMA user_version = 0');
      expect(schemaStateOf(empty)).toBe('other');
      empty.close();
    });

    test('the timeline: each line kept, newest first, by what it is about; whoever listens hears it', () => {
      const audit = new AuditLog(database);
      const heard: AuditRecord[] = [];
      const stop = audit.onRecord((entry) => void heard.push(entry));
      audit.record({ at: at(1), kind: 'device.added', actor: 'olof', resourceKind: 'device', resource: 'd-one', summary: 'Added One' });
      audit.record({ at: at(2), kind: 'automation.ran', actor: 'automation', resourceKind: 'automation', resource: 'a-one', summary: 'Ran', detail: { steps: 2 } });
      stop();
      audit.record({ at: at(3), kind: 'device.renamed', actor: 'olof', resourceKind: 'device', resource: 'd-one', summary: 'Renamed One' });
      expect(heard.map((entry) => entry.kind)).toEqual(['device.added', 'automation.ran']);
      expect(audit.recent().map((entry) => entry.kind)).toEqual(['device.renamed', 'automation.ran', 'device.added']);
      expect(audit.recent({ resourceKind: 'device', resource: 'd-one' }).map((entry) => entry.summary)).toEqual(['Renamed One', 'Added One']);
      expect(audit.recent({ resourceKind: 'automation' })[0]?.detail).toEqual({ steps: 2 });
      expect(audit.recent({ limit: 1 })).toHaveLength(1);
    });

    test('decisions are kept until changed; policy values only within their range', () => {
      const state = new AppState(database);
      expect(state.get('home.clock')).toBeNull();
      state.set('home.clock', 'Europe/Stockholm');
      state.set('home.clock', 'Europe/Oslo');
      expect(state.get('home.clock')).toBe('Europe/Oslo');
      expect(setPolicyValue(state, 'reserveSoc', 20)).toMatchObject({ reserveSoc: 20 });
      expect(() => setPolicyValue(state, 'reserveSoc', 500)).toThrow(RangeError);
      expect(policyValues(state)).toMatchObject({ reserveSoc: 20 });
      expect(setPolicyValue(state, 'reserveSoc', null).reserveSoc).toBeUndefined();
    });

    test('what a device keeps for itself is its own, and goes with it', () => {
      const one = device('Keeper');
      const other = device('Other');
      const store = deviceStore(database, one);
      store.set('live.until', 123);
      deviceStore(database, other).set('live.until', 456);
      expect(deviceStore(database, one).get<number>('live.until')).toBe(123);
      store.delete('live.until');
      expect(store.get('live.until')).toBeNull();
      expect(deviceStore(database, other).get<number>('live.until')).toBe(456);
    });

    test("the gateway's memory: the last switch of a part and the last write of a setting, by whom", () => {
      const ledger = databaseLedger(database);
      const plug = device('Ledgered');
      expect(ledger.lastSwitch(plug, MAIN_PART)).toBeNull();
      ledger.switched(plug, MAIN_PART, { at: Date.parse(at(5)), by: 'automation:a-one' });
      ledger.switched(plug, MAIN_PART, { at: Date.parse(at(6)), by: 'olof' });
      expect(ledger.lastSwitch(plug, MAIN_PART)).toEqual({ at: Date.parse(at(6)), by: 'olof' });
      ledger.wrote(plug, 'indicator', { at: Date.parse(at(7)), by: 'olof' });
      expect(ledger.lastWrite(plug, 'indicator')).toEqual({ at: Date.parse(at(7)), by: 'olof' });
    });

    test("a device's events, newest first; warnings and errors across devices, with whose", () => {
      const events = new EventStore(database);
      const plug = device('Eventful');
      events.record(plug, { id: 'tripped', level: 'error', part: null, data: { reason: 'overload' }, at: at(8) });
      events.record(plug, { id: 'note', level: 'info', part: MAIN_PART, data: null, at: at(9) });
      expect(events.recent(plug).map((event) => event.event)).toEqual(['note', 'tripped']);
      expect(events.problems().map((event) => [event.event, event.deviceName])).toEqual([['tripped', 'Eventful']]);
    });

    test('the nodes: this database\'s own, once and for good; others joined for a person, and forgotten', () => {
      database.query('INSERT INTO users (id, username, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)').run('u-one', 'owner', 'x', at(0), at(0));
      const nodes = new NodeStore(database);
      const machine = { id: nodeId('n-0000000000a1'), name: 'Test machine', platform: 'system' as const, transports: ['mqtt'], alwaysOn: true, reachable: true, trusted: true };
      expect(nodes.declareSelf(machine)).toMatchObject({ self: true, accountId: null, alwaysOn: true });
      expect(nodes.declareSelf({ ...machine, transports: ['mqtt', 'lan'] }).transports).toEqual(['mqtt', 'lan']);
      expect(() => nodes.declareSelf({ ...machine, id: nodeId('n-0000000000ff') })).toThrow();

      const phone = nodes.join({ id: nodeId('n-0000000000b2'), name: 'This phone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false }, 'u-one');
      expect(nodes.get(phone.id)).toMatchObject({ name: 'This phone', transports: ['ble'], self: false, accountId: 'u-one' });
      expect(nodes.forAccount('u-one').map((node) => node.id)).toEqual([phone.id]);
      expect(() => nodes.join({ ...phone, name: 'Not mine' }, null)).toThrow();
      expect(() => nodes.join({ ...machine }, 'u-one')).toThrow();
      expect(nodes.all().map((node) => node.id)).toEqual([machine.id, phone.id]);

      nodes.remove(phone.id);
      nodes.remove(machine.id);
      expect(nodes.get(phone.id)).toBeNull();
      expect(nodes.self()?.id).toBe(machine.id);
    });

    test('the home: made once, its master a node of it, renamed and handed over', () => {
      const homes = new HomeStore(database);
      const nodes = new NodeStore(database);
      const master = nodes.self()!;
      const made = homes.ensure({ name: 'Home', masterId: master.id });
      expect(made).toMatchObject({ name: 'Home', masterId: master.id });
      expect(homes.ensure({ name: 'Another', masterId: master.id }).id).toBe(made.id);
      expect(homes.rename('Stugan').name).toBe('Stugan');

      const other = nodes.join({ id: nodeId('n-0000000000c3'), name: 'Second machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true }, null);
      expect(homes.setMaster(other.id).masterId).toBe(other.id);
      homes.setMaster(master.id);
    });

    test('places: where nodes and devices stand, each by a key made from its name', () => {
      const places = new PlaceStore(database);
      const cabin = places.add({ name: 'The cabin', latitude: 59.3, longitude: 18.1, timeZone: 'Europe/Stockholm' });
      expect(cabin).toMatchObject({ key: 'the-cabin', name: 'The cabin', timeZone: 'Europe/Stockholm' });
      expect(places.add({ name: 'The cabin', latitude: 0, longitude: 0, timeZone: 'UTC' }).key).toBe('the-cabin-2');
      expect(places.byKey('the-cabin')?.id).toBe(cabin.id);
      expect(places.update(cabin.id, { name: 'Cabin' })?.name).toBe('Cabin');

      const catalog = new DeviceCatalog(database);
      const placed = catalog.add({ description: { parts: [], attributes: [] }, typeId: 'test.lamp', name: 'Placed', placeId: cabin.id });
      expect(catalog.get(placed.id)?.placeId).toBe(cabin.id);
      // A place removed: what stood at it stands nowhere said.
      places.remove(cabin.id);
      expect(places.get(cabin.id)).toBeNull();
      expect(catalog.get(placed.id)?.placeId).toBeNull();
    });

    test('automations: made, changed and deleted; what their triggers saw; their runs and logs', () => {
      const store = new AutomationStore(database);
      const rule = { roles: {}, params: { fields: {} }, when: [], then: [] };
      const made = store.create({ name: 'Charge the scooter', rule, madeFrom: null, roles: {}, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
      expect(made.key).toBe('charge-the-scooter');
      const revision = store.revision;
      expect(store.update(made.id, { mode: 'armed' })?.mode).toBe('armed');
      expect(store.revision).toBeGreaterThan(revision);

      store.keepTrigger(made.id, 0, { last: true, heldSince: at(10), fired: false });
      expect(store.trigger(made.id, 0)).toEqual({ last: true, heldSince: at(10), fired: false });
      store.startAfresh(made.id, at(11));
      expect(store.trigger(made.id, 0)).toBeNull();

      const run = { id: null, at: at(12), startedBy: 'olof', startedByRun: null, endedAt: null, outcome: 'running' as const, summary: 'Taking steps', why: 'Started by olof', saw: [], conditions: [], steps: [] };
      const runId = store.beginRun(made.id, run);
      expect(store.unended().map((unended) => unended.automationId)).toEqual([made.id]);
      store.recordLog(runId, { keys: [], readings: [] });
      store.endRun(runId, { ...run, id: runId, endedAt: at(13), outcome: 'acted', summary: 'Turned it on' });
      expect(store.unended()).toEqual([]);
      expect(store.runs(made.id)[0]).toMatchObject({ id: runId, outcome: 'acted', summary: 'Turned it on' });
      expect(store.runLog(made.id, runId)).not.toBeNull();
      expect(store.ran(made.id, { ...run, endedAt: at(14), outcome: 'idle', summary: 'Nothing to do' })).not.toBeNull();

      expect(store.delete(made.id)).toBe(true);
      expect(store.get(made.id)).toBeNull();
      // Its runs went with it: one over as it began is not kept for an automation that is gone.
      expect(store.ran(made.id, { ...run, endedAt: at(15), outcome: 'idle', summary: 'Nothing to do' })).toBeNull();
    });

    test('a reset empties the house and keeps who may enter it', () => {
      const { tables, rows } = resetDatabase(database);
      expect(tables).toContain('device');
      expect(tables).not.toContain('users');
      expect(rows).toBeGreaterThan(0);
      expect(catalog.list()).toEqual([]);
      expect(database.query<{ n: number }, []>('SELECT COUNT(*) n FROM users').get()?.n).toBe(1);
    });
  });
}
