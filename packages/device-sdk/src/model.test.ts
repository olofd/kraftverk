import { describe, expect, test } from 'bun:test';

import type { CommandResult } from './capabilities.ts';
import { capabilitiesOf, deviceCapabilities, MAIN_PART, partsOf, validateDescription, type AttributeReading, type DeviceDescription } from './description.ts';
import { defineDeviceTypeV4, type DeviceContextV4, type DeviceSessionV4, type DeviceTypeV4 } from './device-model.ts';
import { defineDeviceType, type DeviceContext, type DeviceSession } from './device-type.ts';
import { checkDeviceTypeV4Contract } from './testing.ts';
import { asDeviceTypeV4, describeV3, upgradeDeviceType } from './v3.ts';

/*
  The device model, version 4 (docs/ARCHITECTURE.md §8 step 24): a device made
  of parts, with attributes, commands and events — declared by its type, or
  reported by the device itself — and the adapter that lets a version-3 type
  be seen the same way.
*/

// --- a station written against version 4 ---------------------------------------

type Flaws = { undeclaredReading?: boolean; undeclaredEvent?: boolean; stuckOutlet?: boolean; badEnum?: boolean };

const STATION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device', role: 'storage' },
    { id: 'outlet.a', label: 'Outlet A', kind: 'outlet', role: 'load', offers: ['switch'] },
    { id: 'outlet.b', label: 'Outlet B', kind: 'outlet', role: 'load', offers: ['switch'] },
  ],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'battery.soc', category: 'primary' },
    { key: 'mode', label: 'Mode', value: { type: 'enum', options: [{ value: 'idle', label: 'Idle' }, { value: 'charging', label: 'Charging' }] } },
    { key: 'aOn', part: 'outlet.a', label: 'Outlet A', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'aWatts', part: 'outlet.a', label: 'Outlet A draw', value: { type: 'number', unit: 'W' }, means: 'power.draw' },
    { key: 'bOn', part: 'outlet.b', label: 'Outlet B', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'limit', label: 'Charge limit', value: { type: 'number', unit: '%', min: 50, max: 100 }, access: 'write', category: 'config' },
  ],
  events: [{ id: 'overload', label: 'Overload', level: 'warn', part: 'outlet.a', data: { watts: { type: 'number', unit: 'W' } } }],
};

/** A pack plugged in: a part the device reports, with a key derived from the device. */
const withPack = (description: DeviceDescription): DeviceDescription => ({
  ...description,
  parts: [...(description.parts ?? []), { id: 'pack.1', label: 'Pack 1', kind: 'battery', role: 'storage' }],
  attributes: [...description.attributes, { key: 'pack.1.soc', part: 'pack.1', label: 'Pack 1 charge', value: { type: 'number', unit: '%' }, means: 'battery.soc' }],
});

function simulatedStation(ctx: DeviceContextV4, flaws: Flaws): DeviceSessionV4 {
  const state = { soc: 80, aOn: true, bOn: false, limit: 90, packSoc: 60 };
  let at = new Date().toISOString();
  ctx.schedule(10, () => {
    at = new Date().toISOString();
  });
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', owner: 'server', transport: 'sim', lastReadingAt: at }),
    readings: (): AttributeReading[] => [
      { key: 'soc', value: state.soc, at },
      { key: 'mode', value: flaws.badEnum ? 'turbo' : 'idle', at },
      { key: 'aOn', value: state.aOn, at },
      { key: 'aWatts', value: state.aOn ? 120 : 0, at },
      { key: 'bOn', value: state.bOn, at },
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
    close: async () => undefined,
  };
}

const station = (flaws: Flaws = {}): DeviceTypeV4 =>
  defineDeviceTypeV4({
    id: 'example.station',
    apiVersion: '4',
    version: 1,
    kind: 'hardware',
    meta: { name: 'Example station', category: 'power-station', support: 'experimental', icon: 'zap' },
    config: { fields: {} },
    connections: [{ id: 'ble', label: 'Bluetooth', protocol: 'example', transport: 'ble' }],
    describe: () => STATION,
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

  test('a station written against version 4 keeps the contract — its pack reported by the device', async () => {
    expect(await checkDeviceTypeV4Contract(station(), { settleMs: 500 })).toEqual([]);
  });

  test('the contract catches each way a session can break it', async () => {
    const run = async (flaws: Flaws) => checkDeviceTypeV4Contract(station(flaws), { settleMs: 200 });
    expect(await run({ undeclaredReading: true })).toContain('reports "secret", which the description does not have');
    expect(await run({ badEnum: true })).toContain('"mode" is "turbo", which must be one of: idle, charging');
    expect(await run({ stuckOutlet: true })).toContain('outlet.a: switch.set was accepted, but "aOn" never showed the change');
    expect(await run({ undeclaredEvent: true })).toContain('raised event "surprise", which the description does not declare');
  });
});

