import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAIN_PART, savedDeviceId, type AuditRecord, type DeviceDescription, type DeviceReader } from '@kraftverk/device-sdk';
import type { CommandIntent, GatewayResult } from '@kraftverk/gateway';
import { LiveBus, type LiveMessage } from '@kraftverk/holder';

import { closeDb, db } from '../history/db.ts';
import { AutomationEngine, RunRefusal, type EngineDevice } from './engine.ts';
import { AutomationLibrary } from './library.ts';
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
  const insert = db().query("INSERT INTO device (id, type_id, name, description, added_at) VALUES (?, 'test.device', ?, '{\"parts\":[],\"attributes\":[]}', '2026-06-01T00:00:00Z')");
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
};

function setup(world: Partial<World> = {}) {
  const state: World = { supplyOn: false, othersWatts: 0, plugOn: false, reachableAfterMs: 0, supplyOnAt: 0, wakesOnSwitch: 1, plugSwitchedOn: 0, ...world };
  const sent: CommandIntent[] = [];
  const recorded: AuditRecord[] = [];
  const heard: LiveMessage[] = [];
  const fresh: { device: string; until: number }[] = [];
  const reachable = () => state.supplyOn && state.reachableAfterMs !== null && Date.now() - state.supplyOnAt >= state.reachableAfterMs;
  const charging = () => state.plugOn && reachable() && state.wakesOnSwitch !== null && state.plugSwitchedOn >= state.wakesOnSwitch;
  const now = () => new Date().toISOString();
  const reader = (readings: () => { key: string; value: boolean | number }[], connected: () => boolean): DeviceReader => ({
    health: () => ({ status: connected() ? 'connected' : 'offline', detail: connected() ? 'Connected' : 'Its gateway cannot reach it', lastReadingAt: now() }),
    readings: () => readings().map((reading) => ({ ...reading, at: now() })),
    query: async () => [],
  });
  const device = (id: string, name: string, part: string, description: DeviceDescription, read: DeviceReader, connected: () => boolean): EngineDevice => ({
    name,
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
      reader(
        () => [
          { key: 'outlet.ac.on', value: state.supplyOn },
          { key: 'outlet.ac.watts', value: state.supplyOn ? state.othersWatts + (charging() ? 240 : 0) : 0 },
        ],
        () => true
      ),
      () => true
    ),
    [`${PLUG}:main`]: device(
      PLUG,
      'Scooter plug',
      MAIN_PART,
      SOCKET,
      reader(
        () => (reachable() ? [{ key: 'relay', value: state.plugOn }, { key: 'watts', value: charging() ? 240 : 0.4 }] : []),
        reachable
      ),
      reachable
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
        sent.push(intent);
        const on = intent.args.on === true;
        if (intent.deviceId === STATION) {
          if (on && !state.supplyOn) state.supplyOnAt = Date.now();
          state.supplyOn = on;
        } else {
          if (!reachable()) return { outcome: 'refused', detail: 'Its current state is not known, so it is not switched blind' };
          if (on && !state.plugOn) state.plugSwitchedOn += 1;
          state.plugOn = on;
        }
        return { outcome: 'verified', detail: 'Done — confirmed by the device', deviceAgreed: true };
      },
    },
    record: (entry) => recorded.push(entry),
    bus,
    secondMs: SECOND_MS,
  });
  const roles = { supply: { device: STATION, part: 'outlet.ac' }, charger: { device: PLUG, part: MAIN_PART } };
  const make = (recipe: 'standard.start-charging' | 'standard.stop-charging', params: Record<string, string | number> = {}, mode: 'observe' | 'armed' | 'off' = 'armed') => {
    const created = store.create({ name: recipe === 'standard.start-charging' ? 'Start charging the scooter' : 'Stop charging the scooter', recipe, roles, params, timeZone: 'Europe/Stockholm', recheckMinutes: null });
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
  return { engine, store, state, sent, recorded, heard, fresh, make, ended, switches };
}

/** A few seconds of a step, fast: how long the charger is given, and how long it is switched off. */
const QUICK = { reachSeconds: 20, withinSeconds: 5, offSeconds: 3, tries: 3 };

