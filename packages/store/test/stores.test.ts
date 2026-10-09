import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MAIN_PART, RESOURCE_KINDS, nodeId, type AuditRecord, type ResourceKind } from '@kraftverk/device-sdk';

import {
  HomeSettings,
  NodeSettings,
  PlaceStore,
  AuditLog,
  ScriptStore,
  AutomationStore,
  FamilyStore,
  NodeStore,
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
import { actor } from '@kraftverk/device-sdk';

/*
  Every other store, on each SQLite a home is kept in: what the server and the
  app both keep — the timeline, decisions, policy, what a device keeps for
  itself, the gateway's memory, events, the home's nodes, and
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
      audit.record({ at: at(1), kind: 'device.added', actor: actor('person', 'olof'), resourceKind: 'device', resource: 'd-one', summary: 'Added One' });
      audit.record({ at: at(2), kind: 'automation.ran', actor: actor('automation', 'automation'), resourceKind: 'automation', resource: 'a-one', summary: 'Ran', detail: { steps: 2 } });
      stop();
      audit.record({ at: at(3), kind: 'device.renamed', actor: actor('person', 'olof'), resourceKind: 'device', resource: 'd-one', summary: 'Renamed One' });
      expect(heard.map((entry) => entry.kind)).toEqual(['device.added', 'automation.ran']);
      expect(audit.recent().map((entry) => entry.kind)).toEqual(['device.renamed', 'automation.ran', 'device.added']);
      expect(audit.recent({ resourceKind: 'device', resource: 'd-one' }).map((entry) => entry.summary)).toEqual(['Renamed One', 'Added One']);
      expect(audit.recent({ resourceKind: 'automation' })[0]?.detail).toEqual({ steps: 2 });
      expect(audit.recent({ limit: 1 })).toHaveLength(1);
    });

    test('the timeline keeps a line sent twice once, about anything it can be about, and refuses aloud what it cannot hold', () => {
      const audit = new AuditLog(database);
      for (const resourceKind of RESOURCE_KINDS) {
        const line = { at: at(4), kind: 'thing.done', actor: actor('person', 'olof'), resourceKind, resource: `${resourceKind}-1`, summary: 'Done' } as const;
        audit.record(line);
        audit.record(line);
        expect(audit.recent({ resourceKind, resource: `${resourceKind}-1` }), resourceKind).toHaveLength(1);
      }
      expect(() => audit.record({ at: at(4), kind: 'thing.done', actor: actor('person', 'olof'), resourceKind: 'nothing' as ResourceKind, resource: 'x', summary: 'Done' })).toThrow();
    });

    test('a script: kept by its key, its source as written, who last changed it; a key never another’s; gone when removed', () => {
      const scripts = new ScriptStore(database);
      const kept = scripts.add({ name: 'Feels like', source: 'export {};' }, actor('person', 'olof', 'p-1'), at(1));
      expect(kept).toMatchObject({ key: 'feels-like', name: 'Feels like', source: 'export {};', createdAt: at(1), updatedBy: { kind: 'person', id: 'p-1', name: 'olof' } });
      expect(scripts.byKey('feels-like')?.id).toBe(kept.id);
      expect(() => scripts.add({ key: 'feels-like', name: 'Again', source: '' }, actor('person', 'olof'), at(2))).toThrow();
      const changed = scripts.update(kept.id, { source: 'export const x = 1;' }, actor('agent', 'assistant for olof'), at(3))!;
      expect(changed).toMatchObject({ key: 'feels-like', source: 'export const x = 1;', createdAt: at(1), updatedAt: at(3), updatedBy: { kind: 'agent', name: 'assistant for olof' } });
      expect(scripts.keyFree('feels-like', kept.id)).toBe(true);
      expect(scripts.keyFree('feels-like')).toBe(false);
      expect(scripts.remove(kept.id)).toBe(true);
      expect(scripts.get(kept.id)).toBeNull();
      expect(scripts.update(kept.id, { name: 'Gone' }, actor('person', 'olof'), at(4))).toBeNull();
    });

    test('settings are kept until changed, by the names the schema lists; policy values only within their range, and a home’s its own', () => {
      const node = new NodeSettings(database);
      expect(() => database.query("INSERT INTO node_setting (key, value, updated_at) VALUES ('home.clock', 'x', 'now')").run()).toThrow();
      expect(node.get('family.moved')).toBeNull();
      node.set('family.moved', '2026-10-01');
      node.set('family.moved', '2026-10-02');
      expect(node.get('family.moved')).toBe('2026-10-02');
      const places = new PlaceStore(database);
      const home = places.addHome({ name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' });
      const cabin = places.addHome({ name: 'Cabin', type: 'cabin', timeZone: 'Europe/Stockholm' });
      const state = new HomeSettings(database, home.id);
      setPolicyValue(new HomeSettings(database, cabin.id), 'reserveSoc', 40);
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
      ledger.switched(plug, MAIN_PART, { at: Date.parse(at(5)), by: actor('automation', 'a-one', 'a-one') });
      ledger.switched(plug, MAIN_PART, { at: Date.parse(at(6)), by: actor('person', 'olof') });
      expect(ledger.lastSwitch(plug, MAIN_PART)).toEqual({ at: Date.parse(at(6)), by: actor('person', 'olof') });
      ledger.wrote(plug, 'indicator', { at: Date.parse(at(7)), by: actor('person', 'olof') });
      expect(ledger.lastWrite(plug, 'indicator')).toEqual({ at: Date.parse(at(7)), by: actor('person', 'olof') });
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
      const nodes = new NodeStore(database);
      const machine = { id: nodeId('n-000000000000000000000000A1'), name: 'Test machine', platform: 'system' as const, transports: ['mqtt'], alwaysOn: true, reachable: true, trusted: true };
      expect(nodes.declareSelf(machine)).toMatchObject({ self: true, accountId: null, alwaysOn: true });
      expect(nodes.declareSelf({ ...machine, transports: ['mqtt', 'lan'] }).transports).toEqual(['mqtt', 'lan']);
      expect(() => nodes.declareSelf({ ...machine, id: nodeId('n-000000000000000000000000FF') })).toThrow();

      const phone = nodes.join({ id: nodeId('n-000000000000000000000000B2'), name: 'This phone', platform: 'native', transports: ['ble'], alwaysOn: false, reachable: false, trusted: false }, 'u-one');
      expect(nodes.get(phone.id)).toMatchObject({ name: 'This phone', transports: ['ble'], self: false, accountId: 'u-one' });
      expect(() => nodes.join({ ...phone, name: 'Not mine' }, null)).toThrow();
      expect(() => nodes.join({ ...machine }, 'u-one')).toThrow();
      expect(nodes.all().map((node) => node.id)).toEqual([machine.id, phone.id]);

      // Heard from again, it says so.
      const before = nodes.get(phone.id)!.lastSeenAt;
      nodes.seen(phone.id);
      expect(nodes.get(phone.id)!.lastSeenAt >= before).toBe(true);

      nodes.remove(phone.id);
      nodes.remove(machine.id);
      expect(nodes.get(phone.id)).toBeNull();
      expect(nodes.self()?.id).toBe(machine.id);
    });

    test('the home: made once, its master a node of it — never forgotten — and kept by a follower as the master has it', () => {
      const homes = new FamilyStore(database);
      const nodes = new NodeStore(database);
      const master = nodes.self()!;
      const made = homes.ensure({ name: 'Home', masterId: master.id });
      expect(made).toMatchObject({ name: 'Home', masterId: master.id });
      expect(homes.ensure({ name: 'Another', masterId: master.id }).id).toBe(made.id);

      // As a follower keeps it: another node the master, and that one not forgotten while it is.
      const other = nodes.join({ id: nodeId('n-000000000000000000000000C3'), name: 'Second machine', platform: 'system', transports: [], alwaysOn: true, reachable: true, trusted: true }, null);
      homes.mirror({ ...made, masterId: other.id });
      nodes.remove(other.id);
      expect(nodes.get(other.id)?.id).toBe(other.id);
      homes.mirror(made);
      nodes.remove(other.id);
      expect(nodes.get(other.id)).toBeNull();
    });

    test('automations: made, changed and deleted; what their triggers saw; their runs and logs', () => {
      const store = new AutomationStore(database);
      const rule = { roles: {}, params: { fields: {} }, when: [], then: [] };
      const made = store.create({ name: 'Charge the scooter', rule, madeFrom: null, roles: {}, groups: {}, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
      expect(made.key).toBe('charge-the-scooter');
      const revision = store.revision;
      expect(store.update(made.id, { mode: 'act' })?.mode).toBe('act');
      expect(store.revision).toBeGreaterThan(revision);

      store.keepTrigger(made.id, 'low', { last: true, heldSince: at(10), fired: false });
      expect(store.trigger(made.id, 'low')).toEqual({ last: true, heldSince: at(10), fired: false });
      store.startAfresh(made.id, at(11));
      expect(store.trigger(made.id, 'low')).toBeNull();

      const run = { id: null, at: at(12), startedBy: actor('person', 'olof'), startedByRun: null, endedAt: null, outcome: 'running' as const, summary: 'Taking steps', why: 'Started by olof', saw: [], conditions: [], steps: [], answered: null };
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

    test('a reset empties the house, and keeps its nodes and what the place keeps beside it', () => {
      // A place's own table beside the home's — a server's accounts — is the place's.
      database.exec('CREATE TABLE IF NOT EXISTS beside (name TEXT)');
      database.exec("INSERT INTO beside (name) VALUES ('kept')");
      const nodes = new NodeStore(database).all().length;
      const { tables, rows } = resetDatabase(database);
      expect(tables).toContain('device');
      expect(tables).not.toContain('node');
      expect(tables).not.toContain('beside');
      expect(rows).toBeGreaterThan(0);
      expect(catalog.list()).toEqual([]);
      expect(new NodeStore(database).all()).toHaveLength(nodes);
      expect(database.query<{ n: number }, []>('SELECT COUNT(*) n FROM beside').get()?.n).toBe(1);
    });
  });
}
