import { ApiError, type Caller, type HomeView, type KraftverkApi } from '@kraftverk/api-contract';
import type { HomeRecord } from '@kraftverk/store';
import { type CapabilitySpec } from '@kraftverk/device-sdk';

import { vocabularyOf, worldOf } from '../assistant/world.ts';
import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  The home as a whole, as everything that uses it asks: what it is called and
  which node is its master, its timeline, and the world as a model reads it,
  with the words it is said in.
*/

type HomeWideApi = Pick<KraftverkApi, 'home' | 'setHomeLocation' | 'timeline' | 'world' | 'vocabulary'>;

/** The home as everything that asks sees it. */
const viewOf = (home: HomeRecord): HomeView => ({ id: home.id, name: home.name, master: home.masterId, createdAt: home.createdAt, location: home.location });

export function homeWideApi(hub: Hub, caller: Caller): HomeWideApi {
  const actor = actorOf(caller);
  return {
    /** The home: what its people call it, its master, and where it is. */
    async home() {
      return viewOf(hub.home.get()!);
    },

    /** Where it is: within the globe, or not said — on the timeline as the home's, never its coordinates. */
    async setHomeLocation(location) {
      if (location && !(Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180)) throw new ApiError('invalid', 'A latitude is from -90 to 90, a longitude from -180 to 180');
      const home = hub.home.locate(location ? { latitude: location.latitude, longitude: location.longitude } : null);
      hub.audit.record({ at: new Date().toISOString(), kind: 'home.located', actor, summary: location ? 'Said where the home is: sunrise and sunset are told by it' : 'Forgot where the home is', detail: {} });
      return viewOf(home);
    },

    timeline: async (query = {}) => hub.audit.recent(query),

    /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. */
    world: async () => worldOf(hub.views.all(), { readOnly: hub.readOnly() }),

    /** The words the world is said in: capabilities — the library's and the devices' own — meanings, link kinds, recipes, and the values the home has set. */
    vocabulary: async () =>
      vocabularyOf(
        hub.library,
        hub.policy.values(),
        hub.views.all().map((device) => (device.description.capabilities ?? {}) as Record<string, CapabilitySpec>)
      ),
  };
}
