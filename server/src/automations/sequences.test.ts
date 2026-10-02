import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inlineParams, startCharging, stopCharging, type DeviceReader, type Rule } from '@kraftverk/automation';
import { MAIN_PART, savedDeviceId, type AuditRecord, type AutomationId, type DeviceDescription } from '@kraftverk/device-sdk';
import { memoryLedger, type CommandIntent, type GatewayResult, type WriteIntent, type WriteResult } from '@kraftverk/gateway';
import { LiveBus, type LiveMessage } from '@kraftverk/holder';

import { closeDb, db } from '../history/db.ts';
import { AutomationEngine, RunRefusal, type Asker, type EngineDevice, AutomationLibrary, runLogCsv } from '@kraftverk/automation-engine';
import { AutomationStore } from './store.ts';

/*
  Sequences (docs/SEQUENCES.md), run by the engine through a scripted
  gateway: a station's AC output that powers a charger's plug, and a charger
  that — like the owner's — sometimes stays idle when its power comes on, and
  wakes when its plug is switched off and on again. A second of a step is a
  few milliseconds here.
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-sequences-'));
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
  db().exec('DELETE FROM device');
  const insert = db().query("INSERT INTO device (id, key, type_id, name, description, added_at) VALUES (?1, ?1, 'test.device', ?2, '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')");
  insert.run('d-station', 'Garage station');
  insert.run('d-scooter-plug', 'Scooter plug');
});

const STATION = savedDeviceId('d-station');
const PLUG = savedDeviceId('d-scooter-plug');
const SECOND_MS = 5;

const OUTLET: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device' },
    { id: 'outlet.ac', label: 'AC outlets', kind: 'outlet', offers: ['switch'] },
  ],
  attributes: [
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'AC outlets', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'outlet.ac.watts', part: 'outlet.ac', label: 'AC draw', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power.draw' },
  ],
};
const SOCKET: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Socket', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'relay', label: 'Power', value: { type: 'boolean' }, means: 'switch.on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power.draw' },
    { key: 'live', label: 'Live readings', value: { type: 'boolean' }, access: 'write' },
  ],
};

type World = {
  supplyOn: boolean;
  /** What else draws from the supply, beside the charger. */
  othersWatts: number;
  plugOn: boolean;
  /** The plug rejoins its gateway this long after the supply comes on; never, when null. */
  reachableAfterMs: number | null;
  supplyOnAt: number;
  /** The charger draws once its plug has been switched on this many times; never, when null. */
  wakesOnSwitch: number | null;
  plugSwitchedOn: number;
  /** The plug’s live readings: a setting it may be told. */
  live: boolean;
  /** The gateway’s gap between two switches of the plug in one run, in real milliseconds: refused within it, saying how long is left. */
  plugGapMs: number;
  plugSwitchedAt: number;
  /** How often the station takes a reading, in real milliseconds: between two, it says what it last saw. 0, every time it is asked. */
  supplyReadsEveryMs: number;
  /** How far ahead of this server's clock the station's own is, which it stamps its readings with. */
  supplyClockAheadMs: number;
  /**
   * Its gateway on the same outlets, as the owner's is: while the plug cannot be reached, its connection still
   * looks open — what it said last stays, stamped when it said it, and a command sent to it is lost.
   */
  plugLooksConnected: boolean;
};

