import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Rule } from '@kraftverk/automation';

import { changesConfiguration } from '../src/index.ts';
import { aHome, refusal, type TestHome } from './a-home.ts';

/*
  A home in one file (docs/CONFIG.md), asked of the home: what a file may
  name, an export — each device by its key, its secrets left out, sealed, or
  plain only where its owner allowed it — keys, and an import planned, then
  applied. The planning and applying themselves are import.test.ts's.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

const SCHEMA_URL = 'http://192.0.2.40:3333/api/config/schema.json';

/** A lamp on the bus, added. */
const aLamp = async (name = 'Hall lamp', address = 'lamp-1', save: { secretsExportable?: boolean } = {}) => {
  t.lampAt(address);
  return t.added(name, { address, save });
};

const lampOnRule: Rule = {
  roles: { lamp: { label: 'Lamp', capabilities: ['switch'] } },
  params: { fields: {} },
  when: [],
  then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
};

describe('configuration', () => {
  test('its JSON Schema names what is installed and nothing you have; what you have is the vocabulary’s', async () => {
    await aLamp();
    const schema = (await t.home.configuration.schema()) as { $defs: { device: { properties: { type: { enum: string[] } } } } };
    expect(schema.$defs.device.properties.type.enum).toContain('test.lamp');
    expect(JSON.stringify(schema)).not.toContain('hall-lamp');
    expect((await t.home.configuration.vocabulary()).devices.map((device) => device.key)).toContain('hall-lamp');
  });

  test('an export: each device by its key, how it is reached — and its secret left out, sealed, or plain only where allowed', async () => {
    const lamp = await aLamp();
    const connection = lamp.connections[0]!.id;
    await t.home.connections.setSecrets(lamp.id, connection, { pin: 'pin-from-a-test' });

    const none = await t.home.configuration.export({ secrets: 'none' }, { schemaUrl: SCHEMA_URL });
    expect(none.text).toContain(`# yaml-language-server: $schema=${SCHEMA_URL}`);
    expect(none.text).toContain('hall-lamp:\n    type: test.lamp\n    name: Hall lamp');
    expect(none.text).not.toContain('pin-from-a-test');
    expect(none.notes).toContain("Hall lamp's pin is left out: give it again after importing");

    // Plain only where its owner allowed it: not here.
    const plain = await t.home.configuration.export({ secrets: 'plain' });
    expect(plain.text).not.toContain('pin-from-a-test');
    expect(plain.notes).toContain("Hall lamp's pin is left out: its owner has not let it leave in plain text");

    // Sealed: under its name, opened only by the passphrase.
    expect((await refusal(t.home.configuration.export({ secrets: 'sealed', passphrase: 'short' }))).kind).toBe('invalid');
    const sealed = await t.home.configuration.export({ secrets: 'sealed', passphrase: 'a passphrase of some length' });
    expect(sealed.text).toContain('pin: !secret hall-lamp.pin');
    expect(sealed.text).toMatch(/hall-lamp\.pin: sealed:v1:/);
    expect(sealed.text).not.toContain('pin-from-a-test');
    // Secrets that left are on the timeline; a plain export without any is not.
    expect((await t.home.timeline()).filter((entry) => entry.kind === 'config.exported').length).toBe(2);

    // One device alone, by its key.
    const one = await t.home.configuration.export({ secrets: 'none', devices: ['hall-lamp'], automations: [] });
    expect(one.text).toContain('hall-lamp:');
    expect(one.text).not.toContain('home:');

    // Its owner lets its secrets leave in plain text: then a plain export carries them — and the choice is on the timeline.
    expect((await t.home.connections.setExportable(lamp.id, connection, true)).connections[0]!.secretsExportable).toBe(true);
    const plainNow = await t.home.configuration.export({ secrets: 'plain' });
    expect(plainNow.text).toContain('pin: pin-from-a-test');
    expect(plainNow.text).toContain('exportable: true');
    expect((await t.home.timeline()).some((entry) => entry.kind === 'device.exportable')).toBe(true);
    await t.home.connections.setExportable(lamp.id, connection, false);
    expect((await t.home.configuration.export({ secrets: 'plain' })).text).not.toContain('pin-from-a-test');
  });

  test('a file lets a kept secret leave in plain text only when it brings that secret itself', async () => {
    const lamp = await aLamp();
    const connection = lamp.connections[0]!.id;
    await t.home.connections.setSecrets(lamp.id, connection, { pin: 'pin-from-a-test' });
    await t.home.connections.setExportable(lamp.id, connection, true);
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('exportable: true');
    const { text: carrying } = await t.home.configuration.export({ secrets: 'plain' });
    expect(carrying).toContain('pin: pin-from-a-test');
    await t.home.connections.setExportable(lamp.id, connection, false);
    const exportable = async () => (await t.home.devices.get(lamp.id)).connections[0]!.secretsExportable;

    // A file without the pin: it would let out what it does not hold — the device's own page asks for a password for that.
    const without = await t.home.configuration.plan({ text });
    expect(without.devices[0]!.changes.join(' ')).not.toContain('plain text');
    await t.home.configuration.apply({ plan: without.id! });
    expect(await exportable()).toBe(false);

    // A file carrying it: what it would let leave it holds already.
    const withIt = await t.home.configuration.plan({ text: carrying });
    expect(withIt.devices[0]!.changes).toContain('bus: its secrets may leave in plain text');
    await t.home.configuration.apply({ plan: withIt.id! });
    expect(await exportable()).toBe(true);
  });

  test('keys: a device and an automation renamed in configuration, never to one taken or not a key', async () => {
    const hall = await aLamp();
    // Its secrets let leave in plain text as it is added: its owner's choice, on the timeline.
    const porch = await aLamp('Porch lamp', 'lamp-2', { secretsExportable: true });
    expect(porch.connections[0]!.secretsExportable).toBe(true);
    expect(hall.connections[0]!.secretsExportable).toBe(false);
    expect(hall.key).toBe('hall-lamp');
    const keyed = await t.home.devices.update(hall.id, { key: 'hallway' });
    expect([keyed.key, keyed.name]).toEqual(['hallway', 'Hall lamp']);
    expect((await refusal(t.home.devices.update(porch.id, { key: 'hallway' }))).kind).toBe('conflict');
    expect((await refusal(t.home.devices.update(porch.id, { key: 'Not A Key' }))).kind).toBe('invalid');
    expect((await t.home.timeline()).find((entry) => entry.kind === 'device.keyed')?.summary).toBe('"Hall lamp" is now known in configuration as hallway, not hall-lamp');

    const roles = { lamp: { device: hall.id, part: 'main' } };
    const automation = await t.home.automations.create({ name: 'Lamp on', key: 'lamp-on', rule: lampOnRule, roles, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' });
    expect(automation.key).toBe('lamp-on');
    expect((await t.home.automations.update(automation.id, { key: 'hall-on' })).key).toBe('hall-on');
    const other = await t.home.automations.create({ name: 'Lamp on', rule: lampOnRule, roles, groups: {}, starts: {}, timeZone: 'Europe/Stockholm' });
    expect(other.key).toBe('lamp-on');
    expect((await refusal(t.home.automations.update(other.id, { key: 'hall-on' }))).kind).toBe('conflict');
  });

  test('an import: planned — nothing written — then applied; what it takes away confirmed first', async () => {
    const lamp = await aLamp();
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    // Removed, then imported again from its own export: back under its key.
    await t.home.devices.remove(lamp.id);
    const plan = await t.home.configuration.plan({ text });
    // The lamp you removed, brought back with its history — not a new one beside it.
    expect(plan.devices).toEqual([{ key: 'hall-lamp', name: 'Hall lamp', action: 'restore', changes: [expect.stringMatching(/^brought back, with its history \(removed \d{4}-\d{2}-\d{2}\)$/)] }]);
    const applied = await t.home.configuration.apply({ plan: plan.id! });
    expect(applied.devices.restored).toEqual(['hall-lamp']);
    expect((await t.home.devices.list()).map((device) => [device.id, device.key])).toEqual([[lamp.id, 'hall-lamp']]);
    // A file with nothing in it, replacing: the lamp would go — asked first, then done.
    const replacing = await t.home.configuration.plan({ text: 'kraftverk: 4\n', mode: 'replace' });
    expect(replacing.needs.confirm).toEqual(['"Hall lamp" is removed: Hall lamp — their history is kept']);
    const asked = await refusal(t.home.configuration.apply({ plan: replacing.id! }));
    expect(asked.kind).toBe('needs-yes');
    const done = await t.home.configuration.apply({ plan: replacing.id!, confirmation: asked.needsConfirmation! });
    expect(done.devices.removed).toEqual(['hall-lamp']);
    // What it did is on the timeline.
    expect((await t.home.timeline()).filter((entry) => entry.kind === 'config.imported').length).toBe(2);
    // A file that is not one: its problems, at their lines, and no plan to apply.
    const wrong = await t.home.configuration.plan({ text: 'kraftverk: 4\ndevices:\n  x:\n    type: test.nothing\n    name: X\n' });
    expect(wrong.id).toBeNull();
    expect(wrong.problems[0]).toMatchObject({ message: 'No installed device type is called "test.nothing"', line: 4 });
  });

  test('a group: exported as the list of its parts, in order, and imported back so', async () => {
    const hall = await aLamp('Hall lamp', 'lamp-1');
    const porch = await aLamp('Porch lamp', 'lamp-2');
    const rule: Rule = {
      roles: { lamps: { group: true, label: 'Lamps', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [],
      then: [{ forEach: { as: 'lamp', in: 'lamps', steps: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }] } }],
    };
    const made = await t.home.automations.create({ name: 'Lamps on', key: 'lamps-on', rule, roles: {}, groups: { lamps: [{ device: porch.id, part: 'main' }, { device: hall.id, part: 'main' }] }, starts: {}, timeZone: 'Europe/Stockholm' });
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('    uses:\n      lamps:\n        - porch-lamp\n        - hall-lamp\n');
    // Gone, then imported from its own export: the same parts, in the same order.
    await t.home.automations.delete(made.id);
    const applied = await t.home.configuration.apply({ plan: (await t.home.configuration.plan({ text })).id! });
    expect(applied.automations.added).toEqual(['lamps-on']);
    const back = (await t.home.automations.list()).find((each) => each.key === 'lamps-on')!;
    expect(back.groups).toEqual({ lamps: [{ device: porch.id, part: 'main' }, { device: hall.id, part: 'main' }] });
  });

  test('a run or a reading on the timeline is no change to it; a device or an automation changed is', () => {
    expect(changesConfiguration('automation.started')).toBe(false);
    expect(changesConfiguration('device.control')).toBe(false);
    expect(changesConfiguration('device.added')).toBe(true);
    expect(changesConfiguration('automation.let-act')).toBe(true);
  });
});
