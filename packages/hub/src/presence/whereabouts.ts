import type { SharingLevel } from '@kraftverk/api-contract';
import type { PeopleStore, PlaceStore, PresenceStore, SpaceStore } from '@kraftverk/store';

import { keptKinds } from './rules.ts';

/*
  Where everyone in the family is now (docs/PLAN-WORLD-MODEL.md §8.9, §11),
  as far as each shares — the one answer the family's screens, its rooms'
  occupancy and its automations all read: never more than a person shares
  now, whatever was kept while they shared more; only members; only places
  still there. And, for each, what cannot be told of them: someone who
  shares nothing might be anywhere — not "away".
*/

/** One member: what they share now, and where they are as far as it goes. */
export type Whereabouts = {
  personId: string;
  sharing: SharingLevel;
  /** The home they are at, if one — as far as they share homes at all. */
  home: { id: string; since: string } | null;
  zones: readonly { id: string; since: string }[];
  /** The room they are in, by a signal that tells people apart. */
  room: { spaceId: string; homeId: string; since: string } | null;
  /** Whether where they are can be told, by the kind of place: what they share says. */
  tells: { home: boolean; zone: boolean; space: boolean };
};

export type WhereaboutsDeps = {
  people: Pick<PeopleStore, 'members'>;
  places: Pick<PlaceStore, 'homes' | 'zones'>;
  stays: Pick<PresenceStore, 'allOpen' | 'allRooms'>;
  spaces: Pick<SpaceStore, 'space'>;
};

/** What a person sharing at a level lets be told, by the kind of place. */
const tellsAt = (level: SharingLevel): Whereabouts['tells'] => {
  const kinds = keptKinds(level);
  return { home: kinds.includes('home'), zone: kinds.includes('zone'), space: kinds.includes('zone') };
};

/** Every member, where they are now, as far as each shares. */
export function whereabouts(deps: WhereaboutsDeps): Whereabouts[] {
  const homes = new Set(deps.places.homes().map((home) => home.id));
  const zones = new Set(deps.places.zones().map((zone) => zone.id));
  const open = deps.stays.allOpen();
  const rooms = deps.stays.allRooms();
  return deps.people.members().map((person) => {
    const sharing = person.member!.sharing.now;
    const tells = tellsAt(sharing);
    const mine = open.filter((stay) => stay.personId === person.id);
    const home = tells.home ? (mine.find((stay) => stay.kind === 'home' && homes.has(stay.placeId)) ?? null) : null;
    const room = tells.space ? (rooms.find((stay) => stay.personId === person.id) ?? null) : null;
    const space = room ? deps.spaces.space(room.spaceId) : null;
    return {
      personId: person.id,
      sharing,
      home: home ? { id: home.placeId, since: home.since } : null,
      zones: tells.zone ? mine.filter((stay) => stay.kind === 'zone' && zones.has(stay.placeId)).map((stay) => ({ id: stay.placeId, since: stay.since })) : [],
      room: room && space && !space.removedAt && homes.has(room.homeId) ? { spaceId: room.spaceId, homeId: room.homeId, since: room.since } : null,
      tells,
    };
  });
}
