import { beforeEach, describe, expect, test } from 'bun:test';

import { checkRule, defineFunction, defineRecipe, inlineParams, SEQUENCE_LIMITS, sunTimes, withSettings, type Coordinates, type Rule, type Step } from '@kraftverk/automation';
import { MAIN_PART, POSITION_SHAPE, REAL_CLOCK, savedDeviceId, zonedInstant, type AuditRecord, type DeviceDescription, type DeviceReader, type Value } from '@kraftverk/device-sdk';
import { memoryLedger, type CommandIntent, type GatewayResult, type WriteIntent } from '@kraftverk/gateway';
import { LiveBus } from '@kraftverk/holder';

import { AutomationEngine, type AutomationRecord, type EngineDevice, type EngineHistory, AutomationLibrary } from '@kraftverk/automation-engine';
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
    ['d-phone', 'Sam’s iPhone'],
  ] as const) insert.run(id, name);
});

const ZONE = 'Europe/Stockholm';
const FORECAST = savedDeviceId('d-forecast');
const PLUG = savedDeviceId('d-plug');
const STATION = savedDeviceId('d-station');
const PHONE = savedDeviceId('d-phone');

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
        when: [{ becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'charge' } }, right: { param: 'below' } }, heldFor: { param: 'heldFor' } }],
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
        when: [{ becomes: { compare: 'ge', left: { read: { role: 'battery', means: 'charge' } }, right: { value: 50 } } }],
        then: [{ write: { role: 'plug', key: 'light', value: { value: false } } }],
      }),
    ],
  },
};

// --- devices, as the engine sees them ---------------------------------------------

