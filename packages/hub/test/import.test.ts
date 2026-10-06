import { beforeEach, describe, expect, test } from 'bun:test';

import { writeConfig } from '@kraftverk/home-file';
import { defineDeviceType, MAIN_PART } from '@kraftverk/device-sdk';
import type { Rule } from '@kraftverk/automation';

import { ApiError } from '@kraftverk/api-contract';
import { AutomationLibrary } from '@kraftverk/automation-engine';
import type { AuditRecord } from '@kraftverk/device-sdk';
import { HomeSettings, AutomationStore, ConnectionStore, DeviceCatalog, EventStore, HistoryStore, LinkStore, NodeStore, plainSecrets, policyValues, setPolicyValue, type SqlDatabase } from '@kraftverk/store';

import { drafts } from '../src/automations/drafts.ts';
import { exportConfig } from '../src/configuration/export.ts';
import { PendingPlans, planImport, startWritten, writeImport, type ImportChoices, type ImportDeps } from '../src/configuration/import.ts';
import { restoreFrom } from '../src/configuration/restore.ts';
import type { PassphraseSealing } from '../src/configuration/seal.ts';
import { ProtocolRegistry } from '../src/installed/protocols.ts';
import { DeviceTypeRegistry } from '../src/installed/types.ts';
import { LAMP, lampProtocol, lampType, MACHINE_NODE } from '../src/testing.ts';
import { testDatabase } from './home.ts';

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

