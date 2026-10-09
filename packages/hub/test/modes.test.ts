import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { LiveMessage } from '@kraftverk/holder';
import { ModeStore, PlaceStore } from '@kraftverk/store';

import { Modes } from '../src/modes/modes.ts';
import { aHome, refusal, type TestHome } from './a-home.ts';
import { testDatabase } from './home.ts';

/*
  A home's modes: the family's own beside the built-in ones; a home set to
  one by a person, on the timeline; a vacation planned ahead; and each change
  said on the bus — at once when set, on the clock when one planned comes.
*/

describe('modes, as a family answers them', () => {
  let t: TestHome;
  beforeEach(async () => {
    t = await aHome();
  });
  afterEach(async () => {
    await t.stop();
  });

  test('a family’s own beside the built-in; a home set to away, on the timeline; a vacation ahead, and what it hands back to', async () => {
    const own = await t.home.modes.add({ axis: 'presence', name: 'Guests over' });
    expect(own).toMatchObject({ key: 'guests-over', builtIn: false });
    expect((await t.home.modes.list()).map((mode) => mode.key)).toEqual(['home', 'away', 'vacation', 'guests-over', 'day', 'evening', 'night']);
    expect((await refusal(t.home.modes.update('away', { name: 'Gone' }))).message).toBe('Away is built in: it is as it is');
    expect((await refusal(t.home.modes.add({ axis: 'day', key: 'night', name: 'Late' }))).kind).toBe('conflict');

    const [home] = await t.home.homes.list();
    const set = await t.home.modes.set(home!.id, { mode: 'away' });
    expect(set.find((each) => each.axis === 'presence')).toMatchObject({ mode: { key: 'away' }, by: 'olof', ahead: [] });
    // Every home is in a mode on each axis: the day's, until something says otherwise.
    expect(set.find((each) => each.axis === 'day')).toMatchObject({ mode: { key: 'day' }, by: 'kraftverk' });
    expect((await t.home.timeline()).find((entry) => entry.kind === 'home.mode')?.summary).toBe(`${home!.name} is Away`);

    const from = new Date(Date.now() + 86_400_000).toISOString();
    const until = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const planned = await t.home.modes.set(home!.id, { mode: 'vacation', from, until });
    expect(planned.find((each) => each.axis === 'presence')!.ahead.map((each) => [each.mode.key, each.from, each.until, each.planned])).toEqual([
      ['vacation', from, until, true],
      ['away', until, null, false],
    ]);
    // Set for good now, the vacation stays planned — and what comes back after it is what was set.
    const again = await t.home.modes.set(home!.id, { mode: 'home', from: new Date(Date.now() + 1000).toISOString().replace('Z', '+00:00') });
    expect(again.find((each) => each.axis === 'presence')!.ahead.map((each) => each.mode.key)).toEqual(['home', 'vacation', 'home']);
    // A time with an offset is the instant it says.
    const offset = await t.home.modes.set(home!.id, { mode: 'away', from: '2099-01-01T02:00:00+02:00', until: '2099-01-02T00:00:00Z' });
    expect(offset.find((each) => each.axis === 'presence')!.ahead.find((each) => each.mode.key === 'away')?.from).toBe('2099-01-01T00:00:00.000Z');
    // Let go, what was before it lasts on.
    const cancelled = await t.home.modes.cancel(home!.id, { axis: 'presence', from });
    expect(cancelled.find((each) => each.axis === 'presence')!.ahead.map((each) => each.mode.key)).toEqual(['home', 'away', 'home']);
    expect((await refusal(t.home.modes.cancel(home!.id, { axis: 'presence', from }))).message).toBe('Nothing is planned then');
    expect((await refusal(t.home.modes.set(home!.id, { mode: 'away', from: 'tomorrow' }))).message).toBe('From is not a time: "tomorrow"');
    expect((await refusal(t.home.modes.set(home!.id, { mode: 'nowhere' }))).message).toBe('There is no mode "nowhere"');
  });

  test('a family’s own mode in its file, and back from it: the built-in ones are every family’s, and never written', async () => {
    const own = await t.home.modes.add({ axis: 'day', name: 'Movie night', icon: 'film' });
    const { text } = await t.home.configuration.export({ secrets: 'none' });
    expect(text).toContain('modes:\n  movie-night:\n    axis: day\n    name: Movie night\n    icon: film');
    expect(text).not.toContain('vacation');
    await t.home.modes.remove(own.id);
    const plan = await t.home.configuration.plan({ text });
    expect(plan.modes).toEqual([{ key: 'movie-night', name: 'Movie night', action: 'add', changes: [] }]);
    expect((await t.home.configuration.apply({ plan: plan.id! })).modes).toEqual({ added: ['movie-night'], changed: [] });
    expect((await t.home.modes.list()).find((mode) => mode.key === 'movie-night')).toMatchObject({ axis: 'day', name: 'Movie night', builtIn: false });
  });
});

