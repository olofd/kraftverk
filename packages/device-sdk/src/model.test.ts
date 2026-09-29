import { describe, expect, test } from 'bun:test';

import type { CommandResult } from './capabilities.ts';
import { capabilitiesOf, currentForOf, deviceCapabilities, isCurrent, MAIN_PART, partIcon, partsOf, validateDescription, type DeviceDescription, type Reading } from './description.ts';
import { defineDeviceType, type DeviceContext, type DeviceSession, type DeviceType } from './device-type.ts';
import { checkDeviceTypeContract } from './testing.ts';

/*
  The device model (docs/ARCHITECTURE.md §4.5): a device made of parts, with
  attributes, commands and events — declared by its type, or reported by the
  device itself.
*/

// --- a station with outlets, a setting, an event, and a pack it reports itself ----

type Flaws = { undeclaredReading?: boolean; undeclaredEvent?: boolean; stuckOutlet?: boolean; badEnum?: boolean; oldReading?: boolean; badTool?: boolean; undeclaredTool?: boolean };

const STATION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device', energy: { role: 'storage' } },
    { id: 'outlet.a', label: 'Outlet A', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] },
    { id: 'outlet.b', label: 'Outlet B', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] },
  ],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'battery.soc', category: 'primary' },
    { key: 'mode', label: 'Mode', value: { type: 'enum', options: [{ value: 'idle', label: 'Idle' }, { value: 'charging', label: 'Charging' }] } },
    { key: 'outlet.a.on', part: 'outlet.a', label: 'Outlet A', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'outlet.a.watts', part: 'outlet.a', label: 'Outlet A draw', value: { type: 'number', unit: 'W' }, means: 'power.draw' },
    { key: 'outlet.b.on', part: 'outlet.b', label: 'Outlet B', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'limit', label: 'Charge limit', value: { type: 'number', unit: '%', min: 50, max: 100 }, access: 'write', category: 'config' },
  ],
  events: [{ id: 'overload', label: 'Overload', level: 'warn', part: 'outlet.a', data: { watts: { type: 'number', unit: 'W' } } }],
};

/** A pack plugged in: a part the device reports, with a key derived from the device. */
const withPack = (description: DeviceDescription): DeviceDescription => ({
  ...description,
  parts: [...(description.parts ?? []), { id: 'pack.1', label: 'Pack 1', kind: 'battery', energy: { role: 'storage' } }],
  attributes: [...description.attributes, { key: 'pack.1.soc', part: 'pack.1', label: 'Pack 1 charge', value: { type: 'number', unit: '%' }, means: 'battery.soc' }],
});

function simulatedStation(ctx: DeviceContext, flaws: Flaws): DeviceSession {
  const state = { soc: 80, aOn: true, bOn: false, limit: 90, packSoc: 60 };
  let at = new Date().toISOString();
  ctx.schedule(10, () => {
    at = new Date().toISOString();
  });
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    readings: (): Reading[] => [
      // A reading carries when it was observed: one from an hour ago is not current, whatever it is about.
      { key: 'soc', value: state.soc, at: flaws.oldReading ? new Date(Date.now() - 3_600_000).toISOString() : at },
      { key: 'mode', value: flaws.badEnum ? 'turbo' : 'idle', at },
      { key: 'outlet.a.on', value: state.aOn, at },
      { key: 'outlet.a.watts', value: state.aOn ? 120 : 0, at },
      { key: 'outlet.b.on', value: state.bOn, at },
      { key: 'limit', value: state.limit, at },
      { key: 'pack.1.soc', value: state.packSoc, at },
      ...(flaws.undeclaredReading ? [{ key: 'secret', value: 1, at }] : []),
    ],
    description: () => withPack(STATION),
    info: () => ({ manufacturer: 'Example', model: 'Station 1', firmware: { main: '1.4.2', bms: '2.0' } }),
    async command(request): Promise<CommandResult> {
      if (request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'Unknown command' };
      if (request.part === 'outlet.a' && !flaws.stuckOutlet) state.aOn = request.args.on;
      else if (request.part === 'outlet.b') state.bOn = request.args.on;
      else if (request.part !== 'outlet.a') return { accepted: false, error: 'No such outlet' };
      if (request.args.on) ctx.event(flaws.undeclaredEvent ? 'surprise' : 'overload', { watts: 1200 }, request.part);
      return { accepted: true };
    },
    async write(patch) {
      if (typeof patch.limit === 'number') state.limit = patch.limit;
      return { limit: state.limit };
    },
    tools: {
      cells: async () => (flaws.badTool ? { cells: ['3.3 V'] } : { cells: [3.31, 3.3, 3.32] }),
      ...(flaws.undeclaredTool ? { secretDump: async () => null } : {}),
    },
    close: async () => undefined,
  };
}

