import { beforeEach, describe, expect, test } from 'bun:test';

import { defineFunction, defineRecipe, inlineParams } from '@kraftverk/automation';
import { MAIN_PART, REAL_CLOCK, savedDeviceId, zonedInstant, type AuditRecord, type DeviceDescription, type DeviceReader, type Value } from '@kraftverk/device-sdk';
import { memoryLedger, type CommandIntent, type GatewayResult, type WriteIntent } from '@kraftverk/gateway';
import { LiveBus } from '@kraftverk/holder';

import { AutomationEngine, type AutomationRecord, type EngineDevice, AutomationLibrary } from '@kraftverk/automation-engine';
import { AutomationStore, type SqlDatabase } from '@kraftverk/store';

import { testDatabase } from './home.ts';

/*
  The engine runs rules — whoever wrote them — and the gateway acts: these
  check the deciding, each kind of trigger, and that nothing reaches the
  gateway unless the automation is let act. The gateway's own rules are its
  own tests' business, and the recipes the packages ship are theirs.

  Here, not in the engine's package: they run the engine over the real
  store — its foreign keys, its transactions, a run kept at every step —
  which only a package above both can, and the hub is the one that puts
  them together. A store of the tests' own would test a store nobody runs.
*/

let db: SqlDatabase;
beforeEach(() => {
  db = testDatabase();
  // The devices its roles name, as the catalog keeps them: a role names a device that exists.
  const insert = db.query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES (?1, ?1, 'test.device', ?2, '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')");
  for (const [id, name] of [
    ['d-forecast', 'Weather'],
    ['d-plug', 'Heater plug'],
    ['d-station', 'Garage P280'],
  ] as const) insert.run(id, name);
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
        params: { fields: { below: { type: 'number', title: 'Below', unit: '%', default: 20 }, heldFor: { type: 'number', title: 'For', unit: 's', default: 0 }, action: ACTION } },
        when: [{ becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { param: 'below' } }, heldFor: { param: 'heldFor' } }],
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
      defineRecipe({
        id: 'test.kit.dark',
        label: 'Dark when charged',
        description: 'When the battery is charged, the plug’s light off',
        roles: { battery: { label: 'Battery', description: 'A battery', capabilities: ['battery'] }, plug: { label: 'Plug', description: 'A plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ becomes: { compare: 'ge', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { value: 50 } } }],
        then: [{ write: { role: 'plug', key: 'light', value: { value: false } } }],
      }),
    ],
  },
};

// --- devices, as the engine sees them ---------------------------------------------

