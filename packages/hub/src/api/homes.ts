import { ApiError, type Caller, type HomeInput, type HomeView, type KraftverkApi } from '@kraftverk/api-contract';
import { isTimeZone } from '@kraftverk/device-sdk';
import { HOME_RADIUS, HOME_TYPES, type HomeRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  A family's homes, as it answers them (docs/PLAN-WORLD-MODEL.md §8.4): each
  a place with its own clock; added, changed, and archived when left — never
  the last, since a family always has a home. On the timeline as the home's,
  never its coordinates.
*/

export const homeView = (home: HomeRecord): HomeView => ({ ...home });

/** What a home given says, checked: a refusal names what is wrong, in words. */
function checked(input: Partial<HomeInput>): void {
  if (input.name !== undefined && !(input.name.trim().length >= 1 && input.name.trim().length <= 60)) throw new ApiError('invalid', 'A home’s name is 1 to 60 characters');
  if (input.type !== undefined && !(HOME_TYPES as readonly string[]).includes(input.type)) throw new ApiError('invalid', `A home is one of: ${HOME_TYPES.join(', ')}`);
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) throw new ApiError('invalid', `"${input.timeZone}" is not a time zone`);
  const at = input.location;
  if (at && !(Math.abs(at.latitude) <= 90 && Math.abs(at.longitude) <= 180)) throw new ApiError('invalid', 'A latitude is from -90 to 90, a longitude from -180 to 180');
  if (at && !(at.radius > 0 && at.radius <= 50_000)) throw new ApiError('invalid', 'A home’s geofence is from 1 m to 50 km');
  if (input.country != null && !/^[A-Z]{2}$/.test(input.country)) throw new ApiError('invalid', 'A country is its two letters: SE, GB');
  if (input.bearing !== undefined && !(input.bearing >= 0 && input.bearing < 360)) throw new ApiError('invalid', 'A bearing is from 0 to 360 degrees');
}

export function homesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'homes'> {
  const actor = actorOf(caller);
  const record = (kind: string, home: HomeRecord, summary: string) => hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind: 'home', resource: home.id, summary });
  const homeOf = (id: string): HomeRecord => {
    const home = hub.places.home(id);
    if (!home) throw new ApiError('not-found', 'No such home');
    return home;
  };
  return {
    homes: {
      list: async (options = {}) => hub.places.homes(options).map(homeView),

      async add(input) {
        checked(input);
        const home = hub.places.addHome({ ...input, name: input.name.trim(), location: input.location ?? null });
        record('home.added', home, `Added the home "${home.name}"`);
        return homeView(home);
      },

      async update(id, changes) {
        const was = homeOf(id);
        checked(changes);
        const location = changes.location === undefined ? undefined : changes.location ? { ...changes.location, radius: changes.location.radius ?? HOME_RADIUS } : null;
        const home = hub.places.updateHome(was.id, { ...changes, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}), ...(location !== undefined ? { location } : {}) })!;
        // Where it is goes on the timeline as said or forgotten: never the coordinates.
        const said = location === undefined ? [] : [location ? 'where it is' : 'forgot where it is'];
        const others = Object.keys(changes).filter((key) => key !== 'location');
        record('home.changed', home, `Changed the home "${home.name}": ${[...others, ...said].join(', ') || 'nothing'}`);
        return homeView(home);
      },

      async remove(id) {
        const home = homeOf(id);
        if (home.removedAt) return homeView(home);
        if (hub.places.homes().length <= 1) throw new ApiError('conflict', 'A family always has a home: add the new one before leaving this one');
        const left = hub.places.archiveHome(home.id)!;
        record('home.removed', left, `Left the home "${home.name}": what was recorded there is kept`);
        return homeView(left);
      },
    },
  };
}