/** A plan applied as an apply does: written, then set going. */
async function applyImport(on: ImportDeps, id: string, by: string, choices: ImportChoices) {
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
  types.install(lampType);
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  const catalog = new DeviceCatalog(db);
  const automations = new AutomationStore(db);
  const library = new AutomationLibrary([], () => {});
  const engine = { reset: () => {}, poke: () => {}, forget: () => {} };
  const sessions = { sync: async (records: readonly unknown[]) => void sessionsSynced.push(records.length), description: (record: { description: unknown }) => record.description };
  const { checked } = drafts({ history: new HistoryStore(db), events: new EventStore(db), catalog, sessions: sessions as never, library, engine: engine as never, automations });
  const state = new HomeSettings(db);
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
    policy: { values: () => policyValues(state), set: (name, value) => setPolicyValue(state, name, value) },
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

/** A home: two lamps — one with its PIN — and an automation that acts, on the home page. */
function aHome() {
  const hall = deps.catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', identity: 'lampish:HALL', config: { room: 'Hall' }, description: LAMP });
  const way = deps.connections.add({ deviceId: hall.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-hall' });
  deps.connections.setSecrets(way.id, { pin: 'pin-of-a-test' });
  const porch = deps.catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
  deps.connections.add({ deviceId: porch.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-porch' });
  const morning = deps.automations.create({ name: 'Morning', rule: lampRule, madeFrom: null, roles: { lamp: { device: hall.id, part: 'main' } }, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
  deps.automations.update(morning.id, { mode: 'act' });
  deps.automations.placeOnHome(morning.id, 0);
  return { hall, porch, morning };
}

const exported = async (secrets: 'sealed' | 'kept' | 'none' = 'sealed') => {
  const out = await exportConfig(deps, { secrets, passphrase: PASSPHRASE });
  return writeConfig(out.document, out.context);
};

describe('a server’s own export, into a database wiped', () => {
  test('is the server again: devices by key, how each is reached, its secret, the automation bound, acting, on the home page', async () => {
    aHome();
    const text = await exported();
    db.exec('DELETE FROM automation; DELETE FROM device;');

    const plan = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
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
    expect(morning).toMatchObject({ mode: 'act', homePlace: 0, rule: lampRule, roles: { lamp: { device: hall.id, part: 'main' } } });
    expect(sessionsSynced.at(-1)).toBe(2);

    // Read again over what it made: nothing to do.
    const again = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    expect([...again.devices, ...again.automations].map((item) => item.action)).toEqual(['same', 'same', 'same']);
    expect(again.needs.confirm).toEqual([]);
  });

  test('a plan is used once, and only by whoever read it', async () => {
    aHome();
    const plan = await planImport(deps, await exported(), { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    await expect(applyImport(deps, plan.id!, 'someone else', {})).rejects.toThrow('That plan has gone');
    await applyImport(deps, plan.id!, 'olof', {});
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('That plan has gone');
  });

  test('what the database will not keep is the file’s, refused; a fault in the code is not said as one — and either way nothing is written', async () => {
    aHome();
    const text = await exported();
    db.exec('DELETE FROM automation; DELETE FROM device;');
    const add = deps.catalog.add.bind(deps.catalog);

    deps.catalog.add = () => {
      throw new Error('UNIQUE constraint failed: device.key');
    };
    const refused = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    const error = await applyImport(deps, refused.id!, 'olof', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('invalid');

    deps.catalog.add = () => {
      throw new TypeError('a fault in the code');
    };
    const faulty = await planImport(deps, text, { mode: 'merge', passphrase: PASSPHRASE, by: 'olof' });
    const fault = await applyImport(deps, faulty.id!, 'olof', {}).catch((caught: unknown) => caught);
    expect(fault).toBeInstanceOf(TypeError);

    deps.catalog.add = add;
    expect(deps.catalog.list()).toEqual([]);
  });
});

describe('what a file cannot do, and what it needs', () => {
  test('its sealed secrets need the passphrase — the right one', async () => {
    aHome();
    const text = await exported();
    expect((await planImport(deps, text, { mode: 'merge', by: 'olof' })).needs.passphrase).toBe('missing');
    expect((await planImport(deps, text, { mode: 'merge', passphrase: 'not the passphrase at all', by: 'olof' })).needs.passphrase).toBe('wrong');
  });

  test('a key naming a device of another type is a problem, at its line', async () => {
    aHome();
    const text = `kraftverk: 3
devices:
  hall-lamp:
    type: test.lamp
    name: Hall lamp
`;
    // The same type: a change of name only.
    expect((await planImport(deps, text.replace('name: Hall lamp', 'name: Big hall lamp'), { mode: 'merge', by: 'olof' })).devices[0]).toEqual({ key: 'hall-lamp', name: 'Big hall lamp', action: 'change', changes: ['name: Hall lamp → Big hall lamp', 'no longer reached bus'] });
    const other = await planImport(deps, text.replace('type: test.lamp', 'type: test.nothing'), { mode: 'merge', by: 'olof' });
    expect(other.id).toBeNull();
    expect(other.problems).toEqual([{ message: 'No installed device type is called "test.nothing"', path: ['devices', 'hall-lamp', 'type'], line: 4, column: 11 }]);
  });

  test('a secret it names but does not carry is asked for, and kept once given', async () => {
    const text = `kraftverk: 3
devices:
  desk-lamp:
    type: test.lamp
    name: Desk lamp
    connect:
      - via: bus
        address: lamp-desk
        secrets: { pin: !secret desk-pin }
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.needs.secrets).toEqual([{ device: 'desk-lamp', deviceName: 'Desk lamp', field: 'pin', title: 'PIN' }]);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('It still needs Desk lamp: its PIN');
    const again = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    await applyImport(deps, again.id!, 'olof', { secrets: { 'desk-lamp.pin': '4321' } });
    const desk = deps.catalog.byKey('desk-lamp')!;
    expect(deps.connections.secret(deps.connections.forDevice(desk.id)[0]!.id, 'pin')).toBe('4321');
  });

  test('a role naming a device you do not have: one of yours that can do it, chosen', async () => {
    aHome();
    const text = `kraftverk: 3
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
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
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
    const planned = await planImport(deps, withCellar, { mode: 'merge', by: 'olof' });
    expect(planned.needs.rebind[0]!.candidates.map((candidate) => candidate.use)).toEqual(['hall-lamp', 'porch-lamp', 'attic-lamp']);
    await applyImport(deps, planned.id!, 'olof', { rebind: { 'evening.lamp': 'attic-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('attic-lamp')!.id);
    deps.automations.delete(deps.automations.byKey('evening')!.id);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toThrow('a device for Lamp');
    const again = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    await applyImport(deps, again.id!, 'olof', { rebind: { 'evening.lamp': 'porch-lamp' } });
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
  });

  test('one automation\'s own YAML — as its page shows it — is imported under a key made from its name', async () => {
    aHome();
    const text = 'name: Evening\nclock: Europe/Stockholm\nuses:\n  lamp: porch-lamp\nwhen:\n  - at: "19:00"\ndo:\n  - turn on: lamp\n';
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    expect(plan.automations).toEqual([{ key: 'evening', name: 'Evening', action: 'add', changes: [] }]);
    expect(plan.notes).toEqual(['Read as one automation, known by "evening"']);
    await applyImport(deps, plan.id!, 'olof', {});
    expect(deps.automations.byKey('evening')!.roles.lamp!.device).toBe(deps.catalog.byKey('porch-lamp')!.id);
    // Again: the one by that key is changed to it, and said so.
    expect((await planImport(deps, text.replace('19:00', '20:00'), { mode: 'merge', by: 'olof' })).notes).toEqual(['Read as one automation, known by "evening": the one you have by that key is changed to it']);
    // A device's own, too: its problems in its own text.
    const device = await planImport(deps, 'type: test.lamp\nname: Cellar lamp\nconnect:\n  - via: bus\n    address: lamp-cellar\n', { mode: 'merge', by: 'olof' });
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
      `kraftverk: 3\ndevices:\n  meter:\n    type: test.flow\n    name: Meter\n    connect:\n      - via: simulated\nautomations:\n  flowing:\n    name: Flowing\n    clock: Europe/Stockholm\n    uses:\n      meter: { part: meter, needs: [powerMeter] }\n    when:\n      - becomes: meter.test.flow > ${limit}\n    do:\n      - wait: 1 s\n`;
    const plan = await planImport(deps, text('2 kW'), { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    await applyImport(deps, plan.id!, 'olof', {});
    expect(deps.automations.byKey('flowing')!.rule.when[0]).toMatchObject({ becomes: { right: { value: 2000 } } });
    expect((await planImport(deps, text('2 °C'), { mode: 'merge', by: 'olof' })).problems.map((problem) => problem.message)).toEqual(['That is read in W: "°C" is not a unit of it']);
  });

  test('simulated devices share their address: no claim on it, as setup makes none', async () => {
    deps.connections.add({ deviceId: deps.catalog.add({ typeId: 'test.lamp', name: 'Sim lamp', description: LAMP }).id, method: 'simulated', transport: 'simulated', heldBy: MACHINE_NODE.id, address: 'simulated' });
    const text = 'kraftverk: 3\ndevices:\n  other-sim:\n    type: test.lamp\n    name: Other sim\n    connect:\n      - via: simulated\n';
    expect((await planImport(deps, text, { mode: 'merge', by: 'olof' })).problems).toEqual([]);
  });

  test('a role nothing fills — written while it was being built — is a problem at its line, not an import that fails', async () => {
    aHome();
    const text = `kraftverk: 3
automations:
  evening:
    name: Evening
    clock: Europe/Stockholm
    uses:
      lamp: ~
    do:
      - turn on: lamp
`;
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: nothing fills it — name a device for it', path: ['automations', 'evening', 'uses', 'lamp'], line: 7, column: 13 }]);
  });

  test('a part that cannot do what the rule asks is said in the plan — before a yes, not after', async () => {
    const text = `kraftverk: 3
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
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.id).toBeNull();
    expect(plan.problems).toEqual([{ message: 'Lamp: New lamp has no setting "brightness"', path: ['automations', 'broken'], line: 11, column: 5 }]);
  });

  test('an automation that cannot be kept at the apply undoes the whole import — the devices added with it too', async () => {
    const { hall } = aHome();
    const text = `kraftverk: 3
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
    const plan = await planImport(deps, text, { mode: 'merge', by: 'olof' });
    expect(plan.problems).toEqual([]);
    // Between the plan and the yes, the lamp it uses goes.
    deps.catalog.remove(hall.id);
    await expect(applyImport(deps, plan.id!, 'olof', {})).rejects.toBeInstanceOf(ApiError);
    expect(deps.catalog.byKey('new-lamp')).toBeNull();
    expect(deps.automations.byKey('evening')).toBeNull();
  });

  test('replacing: what the file does not have is removed — and asked a yes to', async () => {
    aHome();
    const text = `kraftverk: 3
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
    const plan = await planImport(deps, text, { mode: 'replace', by: 'olof' });
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
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'act', homePlace: 0 });
  });

  test('restores item by item: an automation naming a removed device kept turned off, a device it cannot read left out — the rest restored', async () => {
    const { hall, porch } = aHome();
    // One that uses the porch lamp, which is then removed: its role is still bound to it.
    const evening = deps.automations.create({ name: 'Evening', rule: lampRule, madeFrom: null, roles: { lamp: { device: porch.id, part: 'main' } }, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
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
    expect(deps.automations.byKey('morning')).toMatchObject({ mode: 'act', homePlace: 0 });
    // Kept, turned off, its rule whole: its owner gives it a lamp again.
    expect(deps.automations.byKey('evening')).toMatchObject({ mode: 'off', rule: lampRule, roles: {} });
    expect(restored!.problems).toEqual([
      expect.stringMatching(/^line \d+: No installed device type is called "test\.gone" — left out$/),
      '"Evening" is restored turned off: Lamp: nothing fills it — name a device for it; Lamp: choose one of your devices',
    ]);
  });

});