const PLUG_DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'on', label: 'On', value: { type: 'boolean' }, means: 'on' },
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
    { key: 'soc', label: 'Battery', value: { type: 'number', unit: '%' }, quantity: 'percent', means: 'charge' },
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'On', value: { type: 'boolean' }, means: 'on' },
    { key: 'input.ac.present', part: 'input.ac', label: 'Mains present', value: { type: 'boolean' }, means: 'mainsPresent' },
    { key: 'acLimit', label: 'AC charge limit', value: { type: 'number', unit: '%', min: 60, max: 100 }, means: 'chargeLimit', access: 'write', category: 'config' },
  ],
  events: [{ id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac', data: { voltage: { type: 'number', unit: 'V' } } }],
};
const FORECAST_DESCRIPTION: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Forecast', kind: 'sensor', offers: ['weather.forecast'] }], attributes: [] };
/** A phone in Find My, as an iCloud device reports itself: where it is, and nothing else here. */
const PHONE_DESCRIPTION: DeviceDescription = { parts: [{ id: MAIN_PART, label: 'Device', kind: 'device' }], attributes: [{ key: 'position', label: 'Where it is', value: POSITION_SHAPE, means: 'position' }] };

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
/** `gate`: what a command waits on once sent — a run that takes its time. `refuse`: what the gateway says instead of acting, when it says something. */
/** `history`: what the home kept of each reading, for a rule that looks back; `location`: where the home is, for the sun. */
function setup(options: { now?: Date; plugRemoved?: boolean; forecastSession?: boolean; gate?: () => Promise<void>; refuse?: (intent: CommandIntent) => GatewayResult | null; history?: EngineHistory; location?: Coordinates } = {}) {
  const sent: CommandIntent[] = [];
  const written: WriteIntent[] = [];
  const recorded: AuditRecord[] = [];
  /** The gateway's memory: who last switched each part, and wrote each setting. */
  const ledger = memoryLedger();
  const station = { soc: 50 as Value };
  /** Whether the plug is on, as it reports it: unknown until a test says; and its light. */
  const plug = { on: null as Value, light: true as Value };
  /** Where the phone is, as Find My last said: nowhere known until a test says. */
  const phone = { position: null as Value };
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
    [`${PHONE}:main`]: { name: 'Sam’s iPhone', removed: false, hasPart: true, part: 'main', description: PHONE_DESCRIPTION, device: reader(() => (phone.position === null ? [] : [{ key: 'position', value: phone.position }]), () => now), offline: 'n/a', capabilities: ['location'] },
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
        const refused = options.refuse?.(intent);
        if (refused) return refused;
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
    ...(options.history ? { history: options.history } : {}),
    ...(options.location ? { location: () => options.location! } : {}),
    bus,
    // A fixed time the test moves on, with real timers.
    clock: { ...REAL_CLOCK, now: () => now.getTime() },
  });
  const library = new AutomationLibrary(KIT, () => {});
  /** An automation copied from one of the kit's recipes, its settings written into its blocks — as the app makes one. */
  const make = (recipe: string, roles: AutomationRecord['roles'], params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'watch', recheckMinutes: number | null = null) => {
    const { id: _id, label: _label, description: _description, sentence: _sentence, ...rule } = library.recipe(recipe)!;
    const created = store.create({ name: 'Test automation', rule: inlineParams(rule, params), madeFrom: recipe, roles, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes });
    return mode === 'watch' ? created : store.update(created.id, { mode })!;
  };
  const sunny = (params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'watch', switchPart = { device: PLUG, part: 'main' }) =>
    make('test.kit.sunny', { forecast: { device: FORECAST, part: 'main' }, switch: switchPart }, params, mode);
  const readingsMoved = () => bus.publish({ kind: 'readings', deviceId: STATION, readings: [] });
  const phoneMoved = () => bus.publish({ kind: 'readings', deviceId: PHONE, readings: [] });
  return { engine, store, bus, sent, written, recorded, ledger, make, sunny, station, plug, phone, phoneMoved, readingsMoved, at: (next: Date) => (now = next), now: () => now };
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
            roles: { switch: { label: 'Switch', capabilities: ['switch'] } },
            params: { fields: {} },
            when: [{ at: { value: '07:00' }, days }],
            then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
          },
          madeFrom: null,
          roles: { switch: { device: PLUG, part: 'main' } },
          groups: {}, starts: {},
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
      rule: { roles: { station: { label: 'Station', capabilities: ['battery'] } }, params: { fields: {} }, when: [], then: [{ write: { role: 'station', means: 'chargeLimit', value: { value: 80 } } }] },
      madeFrom: null,
      roles: { station: { device: STATION, part: 'main' } },
      groups: {}, starts: {},
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

  test('what the event that started it carried is read in its steps: run.event, run.event.voltage', async () => {
    const context = setup();
    const { engine, bus, sent, store } = context;
    const rule: Rule = {
      roles: { station: { label: 'Mains', capabilities: ['acInput'] }, plug: { label: 'Plug', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [{ event: { role: 'station', event: 'mains.lost' } }],
      then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { all: [{ compare: 'eq', left: { run: 'event' }, right: { value: 'mains.lost' } }, { compare: 'gt', left: { run: 'event', field: 'voltage' }, right: { value: 200, unit: 'V' } }] } } } }],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = store.create({ name: 'On what it said', rule, madeFrom: null, roles: { station: { device: STATION, part: 'input.ac' }, plug: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(made.id, { mode: 'act' });
    engine.start();
    try {
      const said = (voltage: number) => bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'input.ac', data: { voltage }, at: new Date().toISOString() } });
      said(230);
      await settle();
      expect(sent.map((intent) => intent.args.on)).toEqual([true]);
      // Played by hand, no event started it: unknown, so not sent.
      expect((await engine.run(store.get(made.id)!, { check: true })).outcome).toBe('unknown');
    } finally {
      engine.stop();
    }
  });

  test('what it remembers is kept across runs, in its own unit — and read by the steps after', async () => {
    const context = setup();
    const { engine, bus, sent, store } = context;
    const rule: Rule = {
      roles: { station: { label: 'Mains', capabilities: ['acInput'] }, plug: { label: 'Plug', capabilities: ['switch'] } },
      params: { fields: {} },
      memory: {
        fields: {
          timesLost: { type: 'number', title: 'Times lost', integer: true, min: 0, max: 2, default: 0 },
          lastVoltage: { type: 'number', title: 'Last voltage', unit: 'kV', default: 0 },
        },
      },
      when: [{ event: { role: 'station', event: 'mains.lost' } }],
      then: [
        { remember: { name: 'timesLost', value: { math: 'add', left: { memory: 'timesLost' }, right: { value: 1 } } } },
        { remember: { name: 'lastVoltage', value: { run: 'event', field: 'voltage' } } },
        // The second time, and after: what it remembered just now is what it reads.
        { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { compare: 'ge', left: { memory: 'timesLost' }, right: { value: 2 } } } } },
      ],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = store.create({ name: 'Count the outages', rule, madeFrom: null, roles: { station: { device: STATION, part: 'input.ac' }, plug: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(made.id, { mode: 'act' });
    engine.start();
    try {
      const lost = (voltage: number) => bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'input.ac', data: { voltage }, at: new Date().toISOString() } });
      lost(230);
      await settle();
      expect(store.memory(made.id)).toEqual({ timesLost: 1, lastVoltage: 0.23 });
      expect(sent.map((intent) => intent.args.on)).toEqual([false]);

      lost(215);
      await settle();
      expect(store.memory(made.id)).toEqual({ timesLost: 2, lastVoltage: 0.215 });
      expect(sent.map((intent) => intent.args.on)).toEqual([false, true]);

      // Past what it may be: not remembered, and the run says why — what it remembered stays.
      lost(220);
      await settle();
      expect(store.memory(made.id)).toEqual({ timesLost: 2, lastVoltage: 0.215 });
      const last = store.runs(made.id)[0]!;
      expect(last.steps.find((step) => step.kind === 'remember')).toEqual(expect.objectContaining({ outcome: 'failed', detail: 'Not remembered: Times lost must be at most 2' }));
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
        roles: { switch: { label: 'Charger', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ becomes: { within: { from: { value: '22:00' }, to: { value: '06:00' } } } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      groups: {}, starts: {},
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
        roles: { switch: { label: 'Plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ every: { value: 15 * 60, unit: 's' } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      groups: {}, starts: {},
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
        roles: { switch: { label: 'Plug', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ every: { value: 15 * 60, unit: 's' } }],
        then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { switch: { device: PLUG, part: 'main' } },
      groups: {}, starts: {},
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

  test('its settings kept in it, not written into its blocks: what it says and sends reads their values', async () => {
    const context = setup();
    const { engine, station, plug, sent, store } = context;
    plug.on = false;
    const { id: _id, label: _label, description: _description, sentence: _sentence, ...recipe } = new AutomationLibrary([], () => {}).recipe('standard.charge-between')!;
    const made = store.create({ name: 'Kept levels', rule: withSettings(recipe, levels), madeFrom: 'standard.charge-between', roles, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    const window = store.update(made.id, { mode: 'act' })!;
    station.soc = 4;
    const run = await engine.run(window, { askedBy: { actor: 'person', name: 'olof' } });
    expect(run.outcome).toBe('acted');
    expect(sent.map((intent) => intent.args.on)).toEqual([true]);
    expect(run.conditions).toEqual([
      { text: 'Garage P280’s charge is below 5 % for 2 min', holds: true },
      { text: 'Garage P280’s charge is at least 30 % for 2 min', holds: false },
    ]);
    engine.stop();
  });

  test('played by hand, it does what is due now — and between the two levels, nothing', async () => {
    const context = setup();
    const { engine, station, plug } = context;
    plug.on = false;
    const window = context.make('standard.charge-between', roles, levels, 'act');
    station.soc = 15;
    expect(await engine.run(window, { check: true })).toMatchObject({ outcome: 'idle', summary: 'Not now: none of what starts it holds' });
    station.soc = 4;
    expect((await engine.run(window, { check: true })).summary).toContain('Would turn Heater plug on');
    station.soc = 31;
    expect((await engine.run(window, { check: true })).summary).toContain('Would turn Heater plug off');
    engine.stop();
  });

  test('refused for a stale reading, it asks for a fresh one and sends again once the part has said something new', async () => {
    let stale = true;
    const context = setup({ refuse: () => (stale ? { outcome: 'refused', detail: 'Its reading is stale: refusing to switch blind', stale: [{ device: PLUG, part: 'main' }] } : null) });
    const { engine, station, plug, sent } = context;
    plug.on = false;
    const window = context.make('standard.charge-between', roles, levels, 'act');
    station.soc = 4;
    const going = engine.run(window, { askedBy: { actor: 'person', name: 'olof' } });
    // The plug says something new: its reading is fresh again, and the gateway takes it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    stale = false;
    context.at(new Date(context.now().getTime() + 2_000));
    const run = await going;
    expect(run.outcome).toBe('acted');
    expect(sent.map((intent) => intent.args.on)).toEqual([true, true]);
    expect(plug.on).toBe(true);
    engine.stop();
  });
});

describe('an automation as a function', () => {
  test('given its inputs by the one that starts it, it answers — and what it answers is remembered there', async () => {
    db.exec('DELETE FROM automation');
    const context = setup();
    const { engine, store } = context;
    // The one started: given a level — 80 % unless told — it answers 5 % below it.
    const answering: Rule = {
      roles: {},
      params: { fields: {} },
      inputs: { fields: { level: { type: 'number', title: 'Level', unit: '%', min: 0, max: 100, default: 80 } } },
      result: { type: 'number', title: 'Answer', unit: '%', default: 0 },
      when: [],
      then: [{ answer: { math: 'subtract', left: { input: 'level' }, right: { value: 5, unit: '%' } } }],
    };
    expect(checkRule(answering, { fn: () => null })).toEqual([]);
    const child = store.create({ name: 'Answers', rule: answering, madeFrom: null, roles: {}, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(child.id, { mode: 'act' });
    // The one that starts it: gives 90 %, waits, and remembers the answer.
    const starting: Rule = {
      roles: { answers: { automation: true, label: 'Answers' } },
      params: { fields: {} },
      memory: { fields: { got: { type: 'number', title: 'Got', unit: '%', default: 0 } } },
      when: [],
      then: [{ start: { role: 'answers', args: { level: { value: 90, unit: '%' } }, andWait: { value: 1, unit: 'min' }, remember: 'got' } }],
    };
    expect(checkRule(starting, { fn: () => null })).toEqual([]);
    const parent = store.create({ name: 'Asks', rule: starting, madeFrom: null, roles: {}, groups: {}, starts: { answers: child.id }, timeZone: ZONE, recheckMinutes: null });
    const run = await engine.run(store.get(parent.id)!, { askedBy: { actor: 'person', name: 'olof' } });
    expect(run.outcome).toBe('acted');
    expect(store.memory(parent.id)).toEqual({ got: 85 });
    const answered = store.runs(child.id)[0]!;
    expect(answered).toMatchObject({ answered: 85, summary: 'Answered 85 %' });

    // Played by a person, nothing given: its default.
    const alone = await engine.run(store.get(child.id)!, { askedBy: { actor: 'person', name: 'olof' } });
    expect(alone.answered).toBe(75);
  });
});

describe('at most every so often', () => {
  test('a start sooner than that after the trigger’s last is let go — and one after it is not', async () => {
    db.exec('DELETE FROM automation');
    const context = setup();
    const { engine, bus, sent, store } = context;
    const rule: Rule = {
      roles: { station: { label: 'Mains', capabilities: ['acInput'] }, plug: { label: 'Plug', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [{ event: { role: 'station', event: 'mains.lost' }, atMostEvery: { value: 10, unit: 'min' } }],
      then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = store.create({ name: 'Once in ten', rule, madeFrom: null, roles: { station: { device: STATION, part: 'input.ac' }, plug: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(made.id, { mode: 'act' });
    engine.start();
    try {
      const lost = () => bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'input.ac', data: null, at: new Date().toISOString() } });
      for (let times = 0; times < 3; times++) (lost(), await settle());
      expect(sent).toHaveLength(1);
      // Eleven minutes on: once more.
      context.at(new Date(context.now().getTime() + 11 * 60_000));
      lost();
      await settle();
      expect(sent).toHaveLength(2);
      expect(store.get(made.id)!.lastRun?.why).toContain('Garage P280 — Mains said');
    } finally {
      engine.stop();
    }
  });
});

describe('across a group', () => {
  test('a condition over its parts is looked at as any part reports — and runs when it turns true', async () => {
    db.exec('DELETE FROM automation');
    const context = setup();
    const { engine, station, sent, store, readingsMoved } = context;
    const rule: Rule = {
      roles: { batteries: { group: true, label: 'Batteries', capabilities: ['battery'] }, plug: { label: 'Plug', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [{ becomes: { across: 'any', as: 'b', group: 'batteries', of: { compare: 'lt', left: { read: { role: 'b', means: 'charge' } }, right: { value: 20, unit: '%' } } } }],
      then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = store.create({ name: 'Any low', rule, madeFrom: null, roles: { plug: { device: PLUG, part: 'main' } }, groups: { batteries: [{ device: STATION, part: 'main' }] }, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(made.id, { mode: 'act' });
    expect(engine.roleProblems(store.get(made.id)!)).toEqual([]);
    station.soc = 40;
    engine.start();
    try {
      readingsMoved();
      await settle();
      expect(sent).toEqual([]);
      // A part of the group reports: the condition is looked at again, and now holds.
      station.soc = 15;
      readingsMoved();
      await settle();
      expect(sent.map((intent) => intent.args.on)).toEqual([true]);
      expect(sent[0]!.reason).toContain('Garage P280: Charge 15 %');
    } finally {
      engine.stop();
    }
  });
});

describe('when a phone gets home', () => {
  /** A made-up home, and a phone 2 km east of it, then at its door. */
  const HOME = { latitude: 59.3, longitude: 18 };
  const AWAY = { latitude: 59.3, longitude: 18.035, accuracy: 20 };
  const DOOR = { latitude: 59.3, longitude: 18.0005, accuracy: 15 };

  test('distance from where the home is, falling below 200 m, starts it: once, and said in words', async () => {
    db.exec('DELETE FROM automation');
    const context = setup({ location: HOME });
    const { engine, phone, sent, store, phoneMoved } = context;
    const rule: Rule = {
      roles: { phone: { label: 'Phone', capabilities: ['location'] }, lamp: { label: 'Hall lamp', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [{ becomes: { compare: 'lt', left: { distance: { role: 'phone', means: 'position' } }, right: { value: 200, unit: 'm' } } }],
      then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = store.create({ name: 'Welcome home', rule, madeFrom: null, roles: { phone: { device: PHONE, part: 'main' }, lamp: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    store.update(made.id, { mode: 'act' });
    expect(engine.roleProblems(store.get(made.id)!)).toEqual([]);
    phone.position = AWAY;
    engine.start();
    try {
      phoneMoved();
      await settle();
      expect(sent).toEqual([]);
      // Find My locates it at the door.
      phone.position = DOOR;
      phoneMoved();
      await settle();
      expect(sent.map((intent) => [intent.deviceId, intent.args.on])).toEqual([[PLUG, true]]);
      expect(sent[0]!.reason).toBe('Welcome home: How far Sam’s iPhone is from home is below 200 m (Sam’s iPhone: 28 m from home)');
      // Still home: it does not start again.
      phoneMoved();
      await settle();
      expect(sent).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  test('with no place for the home, how far is not known, and nothing starts', async () => {
    db.exec('DELETE FROM automation');
    const context = setup();
    const { engine, phone, sent, store, phoneMoved } = context;
    const made = store.create({
      name: 'Welcome home',
      rule: {
        roles: { phone: { label: 'Phone', capabilities: ['location'] }, lamp: { label: 'Hall lamp', capabilities: ['switch'] } },
        params: { fields: {} },
        when: [{ becomes: { compare: 'lt', left: { distance: { role: 'phone', means: 'position' } }, right: { value: 200, unit: 'm' } } }],
        then: [{ command: { role: 'lamp', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
      },
      madeFrom: null,
      roles: { phone: { device: PHONE, part: 'main' }, lamp: { device: PLUG, part: 'main' } },
      groups: {},
      starts: {},
      timeZone: ZONE,
      recheckMinutes: null,
    });
    store.update(made.id, { mode: 'act' });
    phone.position = DOOR;
    engine.start();
    try {
      phoneMoved();
      await settle();
      expect(sent).toEqual([]);
    } finally {
      engine.stop();
    }
  });
});

describe('by the sun', () => {
  /** A made-up home at Greenwich, its automations on the Stockholm clock. */
  const GREENWICH = { latitude: 51.4779, longitude: 0 };
  const sunset = sunTimes({ year: 2026, month: 6, day: 15 }, GREENWICH).sunset!;
  const rule: Rule = {
    roles: { switch: { label: 'Lamp', capabilities: ['switch'] } },
    params: { fields: {} },
    when: [{ at: { sun: 'sunset', offset: { by: { value: 30, unit: 'min' }, before: true } } }],
    then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
  };
  /** An automation of the rule, alone in the home — the tests share one database — at a time, where the home is. */
  const lampAt = (now: Date, location?: Coordinates) => {
    db.exec('DELETE FROM automation');
    const context = setup({ now, ...(location ? { location } : {}) });
    const made = context.store.create({ name: 'Dusk', rule, madeFrom: null, roles: { switch: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    context.store.update(made.id, { mode: 'act' });
    return context;
  };

  test('at 30 min before sunset, where the home is, on the owner’s clock — once', async () => {
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const early = lampAt(new Date(sunset - 31 * 60_000), GREENWICH);
    await early.engine.tick();
    expect(early.sent).toEqual([]);

    const due = lampAt(new Date(sunset - 29 * 60_000), GREENWICH);
    await due.engine.tick();
    await due.engine.tick();
    expect(due.sent.map((intent) => intent.args.on)).toEqual([true]);
    expect(due.store.list()[0]!.lastRun?.why).toBe('Every day at 30 min before sunset');
  });

  test('where the home is not said, the sun cannot be told: nothing runs', async () => {
    const blind = lampAt(new Date(sunset - 29 * 60_000));
    await blind.engine.tick();
    expect(blind.sent).toEqual([]);
  });
});

describe('looking back at what the home kept', () => {
  test('the average of a reading over the last hour: each value by how long it held, the reading now last', async () => {
    const minutes = (n: number) => new Date(MORNING.getTime() - n * 60_000).toISOString();
    // The station's charge: 20 % from an hour and a half ago, 60 % from half an hour ago.
    const kept = [
      { at: minutes(90), value: 20 },
      { at: minutes(30), value: 60 },
    ];
    const asked: string[] = [];
    const history: EngineHistory = {
      samples: (device, key, from, to) => (asked.push(`${device} ${key}`), kept.filter((sample) => sample.at >= from && sample.at <= to)),
      at: (_device, _key, iso) => kept.filter((sample) => sample.at <= iso).at(-1) ?? null,
    };
    const context = setup({ history });
    const rule: Rule = {
      roles: { station: { label: 'Station', capabilities: ['battery'] }, plug: { label: 'Plug', capabilities: ['switch'] } },
      params: { fields: {} },
      when: [],
      if: { compare: 'gt', left: { history: 'average', of: { role: 'station', means: 'charge' }, over: { value: 1, unit: 'h' } }, right: { value: 30, unit: '%' } },
      then: [{ command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } }],
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = context.store.create({ name: 'Charged lately', rule, madeFrom: null, roles: { station: { device: STATION, part: 'main' }, plug: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    // Half the hour at 20 %, half at 60 %, and 50 % now: 40 % on average.
    const run = await context.engine.run(made, { check: true });
    expect(run.outcome).toBe('would-act');
    expect(run.saw).toContain('Garage P280: average of Charge 40 %');
    expect(asked).toEqual([`${STATION} soc`]);

    // Nothing kept: it cannot tell, and does nothing.
    const blind = setup({ history: { samples: () => [], at: () => null } });
    const unknown = await blind.engine.run(blind.store.create({ name: 'Blind', rule, madeFrom: null, roles: { station: { device: STATION, part: 'main' }, plug: { device: PLUG, part: 'main' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null }), { check: true });
    // The reading now is all there is: an average of it alone.
    expect(unknown.saw).toContain('Garage P280: average of Charge 50 %');
  });
});

describe('how a run goes: round after round, tried, ended where it is, waiting for what a device says', () => {
  const ON: Step = { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: true } } } };
  const OFF: Step = { command: { role: 'plug', capability: 'switch', command: 'set', args: { on: { value: false } } } };
  const COUNT: NonNullable<Rule['memory']> = { fields: { count: { type: 'number', title: 'Count', integer: true, min: 0, default: 0 } } };
  const COUNT_ONE: Step = { remember: { name: 'count', value: { math: 'add', left: { memory: 'count' }, right: { value: 1 } } } };
  /** An automation of these steps, let act, about the heater plug and the station's mains. */
  /** `more`: what else the rule says — what starts it, what a start while it runs does. */
  const automation = (context: ReturnType<typeof setup>, then: readonly Step[], otherwise?: readonly Step[], more: Partial<Rule> = {}) => {
    const rule: Rule = {
      roles: { plug: { label: 'Plug', capabilities: ['switch'] }, station: { label: 'Mains', capabilities: ['acInput'] } },
      params: { fields: {} },
      memory: COUNT,
      when: [],
      then,
      ...(otherwise ? { otherwise } : {}),
      ...more,
    };
    expect(checkRule(rule, { fn: () => null })).toEqual([]);
    const made = context.store.create({ name: 'Steps', rule, madeFrom: null, roles: { plug: { device: PLUG, part: 'main' }, station: { device: STATION, part: 'input.ac' } }, groups: {}, starts: {}, timeZone: ZONE, recheckMinutes: null });
    return context.store.update(made.id, { mode: 'act' })!;
  };
  const OLOF = { askedBy: { actor: 'person' as const, name: 'olof' } };

  test('so many rounds: each takes its steps', async () => {
    const context = setup();
    const run = await context.engine.run(automation(context, [{ repeat: { times: { value: 3 }, steps: [ON, OFF] } }]), OLOF);
    expect(run.outcome).toBe('acted');
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true, false, true, false, true, false]);
    expect(run.steps[0]).toMatchObject({ kind: 'repeat', outcome: 'done', detail: '3 rounds' });
    expect(run.steps[1]).toMatchObject({ depth: 1, within: 'Round 1' });
  });

  test('until it is so after a round — or, never so, not succeeding, its fallback taken', async () => {
    const context = setup();
    const until = (most: number): Step => ({ repeat: { times: { value: most }, until: { compare: 'ge', left: { memory: 'count' }, right: { value: 2 } }, steps: [COUNT_ONE] } });
    const met = await context.engine.run(automation(context, [until(5), ON]), OLOF);
    expect(met.outcome).toBe('acted');
    expect(met.steps[0]).toMatchObject({ kind: 'repeat', outcome: 'met', detail: 'After 2 rounds' });
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true]);

    const never = await context.engine.run(automation(context, [until(1), ON], [OFF]), OLOF);
    expect(never.outcome).toBe('failed');
    expect(never.steps[0]).toMatchObject({ kind: 'repeat', outcome: 'not-met', detail: 'Still not so after one round' });
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true, false]);
  });

  test('tried: a step that does not succeed is answered by the others, and the run goes on', async () => {
    const context = setup({ refuse: (intent) => (intent.args.on === true ? { outcome: 'refused', detail: 'Not now' } : null) });
    const made = automation(context, [{ try: { steps: [ON], recover: [OFF] } }, COUNT_ONE]);
    const answered = await context.engine.run(made, OLOF);
    expect(answered.outcome).toBe('acted');
    expect(answered.steps[0]).toMatchObject({ kind: 'try', outcome: 'done', detail: 'A step did not succeed, and what it took after did' });
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true, false]);
    expect(context.store.memory(made.id)).toEqual({ count: 1 });

    // Nothing to take after: it goes on as if it had succeeded.
    const quiet = await context.engine.run(automation(context, [{ try: { steps: [ON] } }]), OLOF);
    expect(quiet.outcome).toBe('acted');
    expect(quiet.steps[0]).toMatchObject({ kind: 'try', outcome: 'done', detail: 'A step did not succeed — it goes on' });
  });

  test('a stop ends it there, saying why — as it went, or as not having succeeded', async () => {
    const context = setup();
    const ended = await context.engine.run(automation(context, [ON, { stop: { why: 'Enough for today' } }, OFF]), OLOF);
    expect(ended.outcome).toBe('acted');
    expect(ended.summary).toBe('Enough for today — after it turned Heater plug on');
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true]);

    const failed = await context.engine.run(automation(context, [{ repeat: { times: { value: 3 }, steps: [ON, { stop: { why: 'The charger did not answer', failed: true } }] } }], [OFF]), OLOF);
    expect(failed.outcome).toBe('failed');
    expect(failed.summary).toBe('Did not succeed: the charger did not answer; then turned Heater plug off');
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true, true, false]);
  });

  test('waiting for what a device says: on, as soon as it does — and not succeeding if it does not in time', async () => {
    const context = setup();
    const going = context.engine.run(automation(context, [{ waitFor: { role: 'station', event: 'mains.lost', atMost: { value: 1, unit: 'min' } } }, ON]), OLOF);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(context.sent).toEqual([]);
    // Another part saying it: not what it waits for.
    context.bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'main', data: null, at: new Date().toISOString() } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(context.sent).toEqual([]);
    context.bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'input.ac', data: null, at: new Date().toISOString() } });
    const run = await going;
    expect(run.outcome).toBe('acted');
    expect(run.steps[0]).toMatchObject({ kind: 'waitFor', outcome: 'met' });
    expect(context.sent.map((intent) => intent.args.on)).toEqual([true]);

    const late = await context.engine.run(automation(context, [{ waitFor: { role: 'station', event: 'mains.lost', atMost: { value: 1, unit: 's' } } }, ON]), OLOF);
    expect(late.outcome).toBe('failed');
    expect(late.steps[0]).toMatchObject({ kind: 'waitFor', outcome: 'timed-out', detail: 'Not in 1 s' });
    expect(context.sent).toHaveLength(1);
  });

  describe('started again by its trigger while it runs', () => {
    const WHEN_LOST: Partial<Rule> = { when: [{ event: { role: 'station', event: 'mains.lost' } }] };
    /** Counts, and takes a second over it. */
    const SLOW: Step[] = [COUNT_ONE, { wait: { for: { value: 1, unit: 's' } } }];
    const lost = (context: ReturnType<typeof setup>) => context.bus.publish({ kind: 'event', deviceId: STATION, event: { id: 'mains.lost', level: 'warn', part: 'input.ac', data: null, at: new Date().toISOString() } });
    /** Until nothing of it runs, nor waits to. */
    const quiet = async (context: ReturnType<typeof setup>, id: string) => {
      for (let tries = 0; tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!context.engine.running(id) && context.store.runs(id).every((run) => run.endedAt !== null)) {
          // A start it queued begins at once: looked at once more.
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!context.engine.running(id)) return;
        }
      }
    };

    test('let go, as it is unless it says otherwise: one run, whatever starts it meanwhile', async () => {
      const context = setup();
      const made = automation(context, SLOW, undefined, WHEN_LOST);
      context.engine.start();
      try {
        for (let times = 0; times < 3; times++) (lost(context), await settle());
        await quiet(context, made.id);
        expect(context.store.memory(made.id)).toEqual({ count: 1 });
        expect(context.store.runs(made.id)).toHaveLength(1);
      } finally {
        context.engine.stop();
      }
    });

    test('started afresh: the run stopped as a person would — its fallback taken — and it starts again', async () => {
      const context = setup();
      const made = automation(context, SLOW, [OFF], { ...WHEN_LOST, whileRunning: 'restart' });
      context.engine.start();
      try {
        lost(context);
        await settle();
        lost(context);
        await quiet(context, made.id);
        expect(context.store.memory(made.id)).toEqual({ count: 2 });
        const runs = context.store.runs(made.id);
        expect(runs.map((run) => run.outcome).sort()).toEqual(['acted', 'stopped']);
        expect(runs.find((run) => run.outcome === 'stopped')!.summary).toBe('Stopped by a new start; then turned Heater plug off');
        expect(context.sent.map((intent) => intent.args.on)).toEqual([false]);
      } finally {
        context.engine.stop();
      }
    });

    test('after it: each start in turn, once the run before it ends', async () => {
      const context = setup();
      const made = automation(context, SLOW, undefined, { ...WHEN_LOST, whileRunning: 'queue' });
      context.engine.start();
      try {
        for (let times = 0; times < 3; times++) (lost(context), await settle());
        await quiet(context, made.id);
        expect(context.store.memory(made.id)).toEqual({ count: 3 });
        const runs = context.store.runs(made.id);
        expect(runs.map((run) => run.outcome)).toEqual(['acted', 'acted', 'acted']);
        expect(runs.filter((run) => run.why.endsWith('once the run before it ended'))).toHaveLength(2);
      } finally {
        context.engine.stop();
      }
    });
  });

  describe('for each part of a group', () => {
    const OUTLETS: Rule['roles'] = { outlets: { group: true, label: 'Outlets', capabilities: ['switch'] } };
    const MEMBERS = [
      { device: PLUG, part: 'main' },
      { device: STATION, part: 'outlet.ac' },
    ];
    const turnOn: Step = { command: { role: 'outlet', capability: 'switch', command: 'set', args: { on: { value: true } } } };
    const pause: Step = { wait: { for: { value: 1, unit: 's' } } };
    /** An automation of these steps for each outlet, let act: the heater plug, then the station's AC outlets. */
    const eachOutlet = (context: ReturnType<typeof setup>, steps: readonly Step[], together = false) => {
      const rule: Rule = { roles: OUTLETS, params: { fields: {} }, when: [], then: [{ forEach: { as: 'outlet', in: 'outlets', ...(together ? { together } : {}), steps } }] };
      expect(checkRule(rule, { fn: () => null })).toEqual([]);
      const made = context.store.create({ name: 'Each outlet', rule, madeFrom: null, roles: {}, groups: { outlets: MEMBERS }, starts: {}, timeZone: ZONE, recheckMinutes: null });
      return context.store.update(made.id, { mode: 'act' })!;
    };

    test('kept, in order — and found by each of its devices', () => {
      const context = setup();
      const made = eachOutlet(context, [turnOn]);
      expect(context.store.get(made.id)!.groups).toEqual({ outlets: MEMBERS });
      expect(context.store.usingDevice(STATION).map((each) => each.id)).toEqual([made.id]);
      expect(context.engine.roleProblems(made)).toEqual([]);
    });

    test('one after the other: each part its steps, called by its name within them', async () => {
      const context = setup();
      const made = eachOutlet(context, [turnOn]);
      const run = await context.engine.run(made, OLOF);
      expect(run.outcome).toBe('acted');
      expect(context.sent.map((intent) => `${intent.deviceId}:${intent.part}`)).toEqual([`${PLUG}:main`, `${STATION}:outlet.ac`]);
      // Its log: each part of the group, what filled it as it ran.
      expect(context.store.runLog(made.id, run.id!)!.roles.map((role) => [role.role, role.device, role.part])).toEqual([
        ['outlets', PLUG, 'main'],
        ['outlets', STATION, 'outlet.ac'],
      ]);
      expect(run.steps.map((step) => [step.depth, step.within, step.what])).toEqual([
        [0, null, 'For each of Heater plug and Garage P280 — AC outlets, one after the other'],
        [1, 'Heater plug', 'Turn Heater plug on'],
        [1, 'Garage P280 — AC outlets', 'Turn Garage P280 — AC outlets on'],
      ]);
      expect(run.summary).toBe('Turned Heater plug on, turned Garage P280 — AC outlets on');
    });

    test('all at the same time: the parts wait together, not one after the other', async () => {
      const context = setup();
      const began = Date.now();
      const run = await context.engine.run(eachOutlet(context, [pause, turnOn], true), OLOF);
      expect(run.outcome).toBe('acted');
      expect(Date.now() - began).toBeLessThan(1_800);
      expect(context.sent).toHaveLength(2);
    });

    test('a part that does not succeed: one after the other, the rest wait on it; together, the others go on', async () => {
      const refuse = (intent: CommandIntent) => (intent.deviceId === PLUG ? { outcome: 'refused' as const, detail: 'Not now' } : null);
      const after = setup({ refuse });
      const inTurn = await after.engine.run(eachOutlet(after, [turnOn]), OLOF);
      expect(inTurn.outcome).toBe('refused');
      expect(after.sent.map((intent) => intent.deviceId)).toEqual([PLUG]);
      expect(inTurn.steps[0]).toMatchObject({ kind: 'forEach', outcome: 'failed', detail: 'One part did not succeed' });

      const together = setup({ refuse });
      const atOnce = await together.engine.run(eachOutlet(together, [turnOn], true), OLOF);
      expect(atOnce.outcome).toBe('refused');
      expect(together.sent.map((intent) => intent.deviceId).sort()).toEqual([PLUG, STATION].sort());
    });
  });

  test('whatever it repeats, a run ends: so many steps, and no more', async () => {
    const context = setup();
    const run = await context.engine.run(automation(context, [{ repeat: { times: { value: 100 }, steps: [{ repeat: { times: { value: 100 }, steps: [COUNT_ONE] } }] } }]), OLOF);
    expect(run.outcome).toBe('failed');
    expect(run.steps.length).toBeLessThanOrEqual(SEQUENCE_LIMITS.steps + 1);
    expect(run.summary).toContain(`it has taken ${SEQUENCE_LIMITS.steps} steps, as many as one run may`);
  });
});