describe('starting a charge', () => {
  test('a charger that draws at once: the supply on, the plug when it can be reached, then on — and made sure of', async () => {
    const { engine, make, ended, switches, store } = setup({ reachableAfterMs: 20 });
    const automation = make('standard.start-charging', QUICK);
    const begun = await engine.startAsked(automation.id, 'olof');
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

  test('a charger that stays idle is switched off and on again until it draws — no more often than its tries — and the gateway is told the run’s allowance', async () => {
    const { engine, make, ended, switches, sent } = setup({ wakesOnSwitch: 3 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, 'olof');
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
    expect(sent.every((intent) => intent.run?.asked === true && intent.actor === 'automation')).toBe(true);
    expect(sent.find((intent) => intent.deviceId === PLUG)!.run!.switches).toBe(1 + 2 * 3 + 1);
  });

  test('a charger that never draws: it gives up after its tries, says why — and switches both off again, as chosen', async () => {
    const { engine, make, ended, switches } = setup({ wakesOnSwitch: null });
    const automation = make('standard.start-charging', { ...QUICK, tries: 2 });
    await engine.startAsked(automation.id, 'olof');
    const run = await ended(automation.id);

    expect(run.outcome).toBe('failed');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'charger on', 'charger off', 'charger on', 'charger off', 'supply off']);
    const ensure = run.steps.find((step) => step.kind === 'ensure')!;
    expect(ensure.outcome).toBe('timed-out');
    expect(ensure.detail).toStartWith('Not in 2 tries — Scooter plug: Power 0.4 W');
    // What it does after: the choice, and within it — a level deeper — both off.
    const after = run.steps.slice(run.steps.findIndex((step) => step.within === 'After a step did not succeed'));
    expect(after.map((step) => [step.depth, step.within, step.what])).toEqual([
      [0, 'After a step did not succeed', 'If you chose “Switch it and its supply off again”'],
      [1, 'Then', 'Turn Scooter plug off'],
      [1, 'Then', 'Turn Garage station — AC outlets off'],
    ]);
    expect(run.summary).toStartWith("Did not succeed: make sure Scooter plug's power is above 50 W within 5 s");
    expect(run.summary).toEndWith('then turned Scooter plug off, turned Garage station — AC outlets off');
  });

  test('left on, as chosen: nothing is switched off when it gives up', async () => {
    const { engine, make, ended, switches } = setup({ wakesOnSwitch: null });
    const automation = make('standard.start-charging', { ...QUICK, tries: 1, ifItFails: 'leaveOn' });
    await engine.startAsked(automation.id, 'olof');
    expect((await ended(automation.id)).outcome).toBe('failed');
    expect(switches()).toEqual(['supply on', 'charger on', 'charger off', 'charger on']);
  });

  test('a plug that never comes back: it waits as long as it may, then stops — its supply switched off again', async () => {
    const { engine, make, ended, switches } = setup({ reachableAfterMs: null });
    const automation = make('standard.start-charging', { ...QUICK, reachSeconds: 10 });
    await engine.startAsked(automation.id, 'olof');
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
    await engine.startAsked(automation.id, 'olof');
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

  test('while it runs: kept at every step, said on the live bus, its readings wanted fresh — one run at a time', async () => {
    const { engine, make, ended, store, heard, fresh } = setup({ wakesOnSwitch: 2 });
    const automation = make('standard.start-charging', QUICK);
    await engine.startAsked(automation.id, 'olof');
    await expect(engine.startAsked(automation.id, 'olof')).rejects.toThrow('It is already running');
    const midway = store.get(automation.id)!;
    expect(midway.running).toMatchObject({ outcome: 'running', startedBy: 'olof' });
    expect(midway.running!.steps.length).toBeGreaterThan(0);

    await ended(automation.id);
    expect(heard.filter((message) => message.kind === 'automation').length).toBeGreaterThan(4);
    // The plug's readings were wanted fresh while it was waited for, and while its draw was watched.
    expect(fresh.some((wish) => wish.device === PLUG)).toBe(true);
  });

  test('only watching, it says what it would do — every step — and sends nothing; off, or not started when asked, it is not started', async () => {
    const { engine, make, sent, store } = setup();
    const watching = make('standard.start-charging', QUICK, 'observe');
    const would = await engine.startAsked(watching.id, 'olof');
    expect(would.outcome).toBe('would-act');
    expect(would.id).toBeNull();
    expect(would.steps.map((step) => `${'  '.repeat(step.depth)}${step.what}`)).toEqual([
      'Turn Garage station — AC outlets on',
      'Wait until Scooter plug can be reached — at most 20 s',
      'Turn Scooter plug on',
      "Make sure Scooter plug's power is above 50 W within 5 s — if not, try again, at most 3 times",
      '  Turn Scooter plug off',
      '  Wait 3 s',
      '  Turn Scooter plug on',
    ]);
    expect(sent).toEqual([]);
    expect(store.get(watching.id)!.lastRun).toBeNull();

    const off = make('standard.start-charging', QUICK, 'off');
    await expect(engine.startAsked(off.id, 'olof')).rejects.toThrow(RunRefusal);
    const window = store.create({
      name: 'Window',
      recipe: 'standard.charge-between',
      roles: { battery: { device: STATION, part: MAIN_PART }, charger: { device: PLUG, part: MAIN_PART } },
      params: {},
      timeZone: 'Europe/Stockholm',
      recheckMinutes: null,
    });
    await expect(engine.startAsked(window.id, 'olof')).rejects.toThrow('It is not started when asked');
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

describe('stopping a charge', () => {
  test('the charger off at once; the supply watched, and switched off when nothing else draws from it', async () => {
    const { engine, make, ended, switches, state } = setup();
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 3 });
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, 'olof');
    const run = await ended(automation.id);
    expect(switches()).toEqual(['charger off', 'supply off']);
    expect(run.steps[1]).toMatchObject({ kind: 'watch', outcome: 'met' });
    expect(run.steps[1]!.detail).toBe("It stayed so for 5 s — Garage station — AC outlets: Power 3 W");
  });

  test('left on when something else still draws from the supply', async () => {
    const { engine, make, ended, switches, state } = setup();
    Object.assign(state, { supplyOn: true, plugOn: true, plugSwitchedOn: 1, othersWatts: 45 });
    const automation = make('standard.stop-charging', { watchSeconds: 5, othersBelow: 10 });
    await engine.startAsked(automation.id, 'olof');
    const run = await ended(automation.id);
    expect(switches()).toEqual(['charger off']);
    expect(run.steps[1]).toMatchObject({ kind: 'watch', outcome: 'not-met' });
    expect(run.steps[1]!.detail).toBe('It did not, after 0 s — Garage station — AC outlets: Power 45 W');
    expect(run.outcome).toBe('acted');
  });
});