const station = (flaws: Flaws = {}): DeviceType =>
  defineDeviceType({
    id: 'example.station',
    kind: 'hardware',
    meta: { name: 'Example station', category: 'power-station', support: 'experimental', icon: 'zap' },
    config: { fields: {} },
    connections: [{ id: 'ble', label: 'Bluetooth', protocol: 'example', transport: 'ble', reach: 'local' }],
    describe: () => STATION,
    tools: {
      cells: {
        label: 'Cells',
        description: 'Each cell’s voltage.',
        writes: false,
        answer: { type: 'object', fields: { cells: { type: 'list', of: { type: 'number', unit: 'V' } } }, required: ['cells'] },
      },
    },
    identify: async () => ({ identity: 'example:1', model: 'Station 1', summary: 'It answered.', info: { model: 'Station 1' } }),
    createSession: async (ctx) => simulatedStation(ctx, flaws),
    createSimulator: async (ctx) => simulatedStation(ctx, flaws),
  });

describe('a device made of parts', () => {
  test('a part offers the capabilities its attributes mean, and those it takes commands for', () => {
    expect(capabilitiesOf(STATION, MAIN_PART)).toEqual(['battery']);
    expect(capabilitiesOf(STATION, 'outlet.a')).toEqual(['switch', 'powerMeter']);
    // It reports its state, but says nothing of switching it: so no switch.
    expect(capabilitiesOf({ attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' }] }, MAIN_PART)).toEqual([]);
    expect(deviceCapabilities(STATION)).toEqual(['battery', 'switch', 'powerMeter']);
  });

  test('main is always a part, first, whether declared or not', () => {
    expect(partsOf({ attributes: [] }, 'Plug').map((part) => [part.id, part.label])).toEqual([[MAIN_PART, 'Plug']]);
    expect(partsOf(STATION)[0]!.id).toBe(MAIN_PART);
  });

  test('a station keeps the contract — its pack reported by the device itself', async () => {
    expect(await checkDeviceTypeContract(station(), { settleMs: 500 })).toEqual([]);
  });

  test('the contract catches each way a session can break it', async () => {
    const run = async (flaws: Flaws) => checkDeviceTypeContract(station(flaws), { settleMs: 200 });
    expect(await run({ undeclaredReading: true })).toContain('reports "secret", which the description does not have');
    expect(await run({ badEnum: true })).toContain('"mode" is "turbo", which must be one of: idle, charging');
    expect(await run({ stuckOutlet: true })).toContain('outlet.a: switch.set was accepted, but "outlet.a.on" never showed the change');
    expect(await run({ undeclaredEvent: true })).toContain('raised event "surprise", which the description does not declare');
    expect((await run({ oldReading: true })).join()).toContain('"soc" was observed at');
    expect(await run({ badTool: true })).toContain('tool "cells" answered something else: its answer .cells[0] must be a number');
    expect(await run({ undeclaredTool: true })).toContain('runs a tool "secretDump", which its type does not declare');
  });
});

describe('checking a description', () => {
  const broken = (change: (description: DeviceDescription) => DeviceDescription) => validateDescription(change(STATION), 'example.station');

  test('a sound description has no problems', () => {
    expect(validateDescription(STATION, 'example.station')).toEqual([]);
    expect(validateDescription(withPack(STATION), 'example.station')).toEqual([]);
  });

  test('a key off main begins with its part, and a key on main never with another part', () => {
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, { key: 'bWatts', part: 'outlet.b', label: 'B draw', value: { type: 'number', unit: 'W' }, means: 'power.draw' }] }))).toContain(
      'attribute "bWatts" is on "outlet.b", so its key begins "outlet.b.": "outlet.b.bWatts"'
    );
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, { key: 'outlet.b.volts', label: 'Volts', value: { type: 'number', unit: 'V' } }] }))).toContain(
      'attribute "outlet.b.volts" is on main, but its key begins with the part "outlet.b"'
    );
  });

  test('a part is a kind from the list, or one of the type’s own with an icon', () => {
    expect(partIcon({ kind: 'outlet' })).toBe('power');
    expect(partIcon({ kind: 'example.hopper', icon: 'package' })).toBe('package');
    expect(broken((d) => ({ ...d, parts: [...(d.parts ?? []), { id: 'hopper', label: 'Hopper', kind: 'example.hopper' }] }))).toContain(
      'part "hopper" is a kind of the type\'s own, "example.hopper", and needs an icon'
    );
    expect(broken((d) => ({ ...d, parts: [...(d.parts ?? []), { id: 'hopper', label: 'Hopper', kind: 'hopper' as never }] }))[0]).toContain('is a "hopper", which is not a kind');
  });

  test('a capability of the type’s own is namespaced by it, offered like any other', () => {
    const lock: DeviceDescription = {
      ...STATION,
      capabilities: {
        'example.station.childLock': {
          label: 'Child lock',
          attributes: { on: { means: 'switch.on', required: true } },
          commands: { set: { description: 'Lock the buttons', args: { on: { type: 'boolean' } }, sets: { on: 'on' } } },
          queries: {},
        },
      },
      parts: [...(STATION.parts ?? []), { id: 'buttons', label: 'Buttons', kind: 'button', offers: ['example.station.childLock'] }],
      attributes: [...STATION.attributes, { key: 'buttons.locked', part: 'buttons', label: 'Locked', value: { type: 'boolean' }, means: 'switch.on' }],
    };
    expect(validateDescription(lock, 'example.station')).toEqual([]);
    expect(capabilitiesOf(lock, 'buttons')).toEqual(['example.station.childLock']);
    const misnamed = { ...lock, capabilities: { 'acme.childLock': lock.capabilities!['example.station.childLock']! } };
    expect(validateDescription(misnamed, 'example.station')).toContain('capability "acme.childLock" must be namespaced by the type: "example.station.something"');
  });

  test('how long a value stays current: declared, or from its state class', () => {
    const power = { value: { type: 'number' as const }, stateClass: 'measurement' as const };
    const meter = { value: { type: 'number' as const }, stateClass: 'total_increasing' as const };
    const forecast = { value: { type: 'number' as const }, currentFor: 3_600_000 };
    expect(currentForOf(power)).toBe(120_000);
    expect(currentForOf(meter)).toBe(3_600_000);
    const now = Date.parse('2026-09-29T12:00:00Z');
    const at = '2026-09-29T11:30:00Z';
    expect(isCurrent(power, { at, value: 1 }, now)).toBe(false);
    expect(isCurrent(forecast, { at, value: 1 }, now)).toBe(true);
    expect(isCurrent(forecast, { at, value: null }, now)).toBe(false);
  });

  test('each mistake is named', () => {
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, d.attributes[0]!] }))).toContain('attribute "soc" is declared twice');
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, { key: 'x', part: 'nowhere', label: 'X', value: { type: 'boolean' } }] }))).toContain(
      'attribute "x" belongs to "nowhere", which is not a part'
    );
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, { key: 'kw', label: 'Power', value: { type: 'number', unit: 'kW' }, means: 'power.draw' }] }))).toContain(
      'attribute "kw" means power.draw, which is power in "W"'
    );
    expect(broken((d) => ({ ...d, parts: [...(d.parts ?? []), { id: 'outlet.c', label: 'C', kind: 'outlet', offers: ['switch'] }] }))).toContain(
      'part "outlet.c" offers "switch", which needs an attribute meaning "switch.on"'
    );
    expect(broken((d) => ({ ...d, attributes: d.attributes.map((a) => (a.key === 'mode' ? { ...a, dangerous: true } : a)) }))).toContain(
      "attribute \"mode\" is dangerous but cannot be written; a command's danger is its capability's"
    );
    expect(broken((d) => ({ ...d, attributes: d.attributes.map((a) => (a.key === 'mode' ? { ...a, category: 'primary' } : a)) }))).toContain(
      'part "main" has 2 primary attributes; one leads its card'
    );
    expect(broken((d) => ({ ...d, attributes: [...d.attributes, { key: 'own', label: 'Own', value: { type: 'number' }, means: 'power.own' }] }))).toContain(
      'attribute "own" means "power.own", which is not a standard meaning; a type\'s own are namespaced by the type, like "station.own"'
    );
  });
});
