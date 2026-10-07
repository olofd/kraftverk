import { describe, expect, test } from 'bun:test';

import { MAIN_PART, type AttributeSpec, type DeviceDescription } from '@kraftverk/device-sdk';

import { AutomationStore, ConnectionStore, DeviceCatalog, HistoryStore, LinkStore, plainSecrets } from '@kraftverk/store';

import { planRetype, retype } from '../src/devices/retype.ts';
import { testDatabase } from './home.ts';

/*
  A device changing what it is (docs/PLAN-ZIGBEE.md §2.1): the mapping from
  what it was to what it becomes — parts by what they offer, attributes by
  meaning, then key, then label — shown before anything moves. The case it
  was made for: a Zigbee plug once behind a Tuya gateway, now behind a
  Zigbee2MQTT coordinator.
*/

/** A plug as a Tuya gateway's member describes it: everything on `main`, its own names. */
const TUYA: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'on', label: 'Switch', value: { type: 'boolean' }, means: 'on' },
    { key: 'power', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' },
    { key: 'energy', label: 'Energy', value: { type: 'number', unit: 'Wh' } },
    { key: 'childLock', label: 'Child lock', value: { type: 'boolean' }, access: 'write' },
    { key: 'countdown', label: 'Countdown', value: { type: 'number', unit: 's' }, access: 'write' },
  ],
};

/** The same plug as Zigbee2MQTT exposes it: an outlet part, its meter on it, Zigbee2MQTT's names. */
const ZIGBEE: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Device', kind: 'device' },
    { id: 'switch', label: 'Output', kind: 'outlet', offers: ['switch'] },
  ],
  attributes: [
    { key: 'switch.on', part: 'switch', label: 'Switch', value: { type: 'boolean' }, means: 'on' },
    { key: 'switch.power', part: 'switch', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' },
    { key: 'switch.energy', part: 'switch', label: 'Energy', value: { type: 'number', unit: 'kWh' } },
    { key: 'child_lock', label: 'Child lock', value: { type: 'boolean' }, access: 'write' },
    { key: 'linkquality', label: 'Linkquality', value: { type: 'number' }, category: 'diagnostic' },
  ],
};

const had = (description: DeviceDescription): AttributeSpec[] => [...description.attributes];

describe('the mapping from what a device was to what it becomes', () => {
  test('parts by what they offer: the plug that switched as a whole becomes the outlet that switches', () => {
    const plan = planRetype(had(TUYA), TUYA, ZIGBEE);
    expect(plan.parts.get(MAIN_PART)).toBe('switch');
  });

  test('attributes by meaning first, then by label, each of a value its history can be read as', () => {
    const plan = planRetype(had(TUYA), TUYA, ZIGBEE);
    const to = (key: string) => plan.attributes.find((move) => move.from.key === key);
    expect(to('on')).toMatchObject({ to: { key: 'switch.on' }, how: 'meaning' });
    expect(to('power')).toMatchObject({ to: { key: 'switch.power' }, how: 'meaning' });
    // Wh to kWh: the same dimension, converted on the way.
    expect(to('energy')).toMatchObject({ to: { key: 'switch.energy' }, how: 'label' });
    expect(to('energy')?.scale).toEqual({ factor: 0.001, offset: 0 });
    expect(to('childLock')).toMatchObject({ to: { key: 'child_lock' }, how: 'label' });
    // Nothing it becomes counts down: its history stays where it is.
    expect(to('countdown')).toMatchObject({ to: null, how: null });
  });

  test('each attribute of what it becomes is taken once', () => {
    const twice: DeviceDescription = { attributes: [...TUYA.attributes, { key: 'power2', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' }] };
    const plan = planRetype(had(twice), twice, ZIGBEE);
    const targets = plan.attributes.flatMap((move) => (move.to ? [move.to.key] : []));
    expect(new Set(targets).size).toBe(targets.length);
  });

  test('a value of another kind is never carried: a number does not become an on/off', () => {
    const odd: DeviceDescription = { attributes: [{ key: 'switch.on', label: 'Switch', value: { type: 'number' } }] };
    const plan = planRetype(had(odd), odd, ZIGBEE);
    expect(plan.attributes[0]?.to).toBeNull();
  });

  test('a device that is the same type in all but name maps onto itself', () => {
    const plan = planRetype(had(ZIGBEE), ZIGBEE, ZIGBEE);
    expect(plan.attributes.every((move) => move.to?.key === move.from.key)).toBe(true);
    expect([...plan.parts].every(([from, to]) => from === to)).toBe(true);
  });
});

describe('moving a device to another type', () => {
  test('one that maps nowhere is set aside where another moves to its key: no two histories merge', () => {
    const db = testDatabase();
    const catalog = new DeviceCatalog(db);
    const history = new HistoryStore(db);
    const before: DeviceDescription = {
      attributes: [
        { key: 'mode', label: 'Mode', value: { type: 'string' } },
        { key: 'state', label: 'Mode', value: { type: 'number' } },
      ],
    };
    const after: DeviceDescription = { attributes: [{ key: 'mode', label: 'Mode', value: { type: 'number' } }] };
    const device = catalog.add({ typeId: 'test.before', name: 'Heater', description: before });
    const at = '2026-01-01T10:00:00.000Z';
    history.addSamples([
      { deviceId: device.id, part: MAIN_PART, key: 'mode', at, value: null, text: 'eco' },
      { deviceId: device.id, part: MAIN_PART, key: 'state', at, value: 3, text: null },
    ]);

    retype({ catalog, history, connections: new ConnectionStore(db, plainSecrets), links: new LinkStore(db), automations: new AutomationStore(db) }, device, { typeId: 'test.after', description: after, config: {}, methods: [] });

    const one = (key: string) => history.samples(device.id, key, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').map((row) => row.value ?? row.text);
    expect(one('mode')).toEqual([3]);
    expect(one('mode~was')).toEqual(['eco']);
    expect(catalog.attributes(device.id).find((attribute) => attribute.key === 'mode~was')?.label).toBe('Mode');
    db.close();
  });
});
