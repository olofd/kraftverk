import { describe, expect, test } from 'bun:test';

import { decide, freshest, LEAVE_AFTER_MS, STALE_AFTER_MS, type Fix, type Geofence, type OpenStay } from '../src/presence/rules.ts';

/*
  Presence's rules, alone: positions in, stays begun and ended out. Places
  are made up near Greenwich; a degree of latitude is about 111 km, so
  0.001° is about 111 m.
*/

const HOME: Geofence = { id: 'h-home', kind: 'home', latitude: 51.48, longitude: 0, radius: 150 };
const CABIN: Geofence = { id: 'h-cabin', kind: 'home', latitude: 51.4805, longitude: 0, radius: 150 };
const WORK: Geofence = { id: 'z-work', kind: 'zone', latitude: 51.5, longitude: 0, radius: 200 };
const TOWN: Geofence = { id: 'z-town', kind: 'zone', latitude: 51.5, longitude: 0, radius: 5_000 };

const T = Date.parse('2026-10-08T12:00:00Z');
const fix = (latitude: number, at: number, accuracy: number | null = 10): Fix => ({ deviceId: 'd-phone', latitude, longitude: 0, accuracy, at });
const open = (place: Geofence, since = T - 3_600_000): OpenStay => ({ id: `st-${place.id}`, placeId: place.id, kind: place.kind, since });

describe('presence', () => {
  test('arrives at once inside a geofence — the nearest home of two that overlap, and every zone it is in', () => {
    const at = decide({ open: [], fix: fix(51.4801, T), places: [HOME, CABIN, WORK], outsideSince: new Map(), level: 'places', now: T });
    expect(at.begin.map((each) => [each.place.id, each.since])).toEqual([['h-home', T]]);
    const atWork = decide({ open: [], fix: fix(51.5, T), places: [HOME, WORK, TOWN], outsideSince: new Map(), level: 'places', now: T });
    expect(atWork.begin.map((each) => each.place.id).sort()).toEqual(['z-town', 'z-work']);
  });

  test('leaves only after minutes out — when it first went out — and a wobble back at the edge is no departure', () => {
    const away = fix(51.49, T);
    const first = decide({ open: [open(HOME)], fix: away, places: [HOME], outsideSince: new Map(), level: 'places', now: T });
    expect(first.end).toEqual([]);
    expect(first.outsideSince.get('h-home')).toBe(T);
    // Back inside before the minutes are out: still home, and the count starts again.
    const back = decide({ open: [open(HOME)], fix: fix(51.48, T + 60_000), places: [HOME], outsideSince: first.outsideSince, level: 'places', now: T + 60_000 });
    expect([back.end, back.outsideSince.size]).toEqual([[], 0]);
    // Out all the minutes: left, when it first went out.
    const later = T + LEAVE_AFTER_MS;
    const gone = decide({ open: [open(HOME)], fix: fix(51.49, later), places: [HOME], outsideSince: first.outsideSince, level: 'places', now: later });
    expect(gone.end).toEqual([{ stayId: 'st-h-home', until: T }]);
  });

  test('a position whose uncertainty reaches inside is not out', () => {
    // 200 m from home's middle, unsure by 100 m: it may be inside, so it is not taken as out.
    const unsure = decide({ open: [open(HOME)], fix: fix(51.4818, T, 100), places: [HOME], outsideSince: new Map(), level: 'places', now: T });
    expect(unsure.outsideSince.size).toBe(0);
  });

  test('a stale position changes nothing; the freshest of what they carry counts, and the surer of two at once', () => {
    expect(freshest([fix(51.48, T - STALE_AFTER_MS - 1)], T)).toBeNull();
    const stale = decide({ open: [open(HOME)], fix: null, places: [HOME], outsideSince: new Map([['h-home', T - 60_000]]), level: 'places', now: T + LEAVE_AFTER_MS });
    expect([stale.begin, stale.end]).toEqual([[], []]);
    const phone = { ...fix(51.48, T - 1000, 30), deviceId: 'd-phone' };
    const watch = { ...fix(51.49, T, 50), deviceId: 'd-watch' };
    const car = { ...fix(51.5, T, 5), deviceId: 'd-car' };
    expect(freshest([phone, watch, car], T)?.deviceId).toBe('d-car');
  });

  test('what they share decides what is kept: home-away ends a zone and opens none; off ends everything', () => {
    const both = [open(HOME), open(WORK)];
    const homeAway = decide({ open: both, fix: fix(51.5, T), places: [HOME, WORK], outsideSince: new Map(), level: 'home-away', now: T });
    expect(homeAway.end.map((each) => each.stayId)).toEqual(['st-z-work']);
    expect(homeAway.begin).toEqual([]);
    const off = decide({ open: both, fix: fix(51.48, T), places: [HOME, WORK], outsideSince: new Map(), level: 'off', now: T });
    expect(off.end.map((each) => each.stayId).sort()).toEqual(['st-h-home', 'st-z-work']);
    expect(off.begin).toEqual([]);
  });

  test('a place let go ends its stay now', () => {
    const left = decide({ open: [open(WORK)], fix: fix(51.5, T), places: [HOME], outsideSince: new Map(), level: 'places', now: T });
    expect(left.end).toEqual([{ stayId: 'st-z-work', until: T }]);
  });
});
