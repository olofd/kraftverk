import { beforeEach, describe, expect, test } from 'bun:test';

import { writeConfig } from '@kraftverk/home-file';
import { createPerson, newSecret, softwareKey } from '@kraftverk/identity';
import { defineDeviceType, MAIN_PART } from '@kraftverk/device-sdk';
import type { Rule } from '@kraftverk/automation';

import { ApiError } from '@kraftverk/api-contract';
import { AutomationLibrary } from '@kraftverk/automation-engine';
import type { AuditRecord } from '@kraftverk/device-sdk';
import { FamilyStore, LabelStore, MediaStore, PeopleStore, ShortcutStore, DevicePeopleStore, ModeStore, PlaceStore, SpaceStore, AutomationStore, ConnectionStore, DeviceCatalog, EventStore, HistoryStore, LinkStore, NodeStore, plainSecrets, type SqlDatabase } from '@kraftverk/store';
import { policyOf } from '../src/homes/homes.ts';

import { drafts } from '../src/automations/drafts.ts';
import { exportConfig } from '../src/configuration/export.ts';
import { PendingPlans, planImport, startWritten, writeImport, type ImportChoices, type ImportDeps } from '../src/configuration/import.ts';
import { restoreFrom } from '../src/configuration/restore.ts';
import type { PassphraseSealing } from '../src/configuration/seal.ts';
import { ProtocolRegistry } from '../src/installed/protocols.ts';
import { DeviceTypeRegistry } from '../src/installed/types.ts';
import { LAMP, lampProtocol, lampType, MACHINE_NODE, TEST_INTEGRATION, TEST_SOURCE } from '../src/testing.ts';
import { testDatabase } from './home.ts';
import { actor, type Actor } from '@kraftverk/device-sdk';

/*
  A configuration imported: planned — nothing written — then applied, in one
  transaction. A server's own export, imported into a database wiped, is the
  server again: its devices by their keys, how each is reached, their
  secrets, its automations bound and acting as they were. What a file
  cannot do is said at its line; what it needs is asked; what it would set
  acting is confirmed; and a snapshot kept beside the database restores a
  home by itself.
*/

let db: SqlDatabase;
let deps: ImportDeps & { record: (entry: AuditRecord) => void };
/** Where the home is, as these tests keep it. */

/** A plan applied as an apply does: written, then set going. */
async function applyImport(on: ImportDeps, id: string, by: Actor, choices: ImportChoices) {
  const written = writeImport(on, id, by, choices);
  await startWritten(on, written);
  return written.applied;
}
const sessionsSynced: number[] = [];
const PASSPHRASE = 'a passphrase of some length';

/** Sealing as a test needs it: opened by its passphrase and by nothing else. The cipher is the place's, and tested there. */
const testSealing: PassphraseSealing = {
  seal: async (passphrase, value) => `sealed:v0:${btoa(JSON.stringify([passphrase, value]))}`,
  open: async (passphrase, sealed) => {
    const [sealedWith, value] = JSON.parse(atob(sealed.slice('sealed:v0:'.length))) as [string, string];
    if (sealedWith !== passphrase) throw new Error('The passphrase does not open it');
    return value;
  },
};

beforeEach(() => {
  db = testDatabase();
  const types = new DeviceTypeRegistry();
  types.installIntegration(TEST_INTEGRATION);
  types.install(lampType, TEST_SOURCE);
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol, 'test');
  const catalog = new DeviceCatalog(db);
  const automations = new AutomationStore(db);
  const library = new AutomationLibrary([], () => {});
  const engine = { reset: () => {}, poke: () => {}, forget: () => {} };
  const sessions = { sync: async (records: readonly unknown[]) => void sessionsSynced.push(records.length), description: (record: { description: unknown }) => record.description };
  const { checked } = drafts({ history: new HistoryStore(db), events: new EventStore(db), catalog, sessions: sessions as never, library, engine: engine as never, automations });
  const places = new PlaceStore(db);
  places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/Stockholm' });
  // This node, the home's own: what holds the ways a file says.
  new NodeStore(db).declareSelf({ ...MACHINE_NODE, platform: 'system', transports: ['bus'] });
  deps = {
    db,
    catalog,
    connections: new ConnectionStore(db, plainSecrets),
    links: new LinkStore(db),
    self: MACHINE_NODE.id,
    automations,
    types,
    protocols,
    library,
    engine,
    sessions,
    transports: { definition: () => null },
    checked,
    pending: new PendingPlans(),
    family: new FamilyStore(db),
    places,
    spaces: new SpaceStore(db),
    labels: new LabelStore(db),
    people: new PeopleStore(db),
    shortcuts: new ShortcutStore(db),
    devicePeople: new DevicePeopleStore(db),
    modes: new ModeStore(db),
    media: new MediaStore(db),
    policyOf: policyOf(db),
    sealing: testSealing,
    kept: plainSecrets,
    record: () => {},
  };
});