const PLUG_DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'light', label: 'Indicator light', value: { type: 'boolean' }, access: 'write', category: 'config' },
  ],
};
/** The kit as installed: what it brings to automations, and whose it is. */
const KIT = [{ contribution: kit.automation, from: { typeId: kit.id, name: kit.meta.name } }];
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
    { key: 'acLimit', label: 'AC charge limit', value: { type: 'number', unit: '%', min: 60, max: 100 }, means: 'battery.chargeLimit', access: 'write', category: 'config' },
  ],
  events: [{ id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac' }],
};
const FORECAST_DESCRIPTION: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Forecast', kind: 'sensor', offers: ['weather.forecast'] }], attributes: [] };

/** What a function or a condition may see of a device: its readings, its health, its answers. */
const reader = (readings: () => { key: string; value: Value }[], clock: () => Date = () => new Date()): DeviceReader => ({
  health: () => ({ status: 'connected', detail: 'Fine', lastReadingAt: null }),
  readings: () => readings().map((reading) => ({ ...reading, at: clock().toISOString() })),
  query: async () => [],
});

/** A device as the engine sees it: reachable when it has a session, and asked for nothing more. */
const asEngineDevice = (device: Omit<EngineDevice, 'reachable' | 'wantFresh' | 'deviceName' | 'typeId'>): EngineDevice => ({
  deviceName: device.name,
  typeId: 'test.device',
  ...device,
  reachable: () => ({ reachable: device.device !== null, detail: device.offline }),
  wantFresh: () => {},
});

/** Two engines on one database are one server, restarted: what they keep is in the store. */
/** `gate`: what a command waits on once sent — a run that takes its time. */
function setup(options: { now?: Date; plugRemoved?: boolean; forecastSession?: boolean; gate?: () => Promise<void> } = {}) {
  const sent: CommandIntent[] = [];
  const written: WriteIntent[] = [];
  const recorded: AuditRecord[] = [];
  /** The gateway's memory: who last switched each part, and wrote each setting. */
  const ledger = memoryLedger();
  const station = { soc: 50 as Value };
  /** Whether the plug is on, as it reports it: unknown until a test says; and its light. */
  const plug = { on: null as Value, light: true as Value };
  let now = options.now ?? MORNING;
  const devices: Record<string, EngineDevice> = Object.fromEntries(Object.entries({
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
    [`${PLUG}:main`]: { name: 'Heater plug', removed: options.plugRemoved ?? false, hasPart: true, part: 'main', description: PLUG_DESCRIPTION, device: reader(() => (plug.on === null ? [] : [{ key: 'on', value: plug.on }, { key: 'light', value: plug.light }]), () => now), offline: 'n/a', capabilities: ['switch'] },
    [`${STATION}:main`]: { name: 'Garage P280', removed: false, hasPart: true, part: 'main', description: STATION_DESCRIPTION, device: reader(() => [{ key: 'soc', value: station.soc }], () => now), offline: 'n/a', capabilities: ['battery'] },
    [`${STATION}:outlet.ac`]: { name: 'Garage P280 — AC outlets', removed: false, hasPart: true, part: 'outlet.ac', description: STATION_DESCRIPTION, device: null, offline: 'n/a', capabilities: ['switch'] },
    [`${STATION}:input.ac`]: { name: 'Garage P280 — Mains', removed: false, hasPart: true, part: 'input.ac', description: STATION_DESCRIPTION, device: null, offline: 'n/a', capabilities: ['acInput'] },
  } satisfies Record<string, Omit<EngineDevice, 'reachable' | 'wantFresh' | 'deviceName' | 'typeId'>>).map(([key, device]) => [key, asEngineDevice(device)]));
  const store = new AutomationStore(db);
  const bus = new LiveBus();
  const engine = new AutomationEngine({
    store,
    library: new AutomationLibrary(KIT, () => {}),
    device: (binding) => devices[`${binding.device}:${binding.part}`] ?? null,
    gateway: {
      execute: async (intent: CommandIntent): Promise<GatewayResult> => {
        sent.push(intent);
        await options.gate?.();
        ledger.switched(intent.deviceId, intent.part, { at: now.getTime(), by: intent.by });
        // The plug does as it is told, and reports it.
        if (intent.deviceId === PLUG && typeof intent.args.on === 'boolean') plug.on = intent.args.on;
        return { outcome: 'verified', detail: 'Switched, confirmed by the device', deviceAgreed: true };
      },
      write: async (intent: WriteIntent) => {
        written.push(intent);
        for (const key of Object.keys(intent.patch)) ledger.wrote(intent.deviceId, key, { at: now.getTime(), by: intent.by });
        if (intent.deviceId === PLUG && typeof intent.patch.light === 'boolean') plug.light = intent.patch.light;
        return { outcome: 'verified', detail: 'Changed, confirmed by the device' };
      },
      runEnded: () => {},
      lastSwitch: (device, part) => ledger.lastSwitch(device, part),
      lastWrite: (device, attribute) => ledger.lastWrite(device, attribute),
    },
    record: (entry) => recorded.push(entry),
    bus,
    // A fixed time the test moves on, with real timers.
    clock: { ...REAL_CLOCK, now: () => now.getTime() },
  });
  const library = new AutomationLibrary(KIT, () => {});
  /** An automation copied from one of the kit's recipes, its settings written into its blocks — as the app makes one. */
  const make = (recipe: string, roles: AutomationRecord['roles'], params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'watch', recheckMinutes: number | null = null) => {
    const { id: _id, label: _label, description: _description, sentence: _sentence, ...rule } = library.recipe(recipe)!;
    const created = store.create({ name: 'Test automation', rule: inlineParams(rule, params), madeFrom: recipe, roles, starts: {}, timeZone: ZONE, recheckMinutes });
    return mode === 'watch' ? created : store.update(created.id, { mode })!;
  };
  const sunny = (params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'watch', switchPart = { device: PLUG, part: 'main' }) =>
    make('test.kit.sunny', { forecast: { device: FORECAST, part: 'main' }, switch: switchPart }, params, mode);
  const readingsMoved = () => bus.publish({ kind: 'readings', deviceId: STATION, readings: [] });
  return { engine, store, bus, sent, written, recorded, ledger, make, sunny, station, plug, readingsMoved, at: (next: Date) => (now = next), now: () => now };
}

/** 07:05 in Stockholm on a summer day: after the default run time. */
const MORNING = zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 5 }, ZONE);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('at a time of day', () => {
  test('is due once, at its hour on the owner’s clock, and not long after', async () => {
    const early = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 6, minute: 59 }, ZONE) });
    early.sunny({}, 'act');
    await early.engine.tick();
    expect(early.sent).toEqual([]);

    const late = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 9, minute: 0 }, ZONE) });
    late.sunny({}, 'act');
    await late.engine.tick();
    expect(late.sent).toEqual([]);

    db.exec('DELETE FROM automation');
    const { engine, sunny, store, sent } = setup();
    const armed = sunny({}, 'act');
    const off = sunny({}, 'off');
    await engine.tick();
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(store.get(armed.id)!.lastRun).toMatchObject({ outcome: 'acted' });
    expect(store.get(off.id)!.lastRun).toBeNull();
  });

  test('late by less than its grace across midnight: 23:30’s, with the server back at 00:05, still runs', async () => {
    const context = setup({ now: zonedInstant({ year: 2026, month: 6, day: 16, hour: 0, minute: 5 }, ZONE) });
    context.sunny({ at: '23:30' }, 'act');
    await context.engine.tick();
    expect(context.sent).toHaveLength(1);
    await context.engine.tick();
    expect(context.sent).toHaveLength(1);
  });

  test('only on its days, on the owner’s calendar — and says so as why it ran', async () => {
    // 15 June 2026 is a Monday in Stockholm.
    const { engine, store, sent } = setup();
    const at = (days: readonly ('mon' | 'sat' | 'sun')[]) =>
      store.update(
        store.create({
          name: `On ${days.join(' ')}`,
          rule: {
            roles: { switch: { label: 'Switch', description: 'A switch', capabilities: ['switch'] } },
            params: { fields: {} },
            when: [{ at: { value: '07:00' }, days }],
            then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
          },
          madeFrom: null,
          roles: { switch: { device: PLUG, part: 'main' } },
          starts: {},
          timeZone: ZONE,
          recheckMinutes: null,
        }).id,
        { mode: 'act' }
      )!;
    const weekend = at(['sat', 'sun']);
    const monday = at(['mon']);
    await engine.tick();
    expect(store.get(weekend.id)!.lastRun).toBeNull();
    expect(store.get(monday.id)!.lastRun).toMatchObject({ outcome: 'acted', why: 'At 07:00 on Mon' });
    expect(sent).toHaveLength(1);
  });

  test('observing, it says what it would have done, with the function’s reason — and sends nothing', async () => {
    const { engine, sunny, sent, recorded } = setup();
    const result = await engine.run(sunny());
    expect(result).toMatchObject({
      outcome: 'would-act',
      summary: 'Would turn Heater plug on',
      // Why, what it read — the function's own words — and what it would have done, each on its own.
      why: 'As it was set up to',
      saw: ['Tomorrow looks sunny: 15 % cloud'],
      steps: [{ kind: 'command', depth: 0, what: 'Turn Heater plug on', outcome: 'would', detail: '' }],
    });
    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ kind: 'automation.would-act', actor: 'automation:Test automation', resourceKind: 'automation', detail: { device: PLUG } });
  });

  test('what it would do says what is already so, as it stands now', async () => {
    const { engine, sunny, plug } = setup();
    plug.on = true;
    expect(await engine.run(sunny(), { check: true })).toMatchObject({
      summary: 'Would turn Heater plug on (already so)',
      steps: [{ what: 'Turn Heater plug on', outcome: 'already', detail: 'It is so now' }],
    });
  });

  test('armed, it acts through the gateway, as an automation, with its reason', async () => {
    const { engine, sunny, sent } = setup();
    const automation = sunny({}, 'act');
    expect((await engine.run(automation)).outcome).toBe('acted');
    // Named by its id, which a rename does not change: how keeping things so tells its own switches from another's.
    expect(sent).toEqual([expect.objectContaining({ deviceId: PLUG, part: 'main', capability: 'switch', command: 'set', args: { on: true }, actor: 'automation', by: `automation:${automation.id}` })]);
    expect(sent[0]!.reason).toContain('Tomorrow looks sunny');
  });

  test('deleted while it ran, its run goes with it: nothing is kept or on the timeline, and nothing throws', async () => {
    const { engine, store, sunny, recorded } = setup();
    const automation = sunny({}, 'act');
    store.delete(automation.id);
    expect(await engine.run(automation)).toMatchObject({ outcome: 'acted', id: null });
    expect(store.runs(automation.id)).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test('a condition not met is idle; one it cannot tell is unknown, and neither acts', async () => {
    const { engine, sunny, sent } = setup();
    sky.value = 'cloudy';
    sky.detail = 'Tomorrow looks cloudy: 90 % cloud';
    expect(await engine.run(sunny({}, 'act'))).toMatchObject({ outcome: 'idle', summary: 'Tomorrow looks cloudy: 90 % cloud' });
    sky.value = null;
    sky.detail = 'The forecast does not cover tomorrow';
    expect(await engine.run(sunny({}, 'act'))).toMatchObject({ outcome: 'unknown', summary: 'The forecast does not cover tomorrow' });
    expect(sent).toEqual([]);
    sky.value = 'sunny';
    sky.detail = 'Tomorrow looks sunny: 15 % cloud';

    const silent = setup({ forecastSession: false });
    expect(await silent.engine.run(silent.sunny({}, 'act'))).toMatchObject({ outcome: 'unknown', summary: 'Weather is not answering: Not answering' });
  });

  test('its settings are its own: a cloudy condition, and turning off', async () => {
    const { engine, sunny, sent } = setup();
    sky.value = 'cloudy';
    expect((await engine.run(sunny({ condition: 'cloudy', action: 'off' }, 'act'))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ args: { on: false } });
    sky.value = 'sunny';
  });

  test('one outlet of a station fills a role as a plug does; a part that cannot, cannot', async () => {
    const { engine, sunny, sent } = setup();
    expect((await engine.run(sunny({}, 'act', { device: STATION, part: 'outlet.ac' }))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ deviceId: STATION, part: 'outlet.ac' });
    expect(await engine.run(sunny({}, 'act', { device: STATION, part: 'input.ac' }))).toMatchObject({ outcome: 'unknown', summary: 'What to switch: Garage P280 — Mains cannot do that' });
  });

  test('a removed device stops it, and says so; a check neither acts nor records', async () => {
    const removed = setup({ plugRemoved: true });
    expect(await removed.engine.run(removed.sunny({}, 'act'))).toMatchObject({ outcome: 'unknown', summary: 'What to switch: Heater plug has been removed' });

    const { engine, sunny, sent, recorded } = setup();
    expect((await engine.run(sunny({}, 'act'), { check: true })).outcome).toBe('would-act');
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test('it owns its rule: the recipe it was copied from is not needed to run it', async () => {
    const { store, make, sent } = setup();
    const low = make('test.kit.low', { battery: { device: STATION, part: 'main' }, switch: { device: PLUG, part: 'main' } }, { below: 60, heldFor: 0 }, 'act');
    // A server whose packages no longer ship that recipe: the automation runs as it was built.
    const bare = new AutomationEngine({
      store,
      library: new AutomationLibrary([], () => {}),
      device: () => null,
      gateway: { execute: async () => ({ outcome: 'verified', detail: 'x', deviceAgreed: true }), write: async () => ({ outcome: 'verified', detail: 'x' }), runEnded: () => {}, lastSwitch: () => null, lastWrite: () => null },
      record: () => {},
    });
    expect(bare.steps(low).steps.map((line) => line.text)).toEqual(['Turn a device you no longer have on']);
    expect(low.rule.params).toEqual({ fields: {} });
    expect(sent).toEqual([]);
  });
});

describe('when a condition becomes true', () => {
  const low = (context: ReturnType<typeof setup>, params: Record<string, number> = {}) =>
    context.make('test.kit.low', { battery: { device: STATION, part: 'main' }, switch: { device: PLUG, part: 'main' } }, { below: 20, heldFor: 0, ...params }, 'act');

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

  test('let act while its condition holds, it acts at once, not at the next reading', async () => {
    const context = setup();
    const { engine, station, sent } = context;
    station.soc = 8;
    const automation = low(context);
    engine.poke(automation.id);
    await settle();
    expect(sent).toHaveLength(1);
    // Looked at again, nothing new: once.
    engine.poke(automation.id);
    await settle();
    expect(sent).toHaveLength(1);
  });

  test('its state survives a restart: nothing fires twice, and what turned true meanwhile fires', async () => {
    const first = setup();
    first.station.soc = 10;
    const automation = low(first);
    await first.engine.tick();
    await settle();
    expect(first.sent).toHaveLength(1);
    first.engine.stop();

    // The same database, a new process: still low, and already dealt with.
    const second = setup();
    second.station.soc = 10;
    second.bus.subscribe(() => {});
    await second.engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await second.engine.tick();
    await settle();
    expect(second.sent).toEqual([]);

    // Changing it starts it afresh: its condition, already true, is its edge again.
    second.engine.reset(automation.id);
    // What its triggers saw is forgotten; when it changed is kept: what keeping things so counts from.
    expect(second.store.trigger(automation.id, '#0')).toBeNull();
    expect(second.store.get(automation.id)!.lookedAt).not.toBeNull();
    await second.engine.tick();
    await settle();
    expect(second.sent).toHaveLength(1);
  });

  test('a hold that was running when the server stopped resumes with the time it had left', async () => {
    const first = setup();
    first.station.soc = 10;
    const automation = low(first, { heldFor: 300 });
    await first.engine.tick();
    expect(first.sent).toEqual([]);
    first.engine.stop();

    // Five minutes later, a new process: it has held long enough, and runs at once.
    const second = setup({ now: new Date(MORNING.getTime() + 5 * 60_000 + 1_000) });
    second.station.soc = 10;
    await second.engine.tick();
    await settle();
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.reason).toContain('for 5 min');
    expect(second.store.trigger(automation.id, '#0')).toMatchObject({ last: true, fired: true });
  });

  test('turned true again while its run still takes its steps: run again once that run ends, not lost', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const context = setup({ gate: () => slow });
    const { engine, station, sent, readingsMoved } = context;
    station.soc = 40;
    low(context);
    engine.start();
    try {
      readingsMoved();
      station.soc = 18;
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(1);
      // Up, and down again, while the first run waits on its command.
      station.soc = 40;
      readingsMoved();
      station.soc = 17;
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(1);
      // The run ends; the condition still holds, and was never dealt with.
      release();
      await settle();
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(2);
      readingsMoved();
      await settle();
      expect(sent).toHaveLength(2);
    } finally {
      engine.stop();
    }
  });

  test('a hold waiting when it is turned off does nothing when it runs out', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved, store } = context;
    const automation = low(context, { heldFor: 0.06 }); // 60 ms
    engine.start();
    try {
      station.soc = 10;
      readingsMoved();
      store.update(automation.id, { mode: 'off' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sent).toEqual([]);
    } finally {
      engine.stop();
    }
  });

  test('held for a while: only if it stays true that long', async () => {
    const context = setup();
    const { engine, station, sent, readingsMoved } = context;
    low(context, { heldFor: 0.06 }); // 60 ms
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
      // Under a second, said in whole seconds.
      expect(sent[0]!.reason).toContain(', for 0 s');
    } finally {
      engine.stop();
    }
  });

  test('a check says whether what it waits for holds now', async () => {
    const context = setup();
    const automation = low(context);
    context.station.soc = 63;
    expect(await context.engine.run(automation, { check: true })).toMatchObject({
      summary: 'Would turn Heater plug on',
      why: 'Asked what it would do now',
      saw: ['Garage P280: Charge 63 %'],
      conditions: [{ text: "Garage P280’s charge is below 20 %", holds: false }],
    });
    context.station.soc = 12;
    expect((await context.engine.run(automation, { check: true })).conditions).toEqual([{ text: "Garage P280’s charge is below 20 %", holds: true }]);
    // And as the card shows it, now.
    expect(context.engine.judge(automation)).toEqual({ conditions: [{ text: "Garage P280’s charge is below 20 %", holds: true }], saw: ['Garage P280: Charge 12 %'] });
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

/*
  A setting named by its standard meaning — as a recipe names one — is the
  bound part's own setting with that meaning, written by its key.
*/
describe('a setting by what it means', () => {
  test('is written as the station calls it, and reads as it does', async () => {
    const { engine, store, written } = setup();
    const created = store.create({
      name: 'Charge to 80 %',
      rule: { roles: { station: { label: 'Station', description: 'A station', capabilities: ['battery'] } }, params: { fields: {} }, when: [], then: [{ write: { role: 'station', means: 'battery.chargeLimit', value: { value: 80 } } }] },
      madeFrom: null,
      roles: { station: { device: STATION, part: 'main' } },
      starts: {},
      timeZone: ZONE,
      recheckMinutes: null,
    });
    const automation = store.update(created.id, { mode: 'act' })!;
    expect(engine.steps(automation).steps.map((line) => line.text)).toEqual(['Set Garage P280’s AC charge limit to 80 %']);
    expect((await engine.run(automation)).outcome).toBe('acted');
    expect(written.map((intent) => intent.patch)).toEqual([{ acLimit: 80 }]);
  });
});

/*
  The owner's charge window, again: armed at 74 %, it switched the plug off,
  and the owner switched it straight back on. A condition fires once, so the
  plug stayed on. One that keeps things so looks again on its schedule.
*/
describe('keeping things so', () => {
  const MINUTE = 60_000;
  const window = (context: ReturnType<typeof setup>, recheckMinutes: number | null) =>
    context.make('standard.charge-between', { battery: { device: STATION, part: 'main' }, charger: { device: PLUG, part: 'main' } }, { low: 15, lowFor: 120, high: 50, highFor: 0 }, 'act', recheckMinutes);

  test('a charger switched on by hand above the level it stops at is switched off at the next look', async () => {
    const context = setup();
    const { engine, station, plug, sent, readingsMoved } = context;
    station.soc = 74;
    plug.on = true;
    window(context, 10);
    readingsMoved();
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await settle();
    expect(sent.map((intent) => intent.args.on)).toEqual([false]);

    // By hand, back on: no condition turned true, so nothing, yet.
    plug.on = true;
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await engine.tick();
    await settle();
    expect(sent).toHaveLength(1);

    context.at(new Date(MORNING.getTime() + 10 * MINUTE));
    await engine.tick();
    expect(sent.map((intent) => intent.args.on)).toEqual([false, false]);
    expect(sent[1]!.reason).toContain("Looked again after 10 min, and it still holds: Garage P280’s charge is at least 50 %");
    expect(sent[1]!.reason).toContain('Garage P280: Charge 74 %');

    // Not again before its time.
    plug.on = true;
    context.at(new Date(MORNING.getTime() + 15 * MINUTE));
    await engine.tick();
    expect(sent).toHaveLength(2);
  });

  test('without it, a person’s switch stands until a condition turns true again', async () => {
    const context = setup();
    const { engine, station, plug, sent } = context;
    station.soc = 74;
    plug.on = true;
    window(context, null);
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await settle();
    plug.on = true;
    context.at(new Date(MORNING.getTime() + 60 * MINUTE));
    await engine.tick();
    expect(sent).toHaveLength(1);
  });

  test('what is already so is neither sent nor recorded', async () => {
    const context = setup();
    const { engine, station, plug, sent, recorded } = context;
    station.soc = 74;
    plug.on = true;
    window(context, 10);
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await settle();
    const runs = recorded.length;
    context.at(new Date(MORNING.getTime() + 10 * MINUTE));
    await engine.tick();
    context.at(new Date(MORNING.getTime() + 20 * MINUTE));
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(recorded).toHaveLength(runs);
  });

  test('between the levels no condition holds, and the window stays a window: nothing is changed', async () => {
    const context = setup();
    const { engine, station, plug, sent } = context;
    station.soc = 30;
    window(context, 10);
    for (const on of [true, false]) {
      plug.on = on;
      context.at(new Date(MORNING.getTime() + (on ? 10 : 20) * MINUTE));
      await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
      await engine.tick();
    }
    expect(sent).toEqual([]);
  });

  test('a condition still waiting out its hold is not one that holds', async () => {
    const context = setup();
    const { engine, station, plug, sent } = context;
    station.soc = 10;
    plug.on = false;
    window(context, 10);
    // Below 15 %, but not yet for two minutes: the hold decides, not the look.
    await engine.tick();
    engine.stop();
    expect(sent).toEqual([]);
  });

  test('what another automation set since stays — the last edge wins — and what a person set is switched back', async () => {
    const context = setup();
    const { engine, station, plug, sent, ledger } = context;
    station.soc = 74;
    plug.on = true;
    const kept = window(context, 10);
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await settle();
    expect(sent.map((intent) => [intent.args.on, intent.by])).toEqual([[false, `automation:${kept.id}`]]);

    // Another automation turns it on: its edge stands, look after look.
    plug.on = true;
    ledger.switched(PLUG, 'main', { at: context.now().getTime(), by: 'automation:a-other' });
    context.at(new Date(MORNING.getTime() + 10 * MINUTE));
    await engine.tick();
    context.at(new Date(MORNING.getTime() + 20 * MINUTE));
    await engine.tick();
    expect(sent).toHaveLength(1);

    // A person turns it on after that: switched back at the next look.
    ledger.switched(PLUG, 'main', { at: context.now().getTime(), by: 'olof' });
    context.at(new Date(MORNING.getTime() + 30 * MINUTE));
    await engine.tick();
    expect(sent.map((intent) => intent.args.on)).toEqual([false, false]);
  });

  test('a setting it changes is kept so too', async () => {
    const context = setup();
    const { engine, station, plug, written, make } = context;
    station.soc = 74;
    plug.on = true;
    const dark = make('test.kit.dark', { battery: { device: STATION, part: 'main' }, plug: { device: PLUG, part: 'main' } }, {}, 'act', 10);
    await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
    await settle();
    expect(written.map((intent) => [intent.patch, intent.by])).toEqual([[{ light: false }, `automation:${dark.id}`]]);

    // Put back on by hand: off again at the next look — and not written while it already is.
    plug.light = true;
    context.at(new Date(MORNING.getTime() + 10 * MINUTE));
    await engine.tick();
    context.at(new Date(MORNING.getTime() + 20 * MINUTE));
    await engine.tick();
    expect(written.map((intent) => intent.patch)).toEqual([{ light: false }, { light: false }]);
  });
});

describe('when a device says something happened', () => {
  test('runs on the event it waits for, from the part it was given, and nothing else', async () => {
    const context = setup();
    const { engine, bus, sent, make } = context;
    make('test.kit.mains', { station: { device: STATION, part: 'input.ac' }, switch: { device: PLUG, part: 'main' } }, {}, 'act');
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

/*
  Time of day in a condition: the half-minute look sees a window open with
  nothing reported, and on the owner's clock.
*/
describe('between two times of day', () => {
  test('a charge through the night: on as the window opens, on the owner’s clock — once', async () => {
    const context = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 21, minute: 59 }, ZONE) });
    const { engine, store, sent } = context;
    const created = store.create({
      name: 'Night charge',
      rule: {
        roles: { switch: { label: 'Charger', description: 'What charges it', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ becomes: { within: { from: { value: '22:00' }, to: { value: '06:00' } } } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      starts: {},
      timeZone: ZONE,
      recheckMinutes: null,
    });
    const automation = store.update(created.id, { mode: 'act' })!;
    expect(engine.judge(automation).conditions.map((condition) => [condition.text, condition.holds])).toEqual([['It is between 22:00 and 06:00', false]]);
    await engine.tick();
    expect(sent).toEqual([]);

    context.at(zonedInstant({ year: 2026, month: 6, day: 15, hour: 22, minute: 0 }, ZONE));
    await engine.tick();
    await settle();
    expect(sent.map((intent) => intent.args.on)).toEqual([true]);
    expect(sent[0]!.reason).toContain('It is between 22:00 and 06:00 (It is 22:00)');

    // Still night: it does not run again.
    context.at(zonedInstant({ year: 2026, month: 6, day: 16, hour: 1, minute: 30 }, ZONE));
    await engine.tick();
    expect(sent).toHaveLength(1);
    engine.stop();
  });
});

describe('every so many minutes', () => {
  test('once a slot on the owner’s clock — not again within it, and again at the next', async () => {
    const context = setup({ now: zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 40 }, ZONE) });
    const { engine, store, sent } = context;
    const created = store.create({
      name: 'Every quarter',
      rule: {
        roles: { switch: { label: 'Plug', description: 'A plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ every: { value: 15 * 60 } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      starts: {},
      timeZone: ZONE,
      recheckMinutes: null,
    });
    store.update(created.id, { mode: 'act' });
    // 07:40: the 07:30 slot has come, and it has not run in it.
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reason).toContain('Every 15 min');
    context.at(zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 44 }, ZONE));
    await engine.tick();
    expect(sent).toHaveLength(1);
    // 07:45: the next.
    context.at(zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 45 }, ZONE));
    await engine.tick();
    expect(sent).toHaveLength(2);
    engine.stop();
  });

  test('as clocks go back, both of the repeated hour’s slots: every quarter of an hour, none skipped', async () => {
    // 01:45 summer time on 25 October 2026 in Stockholm; at 03:00 summer time the clock shows 02:00 again.
    const first = Date.parse('2026-10-24T23:45:00Z');
    const context = setup({ now: new Date(first) });
    const { engine, store, sent } = context;
    const created = store.create({
      name: 'Every quarter',
      rule: {
        roles: { switch: { label: 'Plug', description: 'A plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ every: { value: 15 * 60 } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      starts: {},
      timeZone: ZONE,
      recheckMinutes: null,
    });
    store.update(created.id, { mode: 'act' });
    // Two and a quarter hours as they pass, looked at each minute: 01:45, the 02:xx of summer, the 02:xx of winter, 03:00.
    for (let minute = 0; minute <= 135; minute++) {
      context.at(new Date(first + minute * 60_000));
      await engine.tick();
    }
    expect(sent).toHaveLength(10);
    engine.stop();
  });
});

/*
  The owner's window, as they asked for it: a station kept between 5 and 30 %
  through the plug that feeds it, each side waited out for 2 minutes. One
  automation, two triggers with ids; its one step asks which started it.
*/
describe('a battery kept between two levels', () => {
  const MINUTE = 60_000;
  const roles = { battery: { device: STATION, part: 'main' }, charger: { device: PLUG, part: 'main' } };
  const levels = { low: 5, lowFor: 120, high: 30, highFor: 120 };

  test('below the low level for its hold: on; at the high level for its hold: off; a dip back is no crossing; and round again', async () => {
    const context = setup();
    const { engine, station, plug, sent } = context;
    const step = async (minutes: number, soc: number) => {
      context.at(new Date(MORNING.getTime() + minutes * MINUTE));
      station.soc = soc;
      await engine.hear({ kind: 'readings', deviceId: STATION, readings: [] });
      await engine.tick();
      await settle();
    };
    const switched = () => sent.map((intent) => intent.args.on);
    plug.on = true;
    context.make('standard.charge-between', roles, levels, 'act');

    // Armed at 60 %: at the high level, and held there for 2 minutes, it switches the charger off.
    await step(0, 60);
    await step(1, 59.9);
    expect(switched()).toEqual([]);
    await step(2, 59.8);
    expect(switched()).toEqual([false]);

    // Running down: under 5 % for a minute, then back over — a dip, not a crossing.
    await step(10, 4.9);
    await step(11, 5.1);
    await step(14, 5.1);
    expect(switched()).toEqual([false]);

    // Under it for its whole hold: on.
    await step(20, 4.8);
    await step(21, 4.7);
    expect(switched()).toEqual([false]);
    await step(22, 4.6);
    expect(switched()).toEqual([false, true]);
    expect(sent[1]!.reason).toContain('Garage P280’s charge is below 5 %, for 2 min');

    // Charging up: nothing in between; at 30 % for its hold, off.
    await step(30, 15);
    await step(40, 29.9);
    await step(41, 30);
    expect(switched()).toEqual([false, true]);
    await step(43, 30.4);
    expect(switched()).toEqual([false, true, false]);

    // And round again.
    await step(60, 4.5);
    await step(62, 4.4);
    expect(switched()).toEqual([false, true, false, true]);
    await step(80, 31);
    await step(82, 31.2);
    expect(switched()).toEqual([false, true, false, true, false]);
    engine.stop();
  });

  test('played by hand, it does what is due now — and between the two levels, nothing', async () => {
    const context = setup();
    const { engine, station, plug } = context;
    plug.on = false;
    const window = context.make('standard.charge-between', roles, levels, 'act');
    station.soc = 15;
    expect((await engine.run(window, { check: true })).outcome).toBe('idle');
    station.soc = 4;
    expect((await engine.run(window, { check: true })).summary).toContain('Would turn Heater plug on');
    station.soc = 31;
    expect((await engine.run(window, { check: true })).summary).toContain('Would turn Heater plug off');
    engine.stop();
  });
});