function setup(world: Partial<World> = {}) {
  const state: World = { supplyOn: false, othersWatts: 0, plugOn: false, reachableAfterMs: 0, supplyOnAt: 0, wakesOnSwitch: 1, plugSwitchedOn: 0, live: false, plugGapMs: 0, plugSwitchedAt: 0, supplyReadsEveryMs: 0, supplyClockAheadMs: 0, plugLooksConnected: false, ...world };
  const sent: CommandIntent[] = [];
  const recorded: AuditRecord[] = [];
  const heard: LiveMessage[] = [];
  const fresh: { device: string; until: number }[] = [];
  const runsEnded: string[] = [];
  const writes: WriteIntent[] = [];
  const ledger = memoryLedger();
  const reachable = () => state.supplyOn && state.reachableAfterMs !== null && Date.now() - state.supplyOnAt >= state.reachableAfterMs;
  const charging = () => state.plugOn && reachable() && state.wakesOnSwitch !== null && state.plugSwitchedOn >= state.wakesOnSwitch;
  const now = () => new Date().toISOString();
  const reader = (readings: () => { key: string; value: boolean | number }[], connected: () => boolean): DeviceReader => ({
    health: () => ({ status: connected() ? 'connected' : 'offline', detail: connected() ? 'Connected' : 'Its gateway cannot reach it', lastReadingAt: now() }),
    readings: () => readings().map((reading) => ({ ...reading, at: now() })),
    query: async () => [],
  });
  /** The station's readings, taken as often as it takes them: older than now between two. */
  let sample: { at: number; readings: { key: string; value: boolean | number }[] } | null = null;
  const supplyReadings = () => [
    { key: 'outlet.ac.on', value: state.supplyOn },
    { key: 'outlet.ac.watts', value: state.supplyOn ? state.othersWatts + (charging() ? 240 : 0) : 0 },
  ];
  const sampled: DeviceReader = {
    health: () => ({ status: 'connected', detail: 'Connected', lastReadingAt: now() }),
    readings: () => {
      if (!sample || Date.now() - sample.at >= state.supplyReadsEveryMs) sample = { at: Date.now(), readings: supplyReadings() };
      const at = new Date(sample.at + state.supplyClockAheadMs).toISOString();
      return sample.readings.map((reading) => ({ ...reading, at }));
    },
    query: async () => [],
  };
  /** The plug's readings: fresh while it can be reached; else, while its connection looks open, the last it said, as it said them. */
  let plugLast: { key: string; value: boolean | number; at: string }[] = [];
  const plugReader: DeviceReader = {
    health: () => ({ status: reachable() || state.plugLooksConnected ? 'connected' : 'offline', detail: reachable() || state.plugLooksConnected ? 'Connected' : 'Its gateway cannot reach it', lastReadingAt: now() }),
    readings: () => {
      if (reachable()) plugLast = [{ key: 'relay', value: state.plugOn }, { key: 'watts', value: charging() ? 240 : 0.4 }, { key: 'live', value: state.live }].map((reading) => ({ ...reading, at: now() }));
      else if (!state.plugLooksConnected) return [];
      return plugLast;
    },
    query: async () => [],
  };
  const device = (id: string, name: string, part: string, description: DeviceDescription, read: DeviceReader, connected: () => boolean): EngineDevice => ({
    name,
    deviceName: id === STATION ? 'Garage station' : name,
    typeId: id === STATION ? 'test.station' : 'test.plug',
    removed: false,
    hasPart: true,
    part,
    description,
    device: read,
    offline: 'n/a',
    capabilities: ['switch', 'powerMeter'],
    reachable: () => ({ reachable: connected(), detail: connected() ? 'Connected' : 'Its gateway cannot reach it' }),
    wantFresh: (until) => void fresh.push({ device: id, until }),
  });
  const devices: Record<string, EngineDevice> = {
    [`${STATION}:outlet.ac`]: device(
      STATION,
      'Garage station — AC outlets',
      'outlet.ac',
      OUTLET,
      sampled,
      () => true
    ),
    [`${PLUG}:main`]: device(
      PLUG,
      'Scooter plug',
      MAIN_PART,
      SOCKET,
      plugReader,
      () => reachable() || state.plugLooksConnected
    ),
  };
  const store = new AutomationStore();
  const bus = new LiveBus();
  bus.subscribe((message) => void heard.push(message));
  const engine = new AutomationEngine({
    store,
    library: new AutomationLibrary([], () => {}),
    device: (binding) => devices[`${binding.device}:${binding.part}`] ?? null,
    gateway: {
      execute: async (intent: CommandIntent): Promise<GatewayResult> => {
        if (intent.deviceId !== STATION && Date.now() - state.plugSwitchedAt < state.plugGapMs) {
          return { outcome: 'refused', detail: 'Too soon', retryInMs: ((state.plugGapMs - (Date.now() - state.plugSwitchedAt)) * 1000) / SECOND_MS };
        }
        sent.push(intent);
        ledger.switched(intent.deviceId, intent.part, { at: Date.now(), by: intent.by });
        if (intent.deviceId !== STATION) state.plugSwitchedAt = Date.now();
        const on = intent.args.on === true;
        if (intent.deviceId === STATION) {
          // As the gateway says it: a supply already as asked is not switched.
          if (on === state.supplyOn) return { outcome: 'verified', detail: `Already ${on ? 'on' : 'off'}`, deviceAgreed: true };
          if (on && !state.supplyOn) state.supplyOnAt = Date.now();
          state.supplyOn = on;
        } else {
          // Into a connection that only looks open: lost.
          if (!reachable() && state.plugLooksConnected) return { outcome: 'failed', detail: 'The device did not answer command 0xd in 5000ms' };
          if (!reachable()) return { outcome: 'refused', detail: 'Its current state is not known, so it is not switched blind' };
          if (on && !state.plugOn) state.plugSwitchedOn += 1;
          state.plugOn = on;
        }
        return { outcome: 'verified', detail: 'Done — confirmed by the device', deviceAgreed: true };
      },
      write: async (intent: WriteIntent): Promise<WriteResult> => {
        writes.push(intent);
        if (!reachable()) return { outcome: 'refused', detail: 'It cannot be reached' };
        if (typeof intent.patch.live === 'boolean') state.live = intent.patch.live;
        return { outcome: 'verified', detail: 'Changed Live readings to on, confirmed by the device' };
      },
      runEnded: (runId: string) => void runsEnded.push(runId),
      lastSwitch: (device, part) => ledger.lastSwitch(device, part),
      lastWrite: (device, attribute) => ledger.lastWrite(device, attribute),
    },
    record: (entry) => recorded.push(entry),
    bus,
    secondMs: SECOND_MS,
  });
  const roles = { supply: { device: STATION, part: 'outlet.ac' }, charger: { device: PLUG, part: MAIN_PART } };
  /** An automation copied from the recipe, its settings written into its blocks — as the app makes one. */
  const make = (recipe: 'standard.start-charging' | 'standard.stop-charging', params: Record<string, string | number> = {}, mode: 'observe' | 'armed' | 'off' = 'armed') => {
    const rule = inlineParams(recipe === 'standard.start-charging' ? startCharging : stopCharging, params);
    const created = store.create({ name: recipe === 'standard.start-charging' ? 'Start charging the scooter' : 'Stop charging the scooter', rule, madeFrom: recipe, roles, starts: {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
    return mode === 'observe' ? created : store.update(created.id, { mode })!;
  };
  /** Waits for the run to end, and answers it as kept. */
  const ended = async (automationId: string) => {
    for (let waited = 0; waited < 5_000; waited += 10) {
      const automation = store.get(automationId)!;
      if (!automation.running && automation.lastRun) return automation.lastRun;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The run never ended');
  };
  const switches = () => sent.map((intent) => `${intent.deviceId === STATION ? 'supply' : 'charger'} ${intent.args.on ? 'on' : 'off'}`);
  /** An automation of its owner's own: a rule built from blocks, with what fills its roles. */
  const own = (name: string, rule: Omit<Rule, 'params'>, fills: { starts?: Record<string, AutomationId>; mode?: 'observe' | 'armed' | 'off' } = {}) => {
    const partRoles = Object.fromEntries(Object.keys(rule.roles).filter((role) => role in roles).map((role) => [role, roles[role as keyof typeof roles]]));
    const created = store.create({ name, rule: { ...rule, params: { fields: {} } }, madeFrom: null, roles: partRoles, starts: fills.starts ?? {}, timeZone: 'Europe/Stockholm', recheckMinutes: null });
    return fills.mode === 'observe' ? created : store.update(created.id, { mode: fills.mode ?? 'armed' })!;
  };
  return { engine, store, state, devices, bus, sent, writes, recorded, heard, fresh, runsEnded, make, own, ended, switches };
}

/** A person asking. */
const OLOF: Asker = { name: 'olof', actor: 'user' };

/** A few seconds of a step, fast: how long the charger is given, and how long it is switched off. */
const QUICK = { reachSeconds: 20, withinSeconds: 5, offSeconds: 3, tries: 3 };

describe('starting a charge', () => {
  test('a charger that draws at once: the supply on, the plug when it can be reached, then on — and made sure of', async () => {
    const { engine, make, ended, switches, store } = setup({ reachableAfterMs: 20 });
    const automation = make('standard.start-charging', QUICK);
    const begun = await engine.startAsked(automation.id, OLOF);
    expect(begun).toMatchObject({ outcome: 'running', startedBy: 'olof', why: 'Started by olof' });

    const run = await ended(automation.id);
    expect(switches()).toEqual(['supply on', 'charger on']);
    expect(run.outcome).toBe('acted');
    expect(run.steps.map((step) => [step.kind, step.outcome])).toEqual([
      ['command', 'done'],
      ['waitUntil', 'met'],
      ['command', 'done'],
      ['ensure', 'met'],
    ]);
    expect(run.steps[3]!.detail).toContain('Scooter plug: Power 240 W');
    expect(run.summary).toBe('Turned Garage station — AC outlets on, turned Scooter plug on; Scooter plug: Power 240 W, at once');
    // Kept: its last run, and no run in progress.
    expect(store.get(automation.id)).toMatchObject({ running: null, lastRun: { id: run.id, outcome: 'acted' } });
  });

  test('its log: the devices and roles it used as they were, every value they gave at the time each gave it, and when each could be reached', async () => {
    const { engine, make, ended, store } = setup({ reachableAfterMs: 20 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);

    const log = engine.runLog(store.get(automation.id)!, run.id!)!;
    expect(log.run).toMatchObject({ id: run.id, outcome: 'acted' });
    // As they were when it ran: each device's own name and type, and what filled each role.
    expect(log.devices).toEqual([
      { id: STATION, name: 'Garage station', typeId: 'test.station' },
      { id: PLUG, name: 'Scooter plug', typeId: 'test.plug' },
    ]);
    expect(log.roles).toEqual([
      { role: 'supply', label: 'What powers the charger', device: STATION, part: 'outlet.ac' },
      { role: 'charger', label: 'The charger’s plug', device: PLUG, part: MAIN_PART },
    ]);
    // What each value is, as its device described it.
    expect(log.keys.find((key) => key.device === STATION && key.key === 'outlet.ac.watts')).toEqual({
      device: STATION, key: 'outlet.ac.watts', part: 'outlet.ac', label: 'AC outlets: AC draw', kind: 'number', unit: 'W', quantity: 'power', words: null, options: null,
    });
    expect(log.keys.find((key) => key.device === PLUG && key.key === 'relay')).toMatchObject({ kind: 'boolean', unit: null });
    // The plug: out of reach until the supply came on, then switched on, and drawing.
    expect(log.reach.filter((each) => each.device === PLUG).map((each) => each.reachable)).toEqual([false, true]);
    expect(log.reach[0]!.detail).toBeString();
    const said = (device: string, key: string) => log.readings.filter((reading) => reading.device === device && reading.key === key).map((reading) => reading.value);
    expect(said(PLUG, 'relay')).toContain(true);
    expect(said(PLUG, 'watts')).toContain(240);
    expect(said(STATION, 'outlet.ac.on')).toEqual(expect.arrayContaining([false, true]));
    // What a step judged on is there as it judged: the 240 W that made sure of it, heard by the time it was met.
    const sure = log.run.steps.find((step) => step.kind === 'ensure')!;
    expect(log.readings.some((reading) => reading.device === PLUG && reading.key === 'watts' && reading.value === 240 && reading.heardAt <= sure.endedAt!)).toBe(true);
    // In time order, each with when it was heard — never before the device took it.
    const times = log.readings.map((reading) => reading.at);
    expect(times).toEqual([...times].sort());
    expect(log.readings.every((reading) => reading.heardAt >= reading.at)).toBe(true);
    expect(log.capped).toBe(false);
    // Another automation's run is not read through this one.
    expect(engine.runLog({ id: 'a-other' as never }, run.id!)).toBeNull();
  });

  test('its log hears each reading as the device says it — not only at its next look', async () => {
    const { engine, make, ended, store, bus } = setup({ reachableAfterMs: 10_000 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    // Said by the plug between two looks, and gone again before the next: only the bus has it.
    const at = new Date().toISOString();
    bus.publish({ kind: 'readings', deviceId: PLUG, readings: [{ key: 'watts', value: 77, at }] });
    engine.stopAsked(automation.id, 'olof');
    const run = await ended(automation.id);
    const log = engine.runLog(store.get(automation.id)!, run.id!)!;
    expect(log.readings.find((reading) => reading.device === PLUG && reading.key === 'watts' && reading.value === 77)).toMatchObject({ at });
  });

  test('its log as one table, in time order: its steps, the readings and when each device could be reached', async () => {
    const { engine, make, ended, store } = setup({ reachableAfterMs: 20 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    const csv = runLogCsv(engine.runLog(store.get(automation.id)!, run.id!)!);
    const rows = csv.trimEnd().split('\r\n');
    expect(rows[0]).toBe('at,heard_at,type,device_id,device,part,key,label,step,value,unit,detail');
    // A step's words carry a dash and a comma-free sentence; one with a comma is quoted.
    expect(rows.some((row) => row.includes(',step,') && row.includes('Turn Scooter plug on'))).toBe(true);
    expect(rows.some((row) => row.includes(',reading,') && row.includes(`,${PLUG},Scooter plug,main,watts,Power,,240,W,`))).toBe(true);
    expect(rows.some((row) => row.includes(',reach,') && row.includes(',Reachable,,false,'))).toBe(true);
    const ats = rows.slice(1).map((row) => row.split(',')[0]!);
    expect(ats).toEqual([...ats].sort());
  });

  test('a charger that stays idle is switched off and on again until it draws — no more often than its tries — and the gateway is told the run’s allowance', async () => {
    const { engine, make, ended, switches, sent, runsEnded } = setup({ wakesOnSwitch: 3 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);

    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'charger on', 'charger off', 'charger on']);
    expect(run.outcome).toBe('acted');
    const ensure = run.steps.find((step) => step.kind === 'ensure')!;
    expect(ensure).toMatchObject({ outcome: 'met' });
    expect(ensure.detail).toStartWith('After 2 tries');
    // The retries, one level deeper, each within its try.
    expect(run.steps.filter((step) => step.depth === 1).map((step) => `${step.within}: ${step.what}`)).toEqual([
      'Try 1 of 3: Turn Scooter plug off',
      'Try 1 of 3: Wait 3 s',
      'Try 1 of 3: Turn Scooter plug on',
      'Try 2 of 3: Turn Scooter plug off',
      'Try 2 of 3: Wait 3 s',
      'Try 2 of 3: Turn Scooter plug on',
    ]);
    // Every switch is the run's, a person's, with what its rule allows: on, then off and on 3 times, then off if it fails.
    expect(new Set(sent.map((intent) => intent.run?.id))).toEqual(new Set([run.id!]));
    expect(sent.every((intent) => intent.run?.askedBy === 'user' && intent.actor === 'automation')).toBe(true);
    expect(sent.find((intent) => intent.deviceId === PLUG)!.run!.switches).toBe(1 + 2 * 3 + 1);
    // Ended, the gateway is told, and counts nothing more for it.
    expect(runsEnded).toEqual([run.id!]);
  });

  test('a charger that never draws: it gives up after its tries, says why — and switches both off again, as chosen', async () => {
    const { engine, make, ended, switches } = setup({ wakesOnSwitch: null });
    const automation = make('standard.start-charging', { ...QUICK, tries: 2 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);

    expect(run.outcome).toBe('failed');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'charger on', 'charger off', 'charger on', 'charger off', 'supply off']);
    const ensure = run.steps.find((step) => step.kind === 'ensure')!;
    expect(ensure.outcome).toBe('timed-out');
    expect(ensure.detail).toStartWith('Not in 2 tries — Scooter plug: Power 0.4 W');
    // What it does after: both off, as its owner chose — the choice itself is no step.
    const after = run.steps.slice(run.steps.findIndex((step) => step.within === 'After a step did not succeed'));
    expect(after.map((step) => [step.depth, step.within, step.what])).toEqual([
      [0, 'After a step did not succeed', 'Turn Scooter plug off'],
      [0, 'After a step did not succeed', 'Turn Garage station — AC outlets off'],
    ]);
    expect(run.summary).toStartWith("Did not succeed: make sure Scooter plug’s power is above 50 W within 5 s");
    expect(run.summary).toEndWith('then turned Scooter plug off, turned Garage station — AC outlets off');
  });

  test('left on, as chosen: nothing is switched off when it gives up', async () => {
    const { engine, make, ended, switches } = setup({ wakesOnSwitch: null });
    const automation = make('standard.start-charging', { ...QUICK, tries: 1, ifItFails: 'leaveOn' });
    await engine.startAsked(automation.id, OLOF);
    expect((await ended(automation.id)).outcome).toBe('failed');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'charger on']);
  });

  test('a plug that never comes back: it waits as long as it may, then stops — its supply switched off again', async () => {
    const { engine, make, ended, switches } = setup({ reachableAfterMs: null });
    const automation = make('standard.start-charging', { ...QUICK, reachSeconds: 10 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);

    expect(run.outcome).toBe('failed');
    expect(run.steps[1]).toMatchObject({ kind: 'waitUntil', outcome: 'timed-out' });
    expect(run.steps[1]!.detail).toBe('Not in 10 s — Scooter plug: cannot be reached (Its gateway cannot reach it)');
    // The charger's plug cannot be switched off — it cannot be reached — but its supply is: each is tried whatever the other does.
    expect(switches()).toEqual(['supply on', 'charger off', 'supply off']);
  });

  test('stopped while it waits: the step ends as stopped, and what it does if stopped runs', async () => {
    const { engine, make, ended, switches } = setup({ reachableAfterMs: 10_000 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = engine.stopAsked(automation.id, 'olof');
    expect(stopping.outcome).toBe('running');
    const run = await ended(automation.id);

    expect(run.outcome).toBe('stopped');
    expect(run.steps[1]).toMatchObject({ kind: 'waitUntil', outcome: 'stopped', detail: 'Stopped by olof' });
    expect(run.steps.filter((step) => step.within === 'After it was stopped by olof').length).toBeGreaterThan(0);
    expect(switches()).toEqual(['supply on', 'charger off', 'supply off']);
    expect(run.summary).toStartWith('Stopped by olof after it turned Garage station — AC outlets on');
  });

  test('stopped just after the plug was switched on: switching it off again waits out the gateway’s gap — it is not left on', async () => {
    // The charger never draws; the stop comes a moment after the plug was switched on, inside the gap.
    const { engine, make, ended, switches } = setup({ supplyOn: true, wakesOnSwitch: null, plugGapMs: 60 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 15));
    engine.stopAsked(automation.id, 'olof');
    const run = await ended(automation.id);

    expect(run.outcome).toBe('stopped');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'supply off']);
    // What was already so is not said as something it did.
    expect(run.summary).toBe('Stopped by olof after it turned Scooter plug on; then turned Scooter plug off, turned Garage station — AC outlets off');
    const off = run.steps.find((step) => step.within === 'After it was stopped by olof' && step.what.endsWith('off') && step.what.includes('plug'));
    expect(off).toMatchObject({ outcome: 'done' });
  });

  test('deleted while it waits: it stops, does what it does if stopped, and is neither kept nor on the timeline', async () => {
    const { engine, make, store, recorded, switches } = setup({ reachableAfterMs: 10_000 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.delete(automation.id);
    engine.forget(automation.id);
    for (let waited = 0; waited < 5_000 && engine.running(automation.id); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(engine.running(automation.id)).toBeNull();
    expect(switches()).toEqual(['supply on', 'charger off', 'supply off']);
    expect(store.runs(automation.id)).toEqual([]);
    expect(recorded.filter((entry) => entry.resource === automation.id && entry.kind !== 'automation.started')).toEqual([]);
  });

  test('while it runs: kept at every step, said on the live bus, its readings wanted fresh — one run at a time', async () => {
    const { engine, make, ended, store, heard, fresh } = setup({ wakesOnSwitch: 2 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, OLOF);
    await expect(engine.startAsked(automation.id, OLOF)).rejects.toThrow('It is already running');
    const midway = store.get(automation.id)!;
    expect(midway.running).toMatchObject({ outcome: 'running', startedBy: 'olof' });
    expect(midway.running!.steps.length).toBeGreaterThan(0);

    await ended(automation.id);
    expect(heard.filter((message) => message.kind === 'automation').length).toBeGreaterThan(4);
    // The plug's readings were wanted fresh while it was waited for, and while its draw was watched.
    expect(fresh.some((wish) => wish.device === PLUG)).toBe(true);
  });

  test('asked what it would do, it says so — every step — and sends nothing; played by a person, it runs, whatever its mode', async () => {
    const { engine, make, sent, store, ended, switches } = setup({ reachableAfterMs: 20 });
    const watching = make('standard.start-charging', QUICK, 'observe');
    const would = await engine.run(watching, { check: true });
    expect(would.outcome).toBe('would-act');
    expect(would.id).toBeNull();
    expect(would.steps.map((step) => `${'  '.repeat(step.depth)}${step.what}`)).toEqual([
      'Turn Garage station — AC outlets on',
      'Wait until Scooter plug can be reached — at most 20 s',
      'Turn Scooter plug on',
      "Make sure Scooter plug’s power is above 50 W within 5 s — if not, try again, at most 3 times",
      '  Turn Scooter plug off',
      '  Wait 3 s',
      '  Turn Scooter plug on',
    ]);
    expect(sent).toEqual([]);
    expect(store.get(watching.id)!.lastRun).toBeNull();

    // An assistant starts only what its owner has let act: an owner's yes, not its own.
    await expect(engine.startAsked(watching.id, { name: 'assistant for olof', actor: 'agent' })).rejects.toThrow('It only watches');
    // A person's play is a yes: it runs, for real, though it only watches on its own.
    expect((await engine.startAsked(watching.id, OLOF)).outcome).toBe('running');
    expect((await ended(watching.id)).outcome).toBe('acted');
    expect(switches()).toEqual(['supply on', 'charger on']);

    // Off is off: nobody starts it.
    const off = make('standard.start-charging', QUICK, 'off');
    await expect(engine.startAsked(off.id, OLOF)).rejects.toThrow(RunRefusal);
  });

  test('a run the server stopped during is ended as interrupted when it starts again — never resumed', async () => {
    const { store, recorded, make } = setup();
    const automation = make('standard.start-charging', QUICK);
    const at = new Date().toISOString();
    const runId = store.beginRun(automation.id, {
      id: null,
      at,
      endedAt: null,
      startedBy: 'olof',
      startedByRun: null,
      outcome: 'running',
      summary: 'Running',
      why: 'Started by olof',
      saw: [],
      conditions: [],
      steps: [{ kind: 'waitUntil', depth: 0, within: null, what: 'Wait until Scooter plug can be reached — at most 2 min', outcome: 'waiting', detail: 'Waiting', at, endedAt: null, until: at }],
    });

    // A new process, the same database.
    const restarted = setup();
    restarted.engine.start();
    restarted.engine.stop();
    const run = store.get(automation.id)!.lastRun!;
    expect(run).toMatchObject({ id: runId, outcome: 'interrupted' });
    expect(run.steps[0]).toMatchObject({ outcome: 'stopped', detail: 'The server stopped during it' });
    expect(run.summary).toBe('Interrupted: the server stopped during “Wait until Scooter plug can be reached — at most 2 min”. It was not resumed — check what it had switched');
    expect(store.get(automation.id)!.running).toBeNull();
    expect(restarted.recorded.concat(recorded).some((entry) => entry.kind === 'automation.interrupted')).toBe(true);
  });
});

describe('a gateway on the outlets it waits for', () => {
  test('the plug can be reached only once it is heard from since the outlets came on — not on its connection\'s word, which looks open while its gateway has no power', async () => {
    const { engine, make, ended, switches, state, devices } = setup({ plugLooksConnected: true, reachableAfterMs: 10 * SECOND_MS });
    // It said something while it had power, then lost it: its connection still looks open.
    Object.assign(state, { supplyOn: true, supplyOnAt: Date.now() - 1000 });
    expect(devices[`${PLUG}:main`]!.device!.readings().length).toBeGreaterThan(0);
    const automation = make('standard.start-charging', QUICK);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Its power cut, then the run.
    state.supplyOn = false;
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    expect(run.outcome).toBe('acted');
    expect(switches()).toEqual(['supply on', 'charger on']);
    // It waited for the plug to be heard from — not "At once".
    expect(run.steps[1]).toMatchObject({ kind: 'waitUntil', outcome: 'met' });
    expect(run.steps[1]!.detail).not.toMatch(/^At once/);
  });
});

describe('stopping a charge', () => {
  test('the charger off at once; the supply watched, and switched off when nothing else draws from it', async () => {
    const { engine, make, ended, switches, state } = setup();
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 3 });
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    expect(switches()).toEqual(['charger off', 'supply off']);
    expect(run.steps[1]).toMatchObject({ kind: 'watch', outcome: 'met' });
    expect(run.steps[1]!.detail).toBe("It stayed so for 5 s — Garage station — AC outlets: Power 3 W");
  });

  test('the supply judged on what it reads since the charger went off — not on what it still said from before', async () => {
    const { engine, make, ended, switches, state, devices } = setup({ supplyReadsEveryMs: 40 });
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 3 });
    // The station's last reading, taken while the charger drew: 243 W.
    expect(devices[`${STATION}:outlet.ac`]!.device!.readings().find((reading) => reading.key === 'outlet.ac.watts')!.value).toBe(243);
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    expect(switches()).toEqual(['charger off', 'supply off']);
    expect(run.steps[1]!.detail).toBe('It stayed so for 5 s — Garage station — AC outlets: Power 3 W');
  });

  test('a station whose own clock runs ahead: what it said before is still from before — judged by when this server heard it, not by its stamp', async () => {
    const { engine, make, ended, switches, state } = setup({ supplyReadsEveryMs: 40, supplyClockAheadMs: 10 * 60_000 });
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 3 });
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    // Stamped ten minutes ahead, its 243 W from before the charger went off would read as new: it is not.
    expect(switches()).toEqual(['charger off', 'supply off']);
    expect(run.steps[1]!.detail).toBe('It stayed so for 5 s — Garage station — AC outlets: Power 3 W');
  });

  test('left on when something else still draws from the supply', async () => {
    const { engine, make, ended, switches, state } = setup();
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 45 });
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, OLOF);
    const run = await ended(automation.id);
    expect(switches()).toEqual(['charger off']);
    expect(run.steps[1]).toMatchObject({ kind: 'watch', outcome: 'not-met' });
    expect(run.steps[1]!.detail).toBe('It did not, after 0 s — Garage station — AC outlets: Power 45 W');
    expect(run.outcome).toBe('acted');
  });
});

/** An automation's roles: the supply and the plug, as the recipes have them. */
const SUPPLY_ROLE = { label: 'What powers the charger', description: 'Its supply', capabilities: ['switch', 'powerMeter'] } as const;
const PLUG_ROLE = { label: 'The charger’s plug', description: 'Its plug', capabilities: ['switch', 'powerMeter'] } as const;
const on = (role: string, value = true) => ({ command: { role, capability: 'switch', command: 'set', args: { on: { value } } } }) as const;

describe('blocks its owner builds', () => {
  test('change a setting: once the plug can be reached, its live readings on — through the gateway, and not again when they already are', async () => {
    const { own, engine, ended, writes, state } = setup({ reachableAfterMs: 20 });
    const fast = own('Fast readings', {
      roles: { supply: SUPPLY_ROLE, charger: PLUG_ROLE },
      when: [],
      then: [on('supply'), { waitUntil: { condition: { reachable: 'charger' }, atMostSeconds: { value: 20 } } }, { write: { role: 'charger', key: 'live', value: { value: true } } }],
    });
    await engine.startAsked(fast.id, OLOF);
    const run = await ended(fast.id);
    expect(run.outcome).toBe('acted');
    expect(run.steps[2]).toMatchObject({ kind: 'write', what: 'Set Scooter plug’s Live readings to on', outcome: 'done' });
    expect(writes.map((write) => [write.deviceId, write.patch, write.actor])).toEqual([[PLUG, { live: true }, 'automation']]);
    expect(state.live).toBe(true);
    expect(run.summary).toContain('set Scooter plug’s Live readings to on');

    // Played again: already so, and not written a second time.
    await engine.startAsked(fast.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await ended(fast.id);
    expect(again.steps[2]).toMatchObject({ kind: 'write', outcome: 'already' });
    expect(writes).toHaveLength(1);
  });

  test('start another automation and wait for it: its run says which run started it, and who asked for the chain', async () => {
    const { own, make, engine, store, ended, switches } = setup({ reachableAfterMs: 20 });
    const charge = make('standard.start-charging', QUICK);
    const morning = own(
      'Morning',
      { roles: { charging: { automation: true, label: 'The charging', description: 'What charges the scooter' } }, when: [], then: [{ start: { role: 'charging', waitSeconds: { value: 60 } } }] },
      { starts: { charging: charge.id } }
    );
    await engine.startAsked(morning.id, OLOF);
    const run = await ended(morning.id);
    expect(run.outcome).toBe('acted');
    expect(run.steps[0]).toMatchObject({ kind: 'start', what: 'Start “Start charging the scooter” and wait until it ends — at most 1 min', outcome: 'done' });
    expect(run.steps[0]!.detail).toStartWith('It ran: turned Garage station — AC outlets on');
    expect(run.summary).toBe('Started “Start charging the scooter”');
    const child = store.runs(charge.id)[0]!;
    expect(child).toMatchObject({ outcome: 'acted', startedBy: 'olof', startedByRun: { id: run.id, automationId: morning.id, name: 'Morning' }, why: 'Started by “Morning”' });
    expect(switches()).toEqual(['supply on', 'charger on']);
  });

  test('stopped while it waits for the other: that one is stopped too, and what each does if stopped runs', async () => {
    const { own, make, engine, ended, switches } = setup({ reachableAfterMs: 10_000 });
    const charge = make('standard.start-charging', QUICK);
    const morning = own(
      'Morning',
      { roles: { charging: { automation: true, label: 'The charging', description: 'What charges the scooter' } }, when: [], then: [{ start: { role: 'charging', waitSeconds: { value: 60 } } }] },
      { starts: { charging: charge.id } }
    );
    await engine.startAsked(morning.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 40));
    engine.stopAsked(morning.id, 'olof');
    const [parent, child] = [await ended(morning.id), await ended(charge.id)];
    expect(parent.outcome).toBe('stopped');
    expect(parent.steps[0]).toMatchObject({ kind: 'start', outcome: 'stopped' });
    expect(child.outcome).toBe('stopped');
    expect(child.summary).toStartWith('Stopped by “Morning” after it turned Garage station — AC outlets on');
    // The charging sequence switched its supply back off, as it does when stopped.
    expect(switches()).toEqual(['supply on', 'charger off', 'supply off']);
  });

  test('refused, as a step: another that is off, already running, or a chain that would come back to itself', async () => {
    const { own, make, engine, ended, store } = setup();
    const charge = make('standard.start-charging', QUICK, 'off');
    const role = { charging: { automation: true, label: 'The charging', description: 'What charges the scooter' } } as const;
    const starter = own('Starter', { roles: role, when: [], then: [{ start: { role: 'charging' } }] }, { starts: { charging: charge.id } });
    await engine.startAsked(starter.id, OLOF);
    const refused = await ended(starter.id);
    expect(refused.outcome).toBe('refused');
    expect(refused.steps[0]).toMatchObject({ kind: 'start', outcome: 'refused', detail: 'It is off: turn it on to start it' });

    // A starts B, and B starts A: the second start is refused, not run round and round.
    const a = own('A', { roles: role, when: [], then: [{ start: { role: 'charging', waitSeconds: { value: 10 } } }] });
    const b = own('B', { roles: role, when: [], then: [{ start: { role: 'charging' } }] }, { starts: { charging: a.id } });
    store.update(a.id, { starts: { charging: b.id } });
    await engine.startAsked(a.id, OLOF);
    const [first, second] = [await ended(a.id), await ended(b.id)];
    expect(second.steps[0]).toMatchObject({ kind: 'start', outcome: 'refused' });
    expect(['It is already running', 'It is already in this chain: started again, it would start itself']).toContain(second.steps[0]!.detail);
    expect(first.outcome).toBe('failed');
  });
});

/*
  Automations that share a part (docs/SHARED-PARTS-AND-RESERVE.md): a run
  holds every part it may change while it runs; another automation's run
  that needs one is refused, and changes nothing; runs of one chain hold
  together.
*/
describe('automations that share a part', () => {
  test('stopping the charge while it is being started is refused, and changes nothing — then takes its steps once the other has ended', async () => {
    const { make, engine, ended, switches, recorded } = setup({ reachableAfterMs: 10_000 });
    const start = make('standard.start-charging', QUICK);
    const stop = make('standard.stop-charging');
    await engine.startAsked(start.id, OLOF);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const refused = await engine.startAsked(stop.id, OLOF);
    expect(refused).toMatchObject({ outcome: 'refused', summary: 'Scooter plug is in use by “Start charging the scooter”, running now', steps: [] });
    expect(switches()).toEqual(['supply on']);
    // Kept, and on the timeline: its card says why it did nothing.
    expect(recorded.some((entry) => entry.kind === 'automation.refused' && entry.summary.includes('is in use by “Start charging the scooter”'))).toBe(true);

    engine.stopAsked(start.id, 'olof');
    expect((await ended(start.id)).outcome).toBe('stopped');
    await engine.startAsked(stop.id, OLOF);
    // Its turn now: it takes its steps — the plug, unpowered with its supply off, then answers for itself.
    const second = await ended(stop.id);
    expect(second.summary).not.toContain('is in use');
    expect(second.steps[0]).toMatchObject({ kind: 'command', what: 'Turn Scooter plug off' });
  });

  test('a chain holds together: one that starts another and then switches the plug they share is not held back by itself', async () => {
    const { own, make, engine, ended, switches } = setup({ reachableAfterMs: 20 });
    const charge = make('standard.start-charging', QUICK);
    const evening = own(
      'Evening',
      {
        roles: { charger: { label: 'The charger’s plug', description: 'The plug the charger is in', capabilities: ['switch'] }, charging: { automation: true, label: 'The charging', description: 'What charges the scooter' } },
        when: [],
        then: [{ start: { role: 'charging', waitSeconds: { value: 60 } } }, { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: false } } } }],
      },
      { starts: { charging: charge.id } }
    );
    await engine.startAsked(evening.id, OLOF);
    const [parent, child] = [await ended(evening.id), await ended(charge.id)];
    expect(child.outcome).toBe('acted');
    expect(parent.outcome).toBe('acted');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off']);
  });
});

describe('an automation in configuration', () => {
  test('its key: made from its name, one automation to a key, changed only to a free one', () => {
    const { make, store } = setup();
    const first = make('standard.start-charging');
    const second = make('standard.start-charging');
    expect(first.key).toMatch(/^start-charging-the-scooter(-\d+)?$/);
    expect(second.key).not.toBe(first.key);
    expect(() => store.update(first.id, { key: second.key })).toThrow('not a free key');
    expect(() => store.update(first.id, { key: 'Not A Key' })).toThrow('not a free key');
    expect(store.update(first.id, { key: 'scooter-start' })?.key).toBe('scooter-start');
    expect(store.update(first.id, { name: 'Renamed' })?.key).toBe('scooter-start');
  });
});