const lampRule: Rule = {
  roles: { lamp: { label: 'Lamp', capabilities: ['switch'] } },
  params: { fields: {} },
  when: [{ at: { value: '07:00' } }],
  then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
};

/** A home: two lamps — one with its PIN — and an automation that acts. */
function aHome() {
  const hall = deps.catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', identity: 'test-lamp:HALL', config: { room: 'Hall' }, description: LAMP });
  const way = deps.connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-hall' });
  deps.connections.setSecrets(way.id, { pin: 'pin-of-a-test' });
  const porch = deps.catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
  deps.connections.add({ deviceId: porch.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-porch' });
  const morning = deps.automations.create({ name: 'Morning', rule: lampRule, madeFrom: null, roles: { lamp: { device: hall.id, part: 'main' } }, groups: {}, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
  deps.automations.update(morning.id, { mode: 'act' });
  return { hall, porch, morning };
}

const exported = async (secrets: 'sealed' | 'kept' | 'none' = 'sealed') => {
  const out = await exportConfig(deps, { secrets, passphrase: PASSPHRASE });
  return writeConfig(out.document);
};

describe('a server’s own export, into a database wiped', () => {
  test('is the server again: devices by key, how each is reached, its secret, the automation bound, acting, on the home page', async () => {
    aHome();
    const text = await exported();
    db.exec('DELETE FROM automation; DELETE FROM device;');

    const plan = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    expect(plan.devices.map((item) => [item.key, item.action])).toEqual([
      ['hall-lamp', 'add'],
      ['porch-lamp', 'add'],
    ]);
    expect(plan.automations).toEqual([{ key: 'morning', name: 'Morning', action: 'add', changes: [] }]);
    expect(plan.needs).toEqual({ passphrase: null, secrets: [], rebind: [], confirm: ['"Morning" will act on its own'] });

    const applied = await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(applied.devices.added).toEqual(['hall-lamp', 'porch-lamp']);
    const hall = deps.catalog.byKey('hall-lamp')!;
    expect(hall).toMatchObject({ name: 'Hall lamp', identity: 'test-lamp:HALL', config: { room: 'Hall' } });
    const way = deps.connections.forDevice(hall.id)[0]!;
    expect(way).toMatchObject({ method: 'bus', address: 'lamp-hall' });
    expect(deps.connections.secret(way.id, 'pin')).toBe('pin-of-a-test');
    const morning = deps.automations.byKey('morning')!;
    expect(morning).toMatchObject({ mode: 'act', rule: lampRule, roles: { lamp: { device: hall.id, part: 'main' } } });
    expect(sessionsSynced.at(-1)).toBe(2);

    // Read again over what it made: nothing to do.
    const again = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect([...again.devices, ...again.automations].map((item) => item.action)).toEqual(['same', 'same', 'same']);
    expect(again.needs.confirm).toEqual([]);
  });

  test('its homes’ spaces and openings, and where each device stands, by key', async () => {
    const { hall, porch } = aHome();
    const home = deps.places.homeByKey('home')!;
    const site = deps.spaces.site(home.id);
    const house = deps.spaces.addSpace({ parentId: site.id, key: 'house', kind: 'building', name: 'House' });
    const ground = deps.spaces.addSpace({ parentId: house.id, key: 'ground', kind: 'floor', name: 'Ground floor', level: 0, elevation: 0 });
    const kitchen = deps.spaces.addSpace({ parentId: ground.id, key: 'kitchen', kind: 'room', name: 'Kitchen', purpose: 'kitchen', height: 2.4 });
    const hallway = deps.spaces.addSpace({ parentId: ground.id, key: 'hall', kind: 'room', name: 'Hall', purpose: 'hallway' });
    const door = deps.spaces.addOpening({ key: 'front-door', fromId: hallway.id, toId: null, kind: 'door', name: 'Front door' });
    deps.spaces.addOpening({ key: 'kitchen-door', fromId: hallway.id, toId: kitchen.id, kind: 'opening' });
    deps.spaces.place(hall.id, { spaceId: kitchen.id }, actor('person', 'olof'));
    deps.spaces.place(porch.id, { spaceId: hallway.id, openingId: door.id, role: 'based' }, actor('person', 'olof'));
    const text = await exported();
    expect(text).toContain('kitchen-door:');
    expect(text).toContain('based:');

    db.exec("DELETE FROM placement; DELETE FROM opening; DELETE FROM space WHERE kind != 'site'; DELETE FROM automation; DELETE FROM device;");
    const plan = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    expect(plan.homes).toEqual([
      { key: 'home', name: 'Home', action: 'change', changes: ['spaces added: House, Ground floor, Kitchen, Hall', 'openings added: Front door, kitchen-door'] },
    ]);
    await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(deps.spaces.spaces(home.id).map((space) => [space.key, space.kind, space.parentId && deps.spaces.space(space.parentId)!.key])).toEqual([
      ['site', 'site', null],
      ['house', 'building', 'site'],
      ['ground', 'floor', 'house'],
      ['kitchen', 'room', 'ground'],
      ['hall', 'room', 'ground'],
    ]);
    expect(deps.spaces.spaceByKey(home.id, 'kitchen')).toMatchObject({ purpose: 'kitchen', height: 2.4 });
    expect(deps.spaces.openingByKey(home.id, 'front-door')).toMatchObject({ kind: 'door', toId: null, name: 'Front door' });
    const lamp = deps.catalog.byKey('hall-lamp')!;
    expect(deps.spaces.placement(lamp.id)).toMatchObject({ spaceId: deps.spaces.spaceByKey(home.id, 'kitchen')!.id, role: 'stands', openingId: null });
    expect(deps.spaces.placement(deps.catalog.byKey('porch-lamp')!.id)).toMatchObject({ role: 'based', openingId: deps.spaces.openingByKey(home.id, 'front-door')!.id });

    // Read again over what it made: nothing to do.
    const again = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect([...again.homes, ...again.devices].map((item) => item.action)).toEqual(['same', 'same', 'same']);

    // Moved in the file: a change, said.
    const moved = await planImport(deps, text.replace('space: kitchen', 'space: hall'), { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(moved.devices[0]).toMatchObject({ key: 'hall-lamp', action: 'change', changes: ['where it stands: hall, home'] });
    // Nowhere: a problem at its line.
    const nowhere = await planImport(deps, text.replace('space: kitchen', 'space: cellar'), { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(nowhere.problems.map((problem) => [problem.message, problem.path])).toEqual([['Home has no space "cellar"', ['devices', 'hall-lamp', 'place']]]);
  });

  test('its people, by their ids: each chain checked again, their role, nickname, colour and own shortcuts back', async () => {
    const { morning } = aHome();
    const key = softwareKey(newSecret());
    const id = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB';
    const chain = await createPerson({ id, key, deviceName: 'Phone', profile: { name: 'Anna Example', shortName: null, locale: null, pictureId: null }, at: '2026-10-08T12:00:00.000Z' });
    deps.people.present(chain);
    deps.people.addMember(id, { role: 'admin', invitedBy: null, at: '2026-10-08T12:00:00.000Z' });
    deps.people.updateMember(id, { nickname: 'Mum', color: '#10b981' });
    deps.shortcuts.set(id, [morning.id]);
    const text = await exported();
    expect(text).toContain('anna-example:');
    expect(text).toContain('shortcuts:\n      - morning\n');

    db.exec('DELETE FROM shortcut; DELETE FROM member; DELETE FROM person_identity; DELETE FROM person_key; DELETE FROM person;');
    const plan = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    expect(plan.people).toEqual([{ key: 'anna-example', name: 'Anna Example', action: 'add', changes: [] }]);
    const applied = await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(applied.people.added).toEqual(['anna-example']);
    expect(deps.people.get(id)).toMatchObject({ name: 'Anna Example', shownAs: 'Mum', member: { role: 'admin', color: '#10b981' } });
    expect(deps.people.chainOf(id)).toEqual(chain);
    expect(deps.shortcuts.of(id)).toEqual([morning.id]);
    expect((await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') })).people[0]!.action).toBe('same');

    // A chain changed by hand is no one: a problem, at its line.
    const tampered = text.replace(/chain: (\S+)/, (_, value: string) => `chain: ${value.slice(0, -4)}AAAA`);
    expect((await planImport(deps, tampered, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') })).problems.map((problem) => problem.message)).toEqual(['Anna Example is not who the file says: their chain does not check']);
  });

  test('its labels, by key, and what each is on: a device, a room, an automation', async () => {
    const { hall, morning } = aHome();
    const home = deps.places.homeByKey('home')!;
    const kitchen = deps.spaces.addSpace({ parentId: deps.spaces.site(home.id).id, key: 'kitchen', kind: 'room', name: 'Kitchen' });
    const heating = deps.labels.add({ name: 'Heating', color: '#ff8800' });
    const night = deps.labels.add({ name: 'Night' });
    deps.labels.set({ device: hall.id }, [heating.id, night.id]);
    deps.labels.set({ space: kitchen.id }, [night.id]);
    deps.labels.set({ automation: morning.id }, [heating.id]);
    const text = await exported();
    expect(text).toContain('color: "#ff8800"');

    db.exec("DELETE FROM labelled; DELETE FROM label; DELETE FROM space WHERE kind != 'site'; DELETE FROM automation; DELETE FROM device;");
    const plan = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    expect(plan.labels.map((item) => [item.key, item.action])).toEqual([
      ['heating', 'add'],
      ['night', 'add'],
    ]);
    const applied = await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(applied.labels.added).toEqual(['heating', 'night']);
    const keysOn = (target: Parameters<typeof deps.labels.on>[0]) => deps.labels.on(target).map((label) => label.key);
    expect(keysOn({ device: deps.catalog.byKey('hall-lamp')!.id })).toEqual(['heating', 'night']);
    expect(keysOn({ space: deps.spaces.spaceByKey(home.id, 'kitchen')!.id })).toEqual(['night']);
    expect(keysOn({ automation: deps.automations.byKey('morning')!.id })).toEqual(['heating']);
    expect(deps.labels.byKey('heating')).toMatchObject({ name: 'Heating', color: '#ff8800' });

    // Read again: the same. A label nowhere is a problem at its line.
    const again = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect([...again.labels, ...again.homes, ...again.devices, ...again.automations].every((item) => item.action === 'same')).toBe(true);
    const unknown = await planImport(deps, text.replace('- night', '- garden'), { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    expect(unknown.problems.map((problem) => problem.message)).toContain('There is no label "garden", in the file or here');
  });

  test('a plan is used once, and only by whoever read it', async () => {
    aHome();
    const plan = await planImport(deps, await exported(), { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    await expect(applyImport(deps, plan.id!, actor('person', 'someone else'), {})).rejects.toThrow('That plan has gone');
    await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    await expect(applyImport(deps, plan.id!, actor('person', 'olof'), {})).rejects.toThrow('That plan has gone');
  });

  test('what the database will not keep is the file’s, refused; a fault in the code is not said as one — and either way nothing is written', async () => {
    aHome();
    const text = await exported();
    db.exec('DELETE FROM automation; DELETE FROM device;');
    const add = deps.catalog.add.bind(deps.catalog);

    deps.catalog.add = () => {
      throw new Error('UNIQUE constraint failed: device.key');
    };
    const refused = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    const error = await applyImport(deps, refused.id!, actor('person', 'olof'), {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('invalid');

    deps.catalog.add = () => {
      throw new TypeError('a fault in the code');
    };
    const faulty = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: actor('person', 'olof') });
    const fault = await applyImport(deps, faulty.id!, actor('person', 'olof'), {}).catch((caught: unknown) => caught);
    expect(fault).toBeInstanceOf(TypeError);

    deps.catalog.add = add;
    expect(deps.catalog.list()).toEqual([]);
  });
});

describe('what a file cannot do, and what it needs', () => {
  test('its sealed secrets need the passphrase — the right one', async () => {
    aHome();
    const text = await exported();
    expect((await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') })).needs.passphrase).toBe('missing');
    expect((await planImport(deps, text, { mode: 'merge', passphrase: 'not the passphrase at all', by: actor('person', 'olof') })).needs.passphrase).toBe('wrong');
  });

  test('a key naming a device of another type is a problem, at its line', async () => {
    aHome();
    const text = `kraftverk: 4
devices:
  hall-lamp:
    type: test.lamp
    name: Hall lamp
`;
    // The same type: a change of name only.
    expect((await planImport(deps, text.replace('name: Hall lamp', 'name: Big hall lamp'), { mode: 'merge', by: actor('person', 'olof') })).devices[0]).toEqual({ key: 'hall-lamp', name: 'Big hall lamp', action: 'change', changes: ['name: Hall lamp → Big hall lamp', 'no longer reached bus'] });
    const other = await planImport(deps, text.replace('type: test.lamp', 'type: test.nothing'), { mode: 'merge', by: actor('person', 'olof') });
    expect(other.id).toBeNull();
    expect(other.problems).toEqual([{ message: 'No installed device type is called "test.nothing"', path: ['devices', 'hall-lamp', 'type'], line: 4, column: 11 }]);
  });

  test('a secret it names but does not carry is asked for, and kept once given', async () => {
    const text = `kraftverk: 4
devices:
  desk-lamp:
    type: test.lamp
    name: Desk lamp
    connect:
      - via: bus
        address: lamp-desk
        secrets: { pin: !secret desk-pin }
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.needs.secrets).toEqual([{ device: 'desk-lamp', deviceName: 'Desk lamp', field: 'pin', title: 'PIN' }]);
    await expect(applyImport(deps, plan.id!, actor('person', 'olof'), {})).rejects.toThrow('It still needs Desk lamp: its PIN');
    const again = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    await applyImport(deps, again.id!, actor('person', 'olof'), { secrets: { 'desk-lamp.pin': '4321' } });
    const desk = deps.catalog.byKey('desk-lamp')!;
    expect(deps.connections.secret(deps.connections.forDevice(desk.id)[0]!.id, 'pin')).toBe('4321');
  });

  test('a role naming a device you do not have: one of yours that can do it, chosen', async () => {
    aHome();
    const text = `kraftverk: 4
automations:
  evening:
    name: Evening
    clock: Europe/Stockholm
    uses:
      lamp: cellar-lamp
    when:
      - at: "19:00"
    do:
      - turn on: lamp
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.needs.rebind).toEqual([
      {
        automation: 'evening',
        role: 'lamp',
        label: 'Lamp',
        wanted: 'cellar-lamp',
        candidates: [
          { use: 'hall-lamp', name: 'Hall lamp' },
          { use: 'porch-lamp', name: 'Porch lamp' },
        ],
      },
    ]);
    // A device the same file adds can fill it too.
    const withCellar = text.replace('automations:', 'devices:\n  attic-lamp:\n    type: test.lamp\n    name: Attic lamp\n    connect:\n      - via: simulated\nautomations:');
    const planned = await planImport(deps, withCellar, { mode: 'merge', by: actor('person', 'olof') });
    expect(planned.needs.rebind[0]!.candidates.map((candidate) => candidate.use)).toEqual(['hall-lamp', 'porch-lamp', 'attic-lamp']);
    await applyImport(deps, planned.id!, actor('person', 'olof'), { rebind: { 'evening.lamp': 'attic-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('attic-lamp')!.id);
    deps.automations.delete(deps.automations.byKey('evening')!.id);
    await expect(applyImport(deps, plan.id!, actor('person', 'olof'), {})).rejects.toThrow('a device for Lamp');
    const again = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    await applyImport(deps, again.id!, actor('person', 'olof'), { rebind: { 'evening.lamp': 'porch-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
  });

  test('one automation\'s own YAML — as its page shows it — is imported under a key made from its name', async () => {
    aHome();
    const text = 'name: Evening\nclock: Europe/Stockholm\nuses:\n  lamp: porch-lamp\nwhen:\n  - at: "19:00"\ndo:\n  - turn on: lamp\n';
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    expect(plan.automations).toEqual([{ key: 'evening', name: 'Evening', action: 'add', changes: [] }]);
    expect(plan.notes).toEqual(['Read as one automation, known by "evening"']);
    await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
    // Again: the one by that key is changed to it, and said so.
    expect((await planImport(deps, text.replace('19:00', '20:00'), { mode: 'merge', by: actor('person', 'olof') })).notes).toEqual(['Read as one automation, known by "evening": the one you have by that key is changed to it']);
    // A device's own, too: its problems in its own text.
    const device = await planImport(deps, 'type: test.lamp\nname: Cellar lamp\nconnect:\n  - via: bus\n    address: lamp-cellar\n', { mode: 'merge', by: actor('person', 'olof') });
    expect(device.devices).toEqual([{ key: 'cellar-lamp', name: 'Cellar lamp', action: 'add', changes: [] }]);
  });

  test('a number beside a type\'s own reading is in the unit of the part filling its role: converted, or refused', async () => {
    const refused = deps.types.install(
      defineDeviceType({
        id: 'test.flow',
        kind: 'hardware',
        meta: { name: 'Test flow meter', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['F1'] },
        describe: () => ({
          parts: [{ id: MAIN_PART, label: 'Meter', kind: 'meter', offers: ['powerMeter'] }],
          attributes: [
            { key: 'power', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' },
            { key: 'flow', label: 'Flow', value: { type: 'number', unit: 'W' }, means: 'test.flow' },
          ],
        }),
        config: { fields: {} },
        connections: [{ id: 'bus', label: 'Test bus', protocol: 'test-lamp', transport: 'bus', reach: 'local', updates: 'poll' }],
        async identify() {
          return { identity: null, model: null, summary: 'A meter.' };
        },
        async createSession() {
          throw new Error('not in this test');
        },
        async createSimulator() {
          throw new Error('not in this test');
        },
      }),
      TEST_SOURCE
    );
    expect(refused).toEqual([]);
    const text = (limit: string) =>
      `kraftverk: 4\ndevices:\n  meter:\n    type: test.flow\n    name: Meter\n    connect:\n      - via: simulated\nautomations:\n  flowing:\n    name: Flowing\n    clock: Europe/Stockholm\n    uses:\n      meter: { part: meter, needs: [powerMeter] }\n    when:\n      - becomes: meter.test.flow > ${limit}\n    do:\n      - wait: 1 s\n`;
    const plan = await planImport(deps, text('2 kW'), { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    // Kept as written; a run converts it.
    expect(deps.automations.byKey('flowing')!.rule.when[0]).toMatchObject({ becomes: { right: { value: 2, unit: 'kW' } } });
    expect((await planImport(deps, text('2 °C'), { mode: 'merge', by: actor('person', 'olof') })).problems.map((problem) => problem.message)).toEqual(['Meter’s flow is in W: "°C" is not a unit of it']);
  });

  test('simulated devices share their address: no claim on it, as setup makes none', async () => {
    deps.connections.add({ deviceId: deps.catalog.add({ typeId: 'test.lamp', name: 'Sim lamp', description: LAMP }).id, method: 'simulated', transport: 'simulated', heldBy: MACHINE_NODE.id, address: 'simulated' });
    const text = 'kraftverk: 4\ndevices:\n  other-sim:\n    type: test.lamp\n    name: Other sim\n    connect:\n      - via: simulated\n';
    expect((await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') })).problems).toEqual([]);
  });

  test('a role nothing fills — written while it was being built — is a problem at its line, not an import that fails', async () => {
    aHome();
    const text = `kraftverk: 4
automations:
  evening:
    name: Evening
    clock: Europe/Stockholm
    uses:
      lamp: ~
    do:
      - turn on: lamp
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: nothing fills it — name a device for it', path: ['automations', 'evening', 'uses', 'lamp'], line: 7, column: 13 }]);
  });

  test('a part that cannot do what the rule asks is said in the plan — before a yes, not after', async () => {
    const text = `kraftverk: 4
devices:
  new-lamp:
    type: test.lamp
    name: New lamp
    connect:
      - via: bus
        address: lamp-new
automations:
  broken:
    name: Broken
    clock: Europe/Stockholm
    uses:
      lamp: { part: new-lamp, needs: [switch] }
    do:
      - set: lamp
        setting: brightness
        to: 50
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: New lamp has no setting "brightness"', path: ['automations', 'broken'], line: 11, column: 5 }]);
  });

  test('an automation that cannot be kept at the apply undoes the whole import — the devices added with it too', async () => {
    const { hall } = aHome();
    const text = `kraftverk: 4
devices:
  new-lamp:
    type: test.lamp
    name: New lamp
    connect:
      - via: bus
        address: lamp-new
automations:
  evening:
    name: Evening
    clock: Europe/Stockholm
    uses:
      lamp: hall-lamp
    do:
      - turn on: lamp
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: actor('person', 'olof') });
    expect(plan.problems).toEqual([]);
    // Between the plan and the yes, the lamp it uses goes.
    deps.catalog.remove(hall.id);
    await expect(applyImport(deps, plan.id!, actor('person', 'olof'), {})).rejects.toBeInstanceOf(ApiError);
    expect(deps.catalog.byKey('new-lamp')).toBeNull();
    expect(deps.automations.byKey('evening')).toBeNull();
  });

  test('replacing: what the file does not have is removed — and asked a yes to', async () => {
    aHome();
    const text = `kraftverk: 4
devices:
  hall-lamp:
    type: test.lamp
    name: Hall lamp
    identity: test-lamp:HALL
    settings: { room: Hall }
    connect:
      - via: bus
        address: lamp-hall
`;
    const plan = await planImport(deps, text, { mode: 'replace', by: actor('person', 'olof') });
    expect(plan.devices.map((item) => [item.key, item.action])).toEqual([
      ['hall-lamp', 'same'],
      ['porch-lamp', 'remove'],
    ]);
    expect(plan.automations).toEqual([{ key: 'morning', name: 'Morning', action: 'remove', changes: [] }]);
    expect(plan.needs.confirm).toEqual(['"Porch lamp" is removed: Porch lamp — their history is kept', '"Morning" is deleted']);
    const applied = await applyImport(deps, plan.id!, actor('person', 'olof'), {});
    expect(applied.devices.removed).toEqual(['porch-lamp']);
    expect(applied.automations.removed).toEqual(['morning']);
    expect(deps.catalog.byKey('porch-lamp')).toBeNull();
  });
});

describe('the snapshot kept beside the database', () => {
  test('restores a home by itself — secrets, acting automations — and says where from', async () => {
    aHome();
    const text = await exported('kept');
    db.exec('DELETE FROM automation; DELETE FROM device;');

    const restored = await restoreFrom(deps, text, 'kraftverk.before-a-test.yaml');
    expect(restored.from).toBe('kraftverk.before-a-test.yaml');
    expect(restored!.problems).toEqual([]);
    expect(restored!.applied!.devices.added).toEqual(['hall-lamp', 'porch-lamp']);
    const hall = deps.catalog.byKey('hall-lamp')!;
    expect(deps.connections.secret(deps.connections.forDevice(hall.id)[0]!.id, 'pin')).toBe('pin-of-a-test');
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'act' });
  });

  test('restores item by item: an automation naming a removed device kept turned off, a device it cannot read left out — the rest restored', async () => {
    const { hall, porch } = aHome();
    // One that uses the porch lamp, which is then removed: its role is still bound to it.
    const evening = deps.automations.create({ name: 'Evening', rule: lampRule, madeFrom: null, roles: { lamp: { device: porch.id, part: 'main' } }, groups: {}, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
    deps.automations.update(evening.id, { mode: 'act' });
    deps.catalog.remove(porch.id);
    const text = await exported('kept');
    // Its role is written empty: the file names no key the server does not list.
    expect(text).toContain('lamp: null');
    // And a device of a type no longer installed, beside the rest.
    const withGone = text.replace('devices:\n', 'devices:\n  attic-heater:\n    type: test.gone\n    name: Attic heater\n');
    db.exec('DELETE FROM automation; DELETE FROM device;');

    const restored = await restoreFrom(deps, withGone, 'kraftverk.before-a-test.yaml');
    expect(restored!.applied!.devices.added).toEqual(['hall-lamp']);
    expect(deps.catalog.byKey('hall-lamp')!.identity).toBe(hall.identity);
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'act' });
    // Kept, turned off, its rule whole: its owner gives it a lamp again.
    expect(deps.automations.byKey('evening')).toMatchObject({ mode: 'off', rule: lampRule, roles: {} });
    expect(restored!.problems).toEqual([
      expect.stringMatching(/^line \d+: No installed device type is called "test\.gone" — left out$/),
      '"Evening" is restored turned off: Lamp: nothing fills it — name a device for it; Lamp: choose one of your devices',
    ]);
  });

});
