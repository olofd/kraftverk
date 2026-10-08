import type { Caller, KraftverkApi, PresenceView } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { keptKinds } from '../presence/rules.ts';

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
        return hub.people.members().map((person): PresenceView => {
          const sharing = person.member!.sharing.now;
          if (sharing === 'off') return { personId: person.id, sharing, home: null, places: [] };
          const kinds = keptKinds(sharing);
          // What is kept is no more than they share; what they share now may be less than when it was kept.
          const open = hub.stays.open(person.id).filter((stay) => kinds.includes(stay.kind) && names.has(stay.placeId));
          return {
            personId: person.id,
            sharing,
            home: open.some((stay) => stay.kind === 'home'),
            places: sharing === 'home-away' ? [] : open.map((stay) => ({ id: stay.placeId, kind: stay.kind, name: names.get(stay.placeId)!, since: stay.since })),
          };
        });
      },
    },
  };
}