describe('modes, said on the bus', () => {
  /** Modes on a clock of the test's own: its timers kept to be run by hand. */
  const onAClock = () => {
    const db = testDatabase();
    const places = new PlaceStore(db);
    const home = places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London' }).id;
    const said: LiveMessage[] = [];
    const clock = { now: Date.parse('2026-10-09T12:00:00Z'), timers: [] as { at: number; task: () => void }[] };
    const store = new ModeStore(db);
    const modes = new Modes({
      store,
      places,
      bus: { publish: (message) => void said.push(message) },
      clock: {
        now: () => clock.now,
        setTimeout: (task, ms) => (clock.timers.push({ at: clock.now + ms, task }), { clock: 'timer' }),
        setInterval: () => ({ clock: 'timer' }),
        clear: () => {},
        rate: 1,
      },
    });
    /** The clock moved on: what came due runs. */
    const pass = (ms: number) => {
      clock.now += ms;
      const due = clock.timers.filter((timer) => timer.at <= clock.now);
      clock.timers = clock.timers.filter((timer) => timer.at > clock.now);
      for (const timer of due) timer.task();
    };
    return { db, places, home, said, clock, store, modes, pass, iso: (ms = 0) => new Date(clock.now + ms).toISOString() };
  };
  const OLOF = { kind: 'person', id: null, name: 'olof' } as const;
  const AUTOMATION = { kind: 'automation', id: 'a-1', name: 'Away when the last one leaves' } as const;

  test('a home starts in home and day, unsaid; set now: said at once, from what it was, with what caused it; planned: said as the clock reaches it — never twice', () => {
    const { home, said, store, modes, pass, iso } = onAClock();
    modes.start();
    expect([modes.now(home, 'presence'), modes.now(home, 'day')]).toEqual(['home', 'day']);
    expect(said).toEqual([]);
    modes.set(home, 'away', AUTOMATION, undefined, undefined, ['a-1']);
    modes.set(home, 'night', OLOF, iso(3_600_000));
    expect(said).toEqual([{ kind: 'mode', homeId: home, axis: 'presence', mode: 'away', previous: 'home', by: AUTOMATION, cause: ['a-1'], at: iso() }]);
    pass(3_600_000);
    modes.look();
    expect(said.slice(1)).toEqual([{ kind: 'mode', homeId: home, axis: 'day', mode: 'night', previous: 'day', by: OLOF, cause: [], at: iso() }]);
    expect(store.said(home, 'day')).toBe('night');
  });

  test('a vacation planned, then away set for good: the vacation stays planned, and away comes back after it, each said as the clock reaches it', () => {
    const { home, said, modes, pass, iso } = onAClock();
    modes.start();
    modes.set(home, 'vacation', OLOF, iso(60_000), iso(120_000));
    modes.set(home, 'away', AUTOMATION);
    pass(61_000);
    pass(60_000);
    expect(said.map((message) => (message.kind === 'mode' ? `${message.previous}>${message.mode}` : ''))).toEqual(['home>away', 'away>vacation', 'vacation>away']);
    expect(modes.now(home, 'presence')).toBe('away');
  });

  test('set now while a vacation lasts: the vacation ends there — home early', () => {
    const { home, said, modes, pass, iso } = onAClock();
    modes.start();
    modes.set(home, 'vacation', OLOF, iso(60_000), iso(3_600_000));
    pass(61_000);
    modes.set(home, 'home', OLOF);
    pass(3_600_000);
    expect(said.map((message) => (message.kind === 'mode' ? `${message.previous}>${message.mode}` : ''))).toEqual(['home>vacation', 'vacation>home']);
  });

  test('begun while nobody listened: said when the home starts again; a mode renamed is no change', () => {
    const { db, places, home, store, iso } = onAClock();
    const first: LiveMessage[] = [];
    const clock = { now: Date.parse('2026-10-09T12:00:00Z') };
    const make = (said: LiveMessage[]) => new Modes({ store, places, bus: { publish: (message) => void said.push(message) }, clock: { now: () => clock.now, setTimeout: () => ({ clock: 'timer' }), setInterval: () => ({ clock: 'timer' }), clear: () => {}, rate: 1 } });
    const before = make(first);
    before.start();
    store.set(home, 'vacation', OLOF, iso(60_000), iso(3_600_000));
    before.stop();
    clock.now += 120_000;
    const after: LiveMessage[] = [];
    make(after).start();
    expect(after).toMatchObject([{ kind: 'mode', mode: 'vacation', previous: 'home' }]);
    const own = store.add({ axis: 'day', name: 'Movie night' });
    const again: LiveMessage[] = [];
    const third = make(again);
    third.start();
    third.set(home, own.id, OLOF);
    store.update(own.id, { key: 'films' });
    third.look();
    expect(again.map((message) => (message.kind === 'mode' ? message.mode : ''))).toEqual(['movie-night']);
    db.close();
  });
});
