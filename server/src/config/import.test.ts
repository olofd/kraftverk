import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeConfig } from '@kraftverk/config';
import { defineDeviceType, MAIN_PART, type Rule } from '@kraftverk/device-sdk';

import { AutomationLibrary } from '../automations/library.ts';
import { plans } from '../automations/plans.ts';
import { AutomationStore } from '../automations/store.ts';
import { DeviceCatalog } from '../devices/catalog.ts';
import { ConnectionStore } from '../devices/connections.ts';
import { LinkStore } from '../devices/links.ts';
import { LAMP, lampProtocol, lampType } from '../devices/testing.ts';
import { DeviceTypeRegistry } from '../devices/types.ts';
import { closeDb, db } from '../history/db.ts';
import { ProtocolRegistry } from '../runtime/protocols.ts';
import { exportConfig } from './export.ts';
import { applyImport, ImportError, planImport, type ImportDeps } from './import.ts';
import { restoreFrom } from './restore.ts';

/*
  A configuration imported: planned — nothing written — then applied, in one
  transaction. A server's own export, imported into a database wiped, is the
  server again: its devices by their keys, how each is reached, their
  secrets, its automations bound and acting as they were. What a file
  cannot do is said at its line; what it needs is asked; what it would set
  acting is confirmed; and a snapshot kept beside the database restores a
  home by itself.
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-import-'));
let deps: ImportDeps;
const sessionsSynced: number[] = [];
const PASSPHRASE = 'a passphrase of some length';

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  const catalog = new DeviceCatalog();
  const automations = new AutomationStore();
  const library = new AutomationLibrary([lampType], () => {});
  const engine = { reset: () => {}, poke: () => {}, forget: () => {} };
  const sessions = { sync: async (records: unknown[]) => void sessionsSynced.push(records.length), description: (record: { description: unknown }) => record.description };
  const { checked } = plans({ catalog, sessions: sessions as never, library, engine: engine as never, automations });
  deps = { catalog, connections: new ConnectionStore(), links: new LinkStore(), automations, types, protocols, library, engine, sessions, transports: { definition: () => null }, checked };
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM automation; DELETE FROM device; DELETE FROM app_state;');
});

const lampRule: Rule = {
  roles: { lamp: { label: 'Lamp', description: 'Lamp', capabilities: ['switch'] } },
  params: { fields: {} },
  when: [{ at: { value: '07:00' } }],
  then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
};

/** A home: two lamps — one with its PIN — and an automation that acts, on the home page. */
function aHome() {
  const hall = deps.catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', identity: 'lampish:HALL', config: { room: 'Hall' }, description: LAMP });
  const way = deps.connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: null, address: 'lamp-hall' });
  deps.connections.setSecrets(way.id, { pin: 'pin-of-a-test' });
  const porch = deps.catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
  deps.connections.add({ deviceId: porch.id, method: 'bus', transport: 'bus', heldBy: null, address: 'lamp-porch' });
  const morning = deps.automations.create({ name: 'Morning', rule: lampRule, madeFrom: null, roles: { lamp: { device: hall.id, part: 'main' } }, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
  deps.automations.update(morning.id, { mode: 'armed' });
  deps.automations.placeOnHome(morning.id, 0);
  return { hall, porch, morning };
}

const exported = (secrets: 'sealed' | 'kept' | 'none' = 'sealed') => {
  const out = exportConfig(deps, { secrets, passphrase: PASSPHRASE });
  return writeConfig(out.document, out.context);
};

describe('a server’s own export, into a database wiped', () => {
  test('is the server again: devices by key, how each is reached, its secret, the automation bound, acting, on the home page', async () => {
    aHome();
    const text = exported();
    db().exec('DELETE FROM automation; DELETE FROM device;');

    const plan = planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    expect(plan.problems).toEqual([]);
    expect(plan.devices.map((item) => [item.key, item.action])).toEqual([
      ['hall-lamp', 'add'],
      ['porch-lamp', 'add'],
    ]);
    expect(plan.automations).toEqual([{ key: 'morning', name: 'Morning', action: 'add', changes: [] }]);
    expect(plan.needs).toEqual({ passphrase: null, secrets: [], rebind: [], confirm: ['"Morning" will act on its own'] });

    const applied = await applyImport(deps, plan.id!, 'olof', {});
    expect(applied.devices.added).toEqual(['hall-lamp', 'porch-lamp']);
    const hall = deps.catalog.byKey('hall-lamp')!;
    expect(hall).toMatchObject({ name: 'Hall lamp', identity: 'lampish:HALL', config: { room: 'Hall' } });
    const way = deps.connections.forDevice(hall.id)[0]!;
    expect(way).toMatchObject({ method: 'bus', address: 'lamp-hall' });
    expect(deps.connections.secret(way.id, 'pin')).toBe('pin-of-a-test');
    const morning = deps.automations.byKey('morning')!;
    expect(morning).toMatchObject({ mode: 'armed', homePlace: 0, rule: lampRule, roles: { lamp: { device: hall.id, part: 'main' } } });
    expect(sessionsSynced.at(-1)).toBe(2);

    // Read again over what it made: nothing to do.
    const again = planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    expect([...again.devices, ...again.automations].map((item) => item.action)).toEqual(['same', 'same', 'same']);
    expect(again.needs.confirm).toEqual([]);
  });

  test('a plan is used once, and only by whoever read it', async () => {
    aHome();
    const plan = planImport(deps, exported(), { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    await expect(applyImport(deps, plan.id!, 'someone else', {})).rejects.toThrow('That plan has gone');
    await applyImport(deps, plan.id!, 'olof', {});
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('That plan has gone');
  });
});

describe('what a file cannot do, and what it needs', () => {
  test('its sealed secrets need the passphrase — the right one', () => {
    aHome();
    const text = exported();
    expect(planImport(deps, text, { mode: 'merge', by: 'olof' }).needs.passphrase).toBe('missing');
    expect(planImport(deps, text, { mode: 'merge', passphrase: 'not the passphrase at all', by: 'olof' }).needs.passphrase).toBe('wrong');
  });

  test('a key naming a device of another type is a problem, at its line', () => {
    aHome();
    const text = `kraftverk: 1
devices:
  hall-lamp:
    type: test.lamp
    name: Hall lamp
`;
    // The same type: a change of name only.
    expect(planImport(deps, text.replace('name: Hall lamp', 'name: Big hall lamp'), { mode: 'merge', by: 'olof' }).devices[0]).toEqual({ key: 'hall-lamp', name: 'Big hall lamp', action: 'change', changes: ['name: Hall lamp → Big hall lamp', 'no longer reached bus'] });
    const other = planImport(deps, text.replace('type: test.lamp', 'type: test.nothing'), { mode: 'merge', by: 'olof' });
    expect(other.id).toBeNull();
    expect(other.problems).toEqual([{ message: 'No installed device type is called "test.nothing"', path: ['devices', 'hall-lamp', 'type'], line: 4, column: 11 }]);
  });

  test('a secret it names but does not carry is asked for, and kept once given', async () => {
    const text = `kraftverk: 1
devices:
  desk-lamp:
    type: test.lamp
    name: Desk lamp
    connect:
      - via: bus
        address: lamp-desk
        secrets: { pin: !secret desk-pin }
`;
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.needs.secrets).toEqual([{ device: 'desk-lamp', deviceName: 'Desk lamp', field: 'pin', title: 'PIN' }]);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('It still needs Desk lamp: its PIN');
    const again = planImport(deps, text, { mode: 'merge', by: 'olof' });
    await applyImport(deps, again.id!, 'olof', { secrets: { 'desk-lamp.pin': '4321' } });
    const desk = deps.catalog.byKey('desk-lamp')!;
    expect(deps.connections.secret(deps.connections.forDevice(desk.id)[0]!.id, 'pin')).toBe('4321');
  });

  test('a role naming a device you do not have: one of yours that can do it, chosen', async () => {
    aHome();
    const text = `kraftverk: 1
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
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
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
    const planned = planImport(deps, withCellar, { mode: 'merge', by: 'olof' });
    expect(planned.needs.rebind[0]!.candidates.map((candidate) => candidate.use)).toEqual(['hall-lamp', 'porch-lamp', 'attic-lamp']);
    await applyImport(deps, planned.id!, 'olof', { rebind: { 'evening.lamp': 'attic-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('attic-lamp')!.id);
    deps.automations.delete(deps.automations.byKey('evening')!.id);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('a device for Lamp');
    const again = planImport(deps, text, { mode: 'merge', by: 'olof' });
    await applyImport(deps, again.id!, 'olof', { rebind: { 'evening.lamp': 'porch-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
  });

  test('one automation\'s own YAML — as its page shows it — is imported under a key made from its name', async () => {
    aHome();
    const text = 'name: Evening\nclock: Europe/Stockholm\nuses:\n  lamp: porch-lamp\nwhen:\n  - at: "19:00"\ndo:\n  - turn on: lamp\n';
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    expect(plan.automations).toEqual([{ key: 'evening', name: 'Evening', action: 'add', changes: [] }]);
    expect(plan.notes).toEqual(['Read as one automation, known by "evening"']);
    await applyImport(deps, plan.id!, 'olof', {});
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
    // Again: the one by that key is changed to it, and said so.
    expect(planImport(deps, text.replace('19:00', '20:00'), { mode: 'merge', by: 'olof' }).notes).toEqual(['Read as one automation, known by "evening": the one you have by that key is changed to it']);
    // A device's own, too: its problems in its own text.
    const device = planImport(deps, 'type: test.lamp\nname: Cellar lamp\nconnect:\n  - via: bus\n    address: lamp-cellar\n', { mode: 'merge', by: 'olof' });
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
            { key: 'power', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power.draw' },
            { key: 'flow', label: 'Flow', value: { type: 'number', unit: 'W' }, means: 'test.flow' },
          ],
        }),
        config: { fields: {} },
        connections: [{ id: 'bus', label: 'Test bus', protocol: 'lampish', transport: 'bus', reach: 'local' }],
        async identify() {
          return { identity: null, model: null, summary: 'A meter.' };
        },
        async createSession() {
          throw new Error('not in this test');
        },
        async createSimulator() {
          throw new Error('not in this test');
        },
      })
    );
    expect(refused).toEqual([]);
    const text = (limit: string) =>
      `kraftverk: 1\ndevices:\n  meter:\n    type: test.flow\n    name: Meter\n    connect:\n      - via: simulated\nautomations:\n  flowing:\n    name: Flowing\n    clock: Europe/Stockholm\n    uses:\n      meter: { part: meter, needs: [powerMeter] }\n    when:\n      - becomes: meter.test.flow > ${limit}\n    do:\n      - wait: 1 s\n`;
    const plan = planImport(deps, text('2 kW'), { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    await applyImport(deps, plan.id!, 'olof', {});
    expect(deps.automations.byKey('flowing')!.rule.when[0]).toMatchObject({ becomes: { right: { value: 2000 } } });
    expect(planImport(deps, text('2 °C'), { mode: 'merge', by: 'olof' }).problems.map((problem) => problem.message)).toEqual(['That is read in W: "°C" is not a unit of it']);
  });

  test('simulated devices share their address: no claim on it, as setup makes none', () => {
    deps.connections.add({ deviceId: deps.catalog.add({ typeId: 'test.lamp', name: 'Sim lamp', description: LAMP }).id, method: 'simulated', transport: 'simulated', heldBy: null, address: 'simulated' });
    const text = 'kraftverk: 1\ndevices:\n  other-sim:\n    type: test.lamp\n    name: Other sim\n    connect:\n      - via: simulated\n';
    expect(planImport(deps, text, { mode: 'merge', by: 'olof' }).problems).toEqual([]);
  });

  test('a role nothing fills — written while it was being built — is a problem at its line, not an import that fails', () => {
    aHome();
    const text = `kraftverk: 1
automations:
  evening:
    name: Evening
    clock: Europe/Stockholm
    uses:
      lamp: ~
    do:
      - turn on: lamp
`;
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: nothing fills it — name a device for it', path: ['automations', 'evening', 'uses', 'lamp'], line: 7, column: 13 }]);
  });

  test('a part that cannot do what the rule asks is said in the plan — before a yes, not after', () => {
    const text = `kraftverk: 1
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
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: New lamp has no setting "brightness"', path: ['automations', 'broken'], line: 11, column: 5 }]);
  });

  test('an automation that cannot be kept at the apply undoes the whole import — the devices added with it too', async () => {
    const { hall } = aHome();
    const text = `kraftverk: 1
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
    const plan = planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    // Between the plan and the yes, the lamp it uses goes.
    deps.catalog.remove(hall.id);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toBeInstanceOf(ImportError);
    expect(deps.catalog.byKey('new-lamp')).toBeNull();
    expect(deps.automations.byKey('evening')).toBeNull();
  });

  test('replacing: what the file does not have is removed — and asked a yes to', async () => {
    aHome();
    const text = `kraftverk: 1
devices:
  hall-lamp:
    type: test.lamp
    name: Hall lamp
    identity: lampish:HALL
    settings: { room: Hall }
    connect:
      - via: bus
        address: lamp-hall
`;
    const plan = planImport(deps, text, { mode: 'replace', by: 'olof' });
    expect(plan.devices.map((item) => [item.key, item.action])).toEqual([
      ['hall-lamp', 'same'],
      ['porch-lamp', 'remove'],
    ]);
    expect(plan.automations).toEqual([{ key: 'morning', name: 'Morning', action: 'remove', changes: [] }]);
    expect(plan.needs.confirm).toEqual(['"Porch lamp" is removed: Porch lamp — their history is kept', '"Morning" is deleted']);
    const applied = await applyImport(deps, plan.id!, 'olof', {});
    expect(applied.devices.removed).toEqual(['porch-lamp']);
    expect(applied.automations.removed).toEqual(['morning']);
    expect(deps.catalog.byKey('porch-lamp')).toBeNull();
  });
});

describe('the snapshot kept beside the database', () => {
  test('restores a home by itself — secrets, acting automations — and is copied aside first', async () => {
    aHome();
    const file = join(dir, 'config', 'kraftverk.yaml');
    rmSync(join(dir, 'config'), { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(file, exported('kept'));
    db().exec('DELETE FROM automation; DELETE FROM device;');

    const restored = await restoreFrom(deps, file);
    expect(restored!.problems).toEqual([]);
    expect(restored!.applied!.devices.added).toEqual(['hall-lamp', 'porch-lamp']);
    const hall = deps.catalog.byKey('hall-lamp')!;
    expect(deps.connections.secret(deps.connections.forDevice(hall.id)[0]!.id, 'pin')).toBe('pin-of-a-test');
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'armed', homePlace: 0 });
    expect(readdirSync(join(dir, 'config')).some((name) => name.startsWith('kraftverk.before-'))).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  test('restores item by item: an automation naming a removed device kept turned off, a device it cannot read left out — the rest restored', async () => {
    const { hall, porch } = aHome();
    // One that uses the porch lamp, which is then removed: its role is still bound to it.
    const evening = deps.automations.create({ name: 'Evening', rule: lampRule, madeFrom: null, roles: { lamp: { device: porch.id, part: 'main' } }, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
    deps.automations.update(evening.id, { mode: 'armed' });
    deps.catalog.remove(porch.id);
    const text = exported('kept');
    // Its role is written empty: the file names no key the server does not list.
    expect(text).toContain('lamp: null');
    // And a device of a type no longer installed, beside the rest.
    const file = join(dir, 'config', 'kraftverk.yaml');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(file, text.replace('devices:\n', 'devices:\n  attic-heater:\n    type: test.gone\n    name: Attic heater\n'));
    db().exec('DELETE FROM automation; DELETE FROM device;');

    const restored = await restoreFrom(deps, file);
    expect(restored!.applied!.devices.added).toEqual(['hall-lamp']);
    expect(deps.catalog.byKey('hall-lamp')!.identity).toBe(hall.identity);
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'armed', homePlace: 0 });
    // Kept, turned off, its rule whole: its owner gives it a lamp again.
    expect(deps.automations.byKey('evening')).toMatchObject({ mode: 'off', rule: lampRule, roles: {} });
    expect(restored!.problems).toEqual([
      expect.stringMatching(/^line \d+: No installed device type is called "test\.gone" — left out$/),
      '"Evening" is restored turned off: Lamp: nothing fills it — name a device for it; Lamp: choose one of your devices',
    ]);
  });

  test('of the copies a restore was made from, the last five are kept', async () => {
    const { mkdirSync } = await import('node:fs');
    const folder = join(dir, 'copies');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'kraftverk.yaml');
    for (let n = 0; n < 7; n++) writeFileSync(join(folder, `kraftverk.before-2026-01-0${n + 1}T00-00-00Z.yaml`), 'kraftverk: 1\n');
    writeFileSync(file, 'kraftverk: 1\n');
    await restoreFrom(deps, file);
    const copies = readdirSync(folder).filter((name) => name.startsWith('kraftverk.before-')).sort();
    expect(copies.length).toBe(5);
    expect(copies[0]).toBe('kraftverk.before-2026-01-04T00-00-00Z.yaml');
  });
});