describe('checking a description', () => {
  const broken = (change: (description: DeviceDescription) => DeviceDescription) => validateDescription(change(STATION), 'example.station');

  test('a sound description has no problems', () => {
    expect(validateDescription(STATION, 'example.station')).toEqual([]);
    expect(validateDescription(withPack(STATION), 'example.station')).toEqual([]);
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

// --- a version-3 station, through the adapter -------------------------------------

function simulatedV3(ctx: DeviceContext): DeviceSession {
  const outlets = { usb: true, ac: false };
  let limit = 90;
  const at = () => new Date().toISOString();
  ctx.schedule(10, () => undefined);
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', owner: 'server', transport: 'sim', lastReadingAt: at() }),
    readings: () => [
      { key: 'soc', value: 70, at: at() },
      { key: 'usbOn', value: outlets.usb, at: at() },
      { key: 'acOn', value: outlets.ac, at: at() },
    ],
    capability: ((name: string) => {
      if (name === 'battery') return { read: () => ({ socPercent: 70, capacityWh: 1000, at: at() }) };
      if (name === 'outlets') {
        return {
          read: () => ({ outlets: [{ id: 'usb', label: 'USB', on: outlets.usb, watts: 0 }, { id: 'ac', label: 'AC', on: outlets.ac, watts: 0 }], at: at() }),
          set: async (id: string, on: boolean) => {
            if (id !== 'usb' && id !== 'ac') return { accepted: false as const, error: 'No such outlet' };
            outlets[id] = on;
            return { accepted: true as const };
          },
        };
      }
      return null;
    }) as DeviceSession['capability'],
    readSettings: () => ({ limit }),
    writeSettings: async (patch) => {
      if (typeof patch.limit === 'number') limit = patch.limit;
      return { limit };
    },
    close: async () => undefined,
  };
}

const v3Station = defineDeviceType({
  id: 'example.oldstation',
  apiVersion: '3',
  kind: 'hardware',
  meta: { name: 'Old station', category: 'power-station', support: 'experimental', icon: 'zap' },
  capabilities: ['battery', 'outlets'],
  telemetry: [
    { key: 'soc', label: 'Charge', unit: '%', kind: 'percent', metric: 'battery.soc', primary: true },
    { key: 'usbOn', label: 'USB', unit: '', kind: 'state', metric: 'outlet.usb.on' },
    { key: 'acOn', label: 'AC', unit: '', kind: 'state', metric: 'outlet.ac.on' },
  ],
  controls: [{ id: 'ac', label: 'AC outlets', kind: 'switch', capability: 'outlets', target: 'ac', measurementKey: 'acOn', consequence: 'Cuts what is plugged in' }],
  settings: { schema: { fields: { limit: { type: 'number', title: 'Charge limit', min: 50, max: 100 } } }, dangerous: ['limit'] },
  config: { fields: {} },
  connections: [{ id: 'ble', label: 'Bluetooth', protocol: 'example', transport: 'ble' }],
  identify: async () => ({ identity: 'example:2', model: 'Old 1', summary: 'It answered.' }),
  createSession: async (ctx) => simulatedV3(ctx),
  createSimulator: async (ctx) => simulatedV3(ctx),
});

describe('a version-3 type, as version 4', () => {
  test('its outlets become parts that switch, and its settings attributes that can be written', () => {
    const description = describeV3(v3Station);
    expect(partsOf(description).map((part) => [part.id, part.label, part.offers ?? []])).toEqual([
      [MAIN_PART, 'Old station', ['battery']],
      ['outlet.usb', 'USB', ['switch']],
      ['outlet.ac', 'AC outlets', ['switch']],
    ]);
    expect(description.attributes.find((attribute) => attribute.key === 'acOn')).toMatchObject({ part: 'outlet.ac', means: 'switch.on', consequence: 'Cuts what is plugged in' });
    expect(description.attributes.find((attribute) => attribute.key === 'limit')).toMatchObject({ access: 'write', category: 'config', dangerous: true });
    expect(validateDescription(description, v3Station.id)).toEqual([]);
  });

  test('it keeps the version-4 contract: a command to an outlet part reaches the old outlets capability', async () => {
    expect(await checkDeviceTypeV4Contract(upgradeDeviceType(v3Station), { settleMs: 500 })).toEqual([]);
  });

  test('a version-4 type is left as it is', () => {
    const native = station();
    expect(asDeviceTypeV4(native)).toBe(native);
  });
});
