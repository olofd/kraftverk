import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineFunction,
  defineRecipe,
  MAIN_PART,
  savedDeviceId,
  zonedInstant,
  type AuditRecord,
  type DeviceDescription,
  type DeviceReader,
  type DeviceType,
  type Value,
} from '@kraftverk/device-sdk';
import type { CommandIntent, GatewayResult } from '@kraftverk/gateway';
import { LiveBus } from '@kraftverk/holder';

import { closeDb, db } from '../history/db.ts';
import { AutomationEngine, type AutomationRecord, type EngineDevice, type TriggerMemory } from './engine.ts';
import { AutomationLibrary } from './library.ts';
import { AutomationStore } from './store.ts';

/*
  The engine runs rules — whoever wrote them — and the gateway acts: these
  check the deciding, each kind of trigger, and that nothing reaches the
  gateway unless the automation is armed. The gateway's own rules are its own
  tests' business, and the recipes the packages ship are theirs.
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-automations-'));
beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db().exec('DELETE FROM automation');
});

const ZONE = 'Europe/Stockholm';
const FORECAST = savedDeviceId('d-forecast');
const PLUG = savedDeviceId('d-plug');
const STATION = savedDeviceId('d-station');

// --- a package's contribution, as a test kit ------------------------------------

/** What the sky function answers, set by each test. */
const sky: { value: Value; detail: string } = { value: 'sunny', detail: 'Tomorrow looks sunny: 15 % cloud' };

const TURN = { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } } as const;
const SWITCH_ROLE = { label: 'What to switch', description: 'A plug, or an outlet', capabilities: ['switch'] } as const;
const ACTION = { type: 'enum', title: 'Then turn it', default: 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] } as const;

const kit = {
  id: 'test.kit',
  meta: { name: 'Test kit' },
  automation: {
    functions: [
      defineFunction({
        id: 'test.kit.sky',
        label: 'The sky',
        description: 'Sunny or cloudy',
        needs: { capabilities: ['weather.forecast'] },
        args: {},
        returns: { type: 'enum', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },
        evaluate: async ({ part }) => (part.device ? { value: sky.value, detail: sky.detail } : { value: null, detail: `${part.name} is not answering: ${part.offline}` }),
      }),
    ],
    recipes: [
      defineRecipe({
        id: 'test.kit.sunny',
        label: 'Sunny switch',
        description: 'At a time, if it looks sunny, switch',
        sentence: 'At {at}, if it looks {condition} by {forecast}, turn {switch} {action}.',
        roles: { forecast: { label: 'Forecast', description: 'The forecast', capabilities: ['weather.forecast'] }, switch: SWITCH_ROLE },
        params: {
          fields: {
            at: { type: 'string', title: 'When', default: '07:00' },
            condition: { type: 'enum', title: 'If it looks', default: 'sunny', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },
            action: ACTION,
          },
        },
        when: [{ at: { param: 'at' } }],
        if: { compare: 'eq', left: { call: 'test.kit.sky', role: 'forecast' }, right: { param: 'condition' } },
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: TURN } } }],
      }),
      defineRecipe({
        id: 'test.kit.low',
        label: 'Low battery',
        description: 'When the battery stays low, switch',
        roles: { battery: { label: 'Battery', description: 'A battery', capabilities: ['battery'] }, switch: SWITCH_ROLE },
        params: { fields: { below: { type: 'number', title: 'Below', unit: '%', default: 20 }, minutes: { type: 'number', title: 'For', unit: 'min', default: 0 }, action: ACTION } },
        when: [{ becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { param: 'below' } }, heldForMinutes: { param: 'minutes' } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: TURN } } }],
      }),
      defineRecipe({
        id: 'test.kit.mains',
        label: 'Mains lost',
        description: 'When mains is lost, switch',
        roles: { station: { label: 'Mains input', description: 'Mains', capabilities: ['acInput'] }, switch: SWITCH_ROLE },
        params: { fields: { action: { ...ACTION, default: 'off' } } },
        when: [{ event: { role: 'station', event: 'mains.lost' } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: TURN } } }],
      }),
    ],
  },
} as unknown as DeviceType<any>;

// --- devices, as the engine sees them ---------------------------------------------

