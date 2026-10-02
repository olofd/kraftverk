import { type KraftverkApi } from '@kraftverk/api-contract';
import { type CapabilitySpec } from '@kraftverk/device-sdk';

import { vocabularyOf, worldOf } from '../assistant/world.ts';
import type { Hub } from '../node/hub.ts';

/*
  The home as a whole, as everything that uses it asks: what it is called and
  which node is its master, its timeline, and the world as a model reads it,
  with the words it is said in.
*/

type HomeWideApi = Pick<KraftverkApi, 'home' | 'timeline' | 'world' | 'vocabulary'>;

export function homeWideApi(hub: Hub): HomeWideApi {
  return {
    /** The home: what its people call it, and its master. */
    async home() {
      const home = hub.home.get()!;
      return { id: home.id, name: home.name, master: home.masterId, createdAt: home.createdAt };
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
