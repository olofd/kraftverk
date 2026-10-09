import type { SharingLevel } from '@kraftverk/api-contract';
import { distanceBetween } from '@kraftverk/device-sdk';

/*
  Where a person is, from what they carry (docs/PLAN-WORLD-MODEL.md §8.9):
  pure rules over positions, no clock or store of their own.

  - Their position is the freshest of what they carry: a stale one says
    nothing, and changes nothing.
  - Arriving needs a position inside a place's geofence.
  - Leaving needs positions outside it — beyond what the position is unsure
    of — for some minutes: a GPS wobble at the edge is not a departure. The
    stay ends when they first went out.
  - At one home at a time, the nearest when two overlap; zones may overlap.
  - What they share decides what is kept: at `places` and above, homes and
    zones; at `home-away`, homes only; `off`, nothing — what was open ends.
*/

/** A position one of their devices reported, and when. */
export type Fix = { deviceId: string; latitude: number; longitude: number; accuracy: number | null; at: number };

/** A home or a zone, and its geofence. */
export type Geofence = { id: string; kind: 'home' | 'zone'; latitude: number; longitude: number; radius: number };

/** A stay that has not ended. */
export type OpenStay = { id: string; placeId: string; kind: 'home' | 'zone'; since: number };

/** How long positions must say they are out before they have left. */
export const LEAVE_AFTER_MS = 5 * 60_000;
/** A position older than this says nothing of where they are now. */
export const STALE_AFTER_MS = 30 * 60_000;

/** The freshest position of what they carry, that is fresh at all; the surer of two at once. */
export function freshest(fixes: readonly Fix[], now: number): Fix | null {
  let best: Fix | null = null;
  for (const fix of fixes) {
    if (now - fix.at > STALE_AFTER_MS || fix.at > now + 60_000) continue;
    if (!best || fix.at > best.at || (fix.at === best.at && (fix.accuracy ?? Infinity) < (best.accuracy ?? Infinity))) best = fix;
  }
  return best;
}

const distanceTo = (fix: Fix, place: Geofence) => distanceBetween(fix, place);
/** Inside: its centre within the geofence. */
const inside = (fix: Fix, place: Geofence) => distanceTo(fix, place) <= place.radius;
/** Out for sure: even what the position is unsure of keeps it outside. */
const out = (fix: Fix, place: Geofence) => distanceTo(fix, place) - (fix.accuracy ?? 0) > place.radius;

/** The kinds of place kept at a level: what they share, no more. */
export const keptKinds = (level: SharingLevel): readonly ('home' | 'zone')[] => (level === 'off' ? [] : level === 'home-away' ? ['home'] : ['home', 'zone']);

/** Why a stay ended: they went; what they share no longer says it; the place was let go. */
type EndedBecause = 'left' | 'unshared' | 'gone';

export type Decision = {
  begin: { place: Geofence; since: number; deviceId: string }[];
  end: { stayId: string; until: number; because: EndedBecause }[];
  /** When positions first said they were out of each place still open: what the next look goes on from. */
  outsideSince: Map<string, number>;
};

export function decide(input: { open: readonly OpenStay[]; fix: Fix | null; places: readonly Geofence[]; outsideSince: ReadonlyMap<string, number>; level: SharingLevel; now: number }): Decision {
  const { open, fix, places, level, now } = input;
  const kinds = keptKinds(level);
  const byId = new Map(places.map((place) => [place.id, place]));
  const end: Decision['end'] = [];
  const outsideSince = new Map<string, number>();
  const ended = new Set<string>();
  const close = (stay: OpenStay, until: number, because: EndedBecause) => {
    end.push({ stayId: stay.id, until: Math.max(until, stay.since + 1), because });
    ended.add(stay.id);
  };

  for (const stay of open) {
    const place = byId.get(stay.placeId);
    // A place let go, or one no longer shared: the stay ends now — not because they went.
    if (!place || !kinds.includes(stay.kind)) {
      close(stay, now, place ? 'unshared' : 'gone');
      continue;
    }
    if (!fix) {
      const was = input.outsideSince.get(stay.placeId);
      if (was !== undefined) outsideSince.set(stay.placeId, was);
      continue;
    }
    if (!out(fix, place)) continue;
    const since = input.outsideSince.get(stay.placeId) ?? fix.at;
    if (now - since >= LEAVE_AFTER_MS) close(stay, since, 'left');
    else outsideSince.set(stay.placeId, since);
  }

  const begin: Decision['begin'] = [];
  if (fix && kinds.length) {
    const still = open.filter((stay) => !ended.has(stay.id));
    const openPlaces = new Set(still.map((stay) => stay.placeId));
    const atHome = still.some((stay) => stay.kind === 'home');
    const within = places.filter((place) => kinds.includes(place.kind) && !openPlaces.has(place.id) && inside(fix, place));
    // One home at a time: the nearest, and only when not at one already.
    const home = atHome ? null : (within.filter((place) => place.kind === 'home').sort((a, b) => distanceTo(fix, a) - distanceTo(fix, b))[0] ?? null);
    if (home) begin.push({ place: home, since: fix.at, deviceId: fix.deviceId });
    for (const zone of within.filter((place) => place.kind === 'zone')) begin.push({ place: zone, since: fix.at, deviceId: fix.deviceId });
  }
  return { begin, end, outsideSince };
}
