import { afterAll, describe, expect, test } from 'bun:test';

import { actor } from '@kraftverk/device-sdk';

import { ModeStore, PlaceStore, resetDatabase, type SqlDatabase } from '../src/index.ts';
import { DRIVERS } from './drivers.ts';

/*
  A home's modes: the built-in ones there from the start, a family's own
  added and let go; a home set to one now, and a vacation planned ahead that
  hands back to what was before it.
*/

const OLOF = actor('person', 'olof');
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

for (const driver of DRIVERS)
describe(`modes, on ${driver.name}`, () => {
  const opened: SqlDatabase[] = [];
  /** A home in a database of its own, on this driver. */
  const aHome = async () => {
    const db = await driver.open();
    opened.push(db);
    const places = new PlaceStore(db);
    const home = places.addHome({ key: 'home', name: 'Home', type: 'house', timeZone: 'Europe/London' });
    return { db, modes: new ModeStore(db), home: home.id };
  };
  afterAll(() => opened.splice(0).forEach((db) => db.close()));

  test('the built-in ones on two axes, a family’s own beside them, by a key of its own; let go, it is kept for history', async () => {
    const { modes } = await aHome();
    expect(modes.list().map((mode) => `${mode.axis}:${mode.key}`)).toEqual(['presence:home', 'presence:away', 'presence:vacation', 'day:day', 'day:evening', 'day:night']);
    const party = modes.add({ axis: 'presence', name: 'Guests over' });
    expect([party.key, party.builtIn, party.id.startsWith('m-')]).toEqual(['guests-over', false, true]);
    expect(() => modes.add({ axis: 'day', key: 'away', name: 'Away again' })).toThrow('"away" is not a free key for a mode');
    expect(modes.update('away', { name: 'Gone' })!.name).toBe('Away');
    modes.remove(party.id);
    expect(modes.byKey('guests-over')).toBeNull();
    expect(modes.get(party.id)!.removedAt).not.toBeNull();
  });

  test('set now, then a vacation planned ahead: the home is away until it, on vacation through it, and away again after', async () => {
    const { modes, home } = await aHome();
    expect(modes.at(home, 'presence')).toBeNull();
    modes.set(home, 'home', OLOF, at(1));
    modes.set(home, 'away', OLOF, at(3));
    modes.set(home, 'vacation', OLOF, at(10), at(17));
    expect(modes.at(home, 'presence', at(2))!.modeId).toBe('home');
    expect(modes.at(home, 'presence', at(5))!.modeId).toBe('away');
    expect(modes.at(home, 'presence', at(12))!.modeId).toBe('vacation');
    expect(modes.at(home, 'presence', at(20))!.modeId).toBe('away');
    expect(modes.ahead(home, 'presence', at(5)).map((each) => [each.modeId, each.since, each.until])).toEqual([
      ['vacation', at(10), at(17)],
      ['away', at(17), null],
    ]);
    // The day goes its own way.
    modes.set(home, 'night', actor('automation', 'nightfall'), at(5, 22));
    expect(modes.at(home, 'day', at(6))).toMatchObject({ modeId: 'night', by: { kind: 'automation', name: 'nightfall' } });
    expect(modes.at(home, 'presence', at(6))!.modeId).toBe('away');
    // Set for good from within the vacation: what was planned after it goes.
    modes.set(home, 'home', OLOF, at(12));
    expect(modes.at(home, 'presence', at(20))!.modeId).toBe('home');
    expect(modes.ahead(home, 'presence', at(12))).toEqual([]);
    expect(() => modes.set(home, 'away', OLOF, at(14), at(13))).toThrow('A mode ends after it begins');
  });

  test('a reset keeps the built-in modes', async () => {
    const { db, modes } = await aHome();
    resetDatabase(db);
    modes.ensureBuiltIns();
    expect(modes.list()).toHaveLength(6);
  });
});