const PLUG_DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' }],
};
const STATION_DESCRIPTION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device' },
    { id: 'outlet.ac', label: 'AC outlets', kind: 'outlet', offers: ['switch'] },
    { id: 'input.ac', label: 'Mains', kind: 'input' },
  ],
  attributes: [
    { key: 'soc', label: 'Battery', value: { type: 'number', unit: '%' }, quantity: 'percent', means: 'battery.soc' },
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'On', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'input.ac.present', part: 'input.ac', label: 'Mains present', value: { type: 'boolean' }, means: 'grid.present' },
  ],
  events: [{ id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac' }],
};
const FORECAST_DESCRIPTION: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Forecast', kind: 'sensor', offers: ['weather.forecast'] }], attributes: [] };

/** What a function or a condition may see of a device: its readings, its health, its answers. */
const reader = (readings: () => { key: string; value: Value }[]): DeviceReader => ({
  health: () => ({ status: 'connected', detail: 'Fine', lastReadingAt: null }),
  readings: () => readings().map((reading) => ({ ...reading, at: new Date().toISOString() })),
  query: async () => [],
});

/** Trigger state kept as the server keeps it: across engines, as across restarts. */
const keptMemory = (): TriggerMemory & { kept: Map<string, string> } => {
  const kept = new Map<string, string>();
  return {
    kept,
    get: (key) => kept.get(key) ?? null,
    set: (key, value) => void kept.set(key, value),
    forget: (prefix) => [...kept.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => kept.delete(key)),
  };
};

function setup(options: { now?: Date; plugRemoved?: boolean; forecastSession?: boolean; memory?: TriggerMemory } = {}) {
  const sent: CommandIntent[] = [];
  const recorded: AuditRecord[] = [];
  const station = { soc: 50 as Value };
  let now = options.now ?? MORNING;
  const devices: Record<string, EngineDevice> = {
    [`${FORECAST}:main`]: {
      name: 'Weather',
      removed: false,
      hasPart: true,
      part: 'main',
      description: FORECAST_DESCRIPTION,
      device: options.forecastSession === false ? null : reader(() => []),
      offline: 'Not answering',
      capabilities: ['weather.forecast'],
    },
    [`${PLUG}:main`]: { name: 'Heater plug', removed: options.plugRemoved ?? false, hasPart: true, part: 'main', description: PLUG_DESCRIPTION, device: null, offline: 'n/a', capabilities: ['switch'] },
    [`${STATION}:main`]: { name: 'Garage P280', removed: false, hasPart: true, part: 'main', description: STATION_DESCRIPTION, device: reader(() => [{ key: 'soc', value: station.soc }]), offline: 'n/a', capabilities: ['battery'] },
    [`${STATION}:outlet.ac`]: { name: 'Garage P280 — AC outlets', removed: false, hasPart: true, part: 'outlet.ac', description: STATION_DESCRIPTION, device: null, offline: 'n/a', capabilities: ['switch'] },
    [`${STATION}:input.ac`]: { name: 'Garage P280 — Mains', removed: false, hasPart: true, part: 'input.ac', description: STATION_DESCRIPTION, device: null, offline: 'n/a', capabilities: ['acInput'] },
  };
  const store = new AutomationStore();
  const bus = new LiveBus();
  const engine = new AutomationEngine({
    store,
    library: new AutomationLibrary([kit], () => {}),
    device: (binding) => devices[`${binding.device}:${binding.part}`] ?? null,
    gateway: {
      execute: async (intent: CommandIntent): Promise<GatewayResult> => {
        sent.push(intent);
        return { outcome: 'verified', detail: 'Switched, confirmed by the device', deviceAgreed: true };
      },
    },
    record: (entry) => recorded.push(entry),
    bus,
    now: () => now,
    ...(options.memory ? { memory: options.memory } : {}),
  });
  const make = (recipe: string, roles: AutomationRecord['roles'], params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'observe') => {
    const created = store.create({ name: 'Test automation', recipe, roles, params, timeZone: ZONE });
    return mode === 'observe' ? created : store.update(created.id, { mode })!;
  };
  const sunny = (params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'observe', switchPart = { device: PLUG, part: 'main' }) =>
    make('test.kit.sunny', { forecast: { device: FORECAST, part: 'main' }, switch: switchPart }, params, mode);
  const readingsMoved = () => bus.publish({ kind: 'readings', deviceId: STATION, readings: [] });
  return { engine, store, bus, sent, recorded, make, sunny, station, readingsMoved, at: (next: Date) => (now = next) };
}

/** 07:05 in Stockholm on a summer day: after the default run time. */
const MORNING = zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 5 }, ZONE);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('at a time of day', () => {
  test('is due once, at its hour on the owner’s clock, and not long after', async () => {
    const early = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 6, minute: 59 }, ZONE) });
    early.sunny({}, 'armed');
    await early.engine.tick();
    expect(early.sent).toEqual([]);

    const late = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 9, minute: 0 }, ZONE) });
    late.sunny({}, 'armed');
    await late.engine.tick();
    expect(late.sent).toEqual([]);

    db().exec('DELETE FROM automation');
    const { engine, sunny, store, sent } = setup();
    const armed = sunny({}, 'armed');
    const off = sunny({}, 'off');
    await engine.tick();
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(store.get(armed.id)!.lastResult).toMatchObject({ outcome: 'acted' });
    expect(store.get(off.id)!.lastRunAt).toBeNull();
  });

  test('observing, it says what it would have done, with the function’s reason — and sends nothing', async () => {
    const { engine, sunny, sent, recorded } = setup();
    const result = await engine.run(sunny());
    expect(result).toMatchObject({ outcome: 'would-act', summary: 'Would turn Heater plug on. Tomorrow looks sunny: 15 % cloud' });
    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ kind: 'automation.would-act', actor: 'automation:Test automation', resourceKind: 'automation', detail: { device: PLUG } });
  });

  test('armed, it acts through the gateway, as an automation, with its reason', async () => {
    const { engine, sunny, sent } = setup();
    expect((await engine.run(sunny({}, 'armed'))).outcome).toBe('acted');
    expect(sent).toEqual([expect.objectContaining({ deviceId: PLUG, part: 'main', capability: 'switch', command: 'set', args: { on: true }, actor: 'automation', by: 'automation:Test automation' })]);
    expect(sent[0]!.reason).toContain('Tomorrow looks sunny');
  });

  test('a condition not met is idle; one it cannot tell is unknown, and neither acts', async () => {
    const { engine, sunny, sent } = setup();
    sky.value = 'cloudy';
    sky.detail = 'Tomorrow looks cloudy: 90 % cloud';
    expect(await engine.run(sunny({}, 'armed'))).toMatchObject({ outcome: 'idle', summary: 'Tomorrow looks cloudy: 90 % cloud' });
    sky.value = null;
    sky.detail = 'The forecast does not cover tomorrow';
    expect(await engine.run(sunny({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'The forecast does not cover tomorrow' });
    expect(sent).toEqual([]);
    sky.value = 'sunny';
    sky.detail = 'Tomorrow looks sunny: 15 % cloud';

    const silent = setup({ forecastSession: false });
    expect(await silent.engine.run(silent.sunny({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'Weather is not answering: Not answering' });
  });

  test('its settings are its own: a cloudy condition, and turning off', async () => {
    const { engine, sunny, sent } = setup();
    sky.value = 'cloudy';
    expect((await engine.run(sunny({ condition: 'cloudy', action: 'off' }, 'armed'))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ args: { on: false } });
    sky.value = 'sunny';
  });

  test('one outlet of a station fills a role as a plug does; a part that cannot, cannot', async () => {
    const { engine, sunny, sent } = setup();
    expect((await engine.run(sunny({}, 'armed', { device: STATION, part: 'outlet.ac' }))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ deviceId: STATION, part: 'outlet.ac' });
    expect(await engine.run(sunny({}, 'armed', { device: STATION, part: 'input.ac' }))).toMatchObject({ outcome: 'unknown', summary: 'What to switch: Garage P280 — Mains cannot do that' });
  });

  test('a removed device stops it, and says so; a check neither acts nor records', async () => {
    const removed = setup({ plugRemoved: true });
    expect(await removed.engine.run(removed.sunny({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'What to switch: Heater plug has been removed' });

    const { engine, sunny, sent, recorded } = setup();
    expect((await engine.run(sunny({}, 'armed'), { check: true })).outcome).toBe('would-act');
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test('a recipe no installed package has says so', async () => {
    const { engine, make } = setup();
    expect(await engine.run(make('gone.package.recipe', {}))).toMatchObject({ outcome: 'unknown', summary: expect.stringContaining('the package that brought it is not installed') });
  });
});

describe('when a condition becomes true', () => {
  const low = (context: ReturnType<typeof setup>, params: Record<string, number> = {}) =>
    context.make('test.kit.low', { battery: { device: STATION, part: 'main' }, switch: { device: PLUG, part: 'main' } }, { below: 20, minutes: 0, ...params }, 'armed');

  test('fires on the change to true, and not again while it stays so', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved } = context;
    station.soc = 40;
    low(context);
    engine.start();
    try {
      readingsMoved();
      await settle();
      expect(sent).toEqual([]);

      station.soc = 18;
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.reason).toContain('Garage P280: Charge 18 %');

      station.soc = 17;
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  /*
    The owner's charge window, armed while the station already sits at 8 %:
    waiting for a change would wait for ever — nothing charges it, so it never
    rises to fall again. A trigger with nothing kept takes a condition already
    true as its edge.
  */
  test('armed while already true, it acts — once — rather than waiting for a change that will not come', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved } = context;
    station.soc = 8;
    low(context);
    engine.start();
    try {
      readingsMoved();
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  test('its state survives a restart: nothing fires twice, and what turned true meanwhile fires', async () => {
    const memory = keptMemory();
    const first = setup({ memory });
    first.station.soc = 10;
    const automation = low(first);
    await first.engine.tick();
    await settle();
    expect(first.sent).toHaveLength(1);
    first.engine.stop();

    // The same database, a new process: still low, and already dealt with.
    const second = setup({ memory });
    second.station.soc = 10;
    second.bus.subscribe(() => {});
    await second.engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await second.engine.tick();
    await settle();
    expect(second.sent).toEqual([]);

    // Changing it starts it afresh: its condition, already true, is its edge again.
    second.engine.reset(automation.id);
    expect([...memory.kept.keys()].filter((key) => key.includes(automation.id))).toEqual([]);
    await second.engine.tick();
    await settle();
    expect(second.sent).toHaveLength(1);
  });

  test('a hold that was running when the server stopped resumes with the time it had left', async () => {
    const memory = keptMemory();
    const first = setup({ memory });
    first.station.soc = 10;
    const automation = low(first, { minutes: 5 });
    await first.engine.tick();
    expect(first.sent).toEqual([]);
    first.engine.stop();

    // Five minutes later, a new process: it has held long enough, and runs at once.
    const second = setup({ memory, now: new Date(MORNING.getTime() + 5 * 60_000 + 1_000) });
    second.station.soc = 10;
    await second.engine.tick();
    await settle();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.reason).toContain('for 5 min');
    expect(JSON.parse(memory.get(`automation.trigger.${automation.id}:0`)!)).toMatchObject({ last: true, fired: true });
  });

  test('held for a while: only if it stays true that long', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved } = context;
    low(context, { minutes: 0.001 }); // 60 ms
    engine.start();
    try {
      station.soc = 50;
      readingsMoved();
      station.soc = 10;
      readingsMoved();
      station.soc = 50; // back up before the hold ran out
      readingsMoved();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sent).toEqual([]);

      station.soc = 10;
      readingsMoved();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.reason).toContain('for 0.001 min');
    } finally {
      engine.stop();
    }
  });

  test('a check says whether what it waits for holds now', async () => {
    const context = setup();
    const automation = low(context);
    context.station.soc = 63;
    expect((await context.engine.run(automation, { check: true })).summary).toBe("Would turn Heater plug on. Garage P280: Charge 63 %; Garage P280's charge is below 20 %: not now");
    context.station.soc = 12;
    expect((await context.engine.run(automation, { check: true })).summary).toContain("Garage P280: Charge 12 %; Garage P280's charge is below 20 %: yes, now");
  });

  test('unknown — a device gone quiet — is neither a start nor an end', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved } = context;
    low(context);
    engine.start();
    try {
      station.soc = 50;
      readingsMoved();
      station.soc = null;
      readingsMoved();
      station.soc = 50;
      readingsMoved();
      await settle();
      expect(sent).toEqual([]);
    } finally {
      engine.stop();
    }
  });
});

