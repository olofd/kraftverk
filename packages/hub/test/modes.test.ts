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
    expect(set.find((each) => each.axis === 'day')).toMatchObject({ mode: null, since: null });
    expect((await t.home.timeline()).find((entry) => entry.kind === 'home.mode')?.summary).toBe(`${home!.name} is Away`);

    const from = new Date(Date.now() + 86_400_000).toISOString();
    const until = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const planned = await t.home.modes.set(home!.id, { mode: 'vacation', from, until });
    expect(planned.find((each) => each.axis === 'presence')!.ahead.map((each) => [each.mode.key, each.from, each.until])).toEqual([
      ['vacation', from, until],
      ['away', until, null],
    ]);
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
  test('set now: said at once, from what it was; one planned ahead: said when the clock reaches it — never twice', () => {
    const db = testDatabase();
    const places = new PlaceStore(db);
    const home = places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London' }).id;
    const said: LiveMessage[] = [];
    let now = Date.parse('2026-10-09T12:00:00Z');
    const modes = new Modes({ store: new ModeStore(db), places, bus: { publish: (message) => void said.push(message) }, clock: { now: () => now, setTimeout: () => ({ clock: 'timer' }), setInterval: () => ({ clock: 'timer' }), clear: () => {}, rate: 1 } });
    modes.start();
    modes.set(home, 'home', { kind: 'person', id: null, name: 'olof' });
    modes.set(home, 'away', { kind: 'automation', id: 'a-1', name: 'Away when the last one leaves' });
    modes.set(home, 'night', { kind: 'person', id: null, name: 'olof' }, new Date(now + 3_600_000).toISOString());
    modes.look();
    expect(said).toEqual([
      { kind: 'mode', homeId: home, axis: 'presence', mode: 'home', previous: null, at: new Date(now).toISOString() },
      { kind: 'mode', homeId: home, axis: 'presence', mode: 'away', previous: 'home', at: new Date(now).toISOString() },
    ]);
    now += 3_600_000;
    modes.look();
    modes.look();
    expect(said.slice(2)).toEqual([{ kind: 'mode', homeId: home, axis: 'day', mode: 'night', previous: null, at: new Date(now).toISOString() }]);
    expect(modes.now(home, 'day')).toBe('night');
  });
});
