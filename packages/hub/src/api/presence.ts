import type { Caller, KraftverkApi, PresenceView } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { whereabouts } from '../presence/whereabouts.ts';

/*
  Where each member is (docs/PLAN-WORLD-MODEL.md §8.9, §11), as the family
  answers it: as far as each shares, never more — the same to every reader,
  since what a person shares is with their whole family. Never a position:
  that is a carried device's, at \`precise\`.
*/

export function presenceApi(hub: Hub, _caller: Caller): Pick<KraftverkApi, 'presence'> {
  return {
    presence: {
      async list() {
        const names = new Map<string, string>([...hub.places.homes().map((home) => [home.id, home.name] as const), ...hub.places.zones().map((zone) => [zone.id, zone.name] as const)]);
        return whereabouts(hub).map((each): PresenceView => {
          if (each.sharing === 'off') return { personId: each.personId, sharing: each.sharing, home: null, places: [], room: null };
          const places = [...(each.home ? [{ ...each.home, kind: 'home' as const }] : []), ...each.zones.map((zone) => ({ ...zone, kind: 'zone' as const }))];
          const space = each.room ? hub.spaces.space(each.room.spaceId) : null;
          return {
            personId: each.personId,
            sharing: each.sharing,
            home: each.home !== null,
            places: each.tells.zone ? places.map((place) => ({ id: place.id, kind: place.kind, name: names.get(place.id)!, since: place.since })) : [],
            room: each.room && space ? { id: space.id, homeId: each.room.homeId, name: space.name, since: each.room.since } : null,
          };
        });
      },
    },
  };
}