describe('when a device says something happened', () => {
  test('runs on the event it waits for, from the part it was given, and nothing else', async () => {
    const context = setup();
    const { engine, bus, sent, make } = context;
    make('test.kit.mains', { station: { device: STATION, part: 'input.ac' }, switch: { device: PLUG, part: 'main' } }, {}, 'armed');
    engine.start();
    try {
      const event = (id: string, part: string | null) => bus.publish({ kind: 'event', deviceId: STATION, event: { id, level: 'warn', part, data: null, at: new Date().toISOString() } });
      event('mains.restored', 'input.ac');
      event('mains.lost', 'main');
      await settle();
      expect(sent).toEqual([]);

      event('mains.lost', 'input.ac');
      await settle();
      expect(sent).toEqual([expect.objectContaining({ deviceId: PLUG, args: { on: false } })]);
      expect(sent[0]!.reason).toContain('Garage P280 — Mains said: Mains lost');
    } finally {
      engine.stop();
    }
  });

  test('a part that never raises that event cannot fill the role', async () => {
    const { engine, make } = setup();
    const automation = make('test.kit.mains', { station: { device: STATION, part: 'main' }, switch: { device: PLUG, part: 'main' } });
    expect(engine.roleProblems(automation)).toContain('Mains input: Garage P280 cannot do that');
  });
});
