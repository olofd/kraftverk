import type { Caller, FamilyView, KraftverkApi } from '@kraftverk/api-contract';
import type { FamilyRecord } from '@kraftverk/store';
import { type CapabilitySpec } from '@kraftverk/device-sdk';

import { vocabularyOf, worldOf } from '../assistant/world.ts';
import type { Hub } from '../node/hub.ts';
import { readerOf, shownTo } from '../presence/levels.ts';

/*
  The family as a whole, as everything that uses it asks: what it is called
  and which node is its master, its timeline, and the world as a model reads
  it, with the words it is said in.
*/

type FamilyWideApi = Pick<KraftverkApi, 'family' | 'timeline' | 'world' | 'vocabulary'>;

/** The family as everything that asks sees it. */
const viewOf = (family: FamilyRecord): FamilyView => ({ id: family.id, name: family.name, kind: family.kind, locale: family.locale, master: family.masterId, createdAt: family.createdAt });

export function familyWideApi(hub: Hub, caller: Caller): FamilyWideApi {
  return {
    /** The family: what its people call it, and its master. */
    async family() {
      return viewOf(hub.family.get()!);
    },

    timeline: async (query = {}) => hub.audit.recent(query),

    /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. */
    world: async () => worldOf(hub.views.all().map(shownTo(hub, readerOf(caller))), { readOnly: hub.readOnly() }),

    /** The words the world is said in: capabilities — the library's and the devices' own — meanings, link kinds, recipes, and the values the home has set. */
    vocabulary: async () =>
      vocabularyOf(
        hub.library,
        hub.policy.values(),
        hub.views.all().map((device) => (device.description.capabilities ?? {}) as Record<string, CapabilitySpec>)
      ),
  };
}
