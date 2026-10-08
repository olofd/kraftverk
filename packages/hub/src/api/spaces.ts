import { ApiError, type Caller, type KraftverkApi, type OpeningInput, type SpaceInput } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  A home's spaces and the openings between them, as a family answers them
  (docs/PLAN-WORLD-MODEL.md §8.5): a tree from each home's site, archived when
  it goes, since what stood there is history. On the timeline as the home's.
*/

const SPACE_KINDS = ['building', 'floor', 'room', 'area', 'stairs', 'outdoor'];
const OPENING_KINDS = ['door', 'opening', 'stairs', 'window', 'gate', 'garage-door', 'elevator'];

/** A space given, checked: a refusal in words. */
function checkedSpace(input: Partial<SpaceInput>): void {
  if (input.name !== undefined && !(input.name.trim().length >= 1 && input.name.trim().length <= 60)) throw new ApiError('invalid', 'A space’s name is 1 to 60 characters');
  if (input.kind !== undefined && !SPACE_KINDS.includes(input.kind)) throw new ApiError('invalid', `A space is one of: ${SPACE_KINDS.join(', ')}`);
  if (input.level !== undefined && input.level !== null && !(Number.isInteger(input.level) && Math.abs(input.level) <= 200)) throw new ApiError('invalid', 'A floor’s level is a whole number: 0 the ground floor');
  if (input.height !== undefined && input.height !== null && !(input.height > 0 && input.height <= 100)) throw new ApiError('invalid', 'A height is metres, above 0');
}

/** The store's refusal, said as the family's. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
  }
};

export function spacesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'spaces' | 'openings'> {
  const by = actorOf(caller);
  const record = (kind: string, homeId: string, summary: string) => hub.audit.record({ at: new Date().toISOString(), kind, actor: by, resourceKind: 'home', resource: homeId, summary });
  const homeOf = (id: string) => {
    const home = hub.places.home(id);
    if (!home) throw new ApiError('not-found', 'No such home');
    return home;
  };
  const spaceOf = (id: string) => {
    const space = hub.spaces.space(id);
    if (!space) throw new ApiError('not-found', 'No such space');
    return space;
  };
  return {
    spaces: {
      list: async (homeId, options = {}) => hub.spaces.spaces(homeOf(homeId).id, options),

      async add(input) {
        checkedSpace(input);
        const parent = spaceOf(input.parentId);
        const space = refusing(() => hub.spaces.addSpace({ ...input, name: input.name.trim() }));
        record('space.added', parent.homeId, `Added ${space.name} to ${homeOf(parent.homeId).name}`);
        return space;
      },

      async update(id, changes) {
        const was = spaceOf(id);
        if (was.kind === 'site') throw new ApiError('invalid', 'The site is the home itself: change the home');
        checkedSpace(changes);
        if (changes.parentId !== undefined) {
          const parent = spaceOf(changes.parentId);
          if (parent.homeId !== was.homeId) throw new ApiError('invalid', 'A space stays in its home');
        }
        const space = refusing(() => hub.spaces.updateSpace(id, { ...changes, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}) }))!;
        record('space.changed', was.homeId, `Changed ${space.name}: ${Object.keys(changes).join(', ')}`);
        return space;
      },

      async remove(id) {
        const was = spaceOf(id);
        if (was.kind === 'site') throw new ApiError('invalid', 'The site is the home itself: leave the home instead');
        const space = hub.spaces.archiveSpace(id, by)!;
        record('space.removed', was.homeId, `Removed ${was.name}: what stood there is kept as history`);
        return space;
      },
    },

    openings: {
      list: async (homeId) => hub.spaces.openings(homeOf(homeId).id),

      async add(input) {
        if (!OPENING_KINDS.includes(input.kind)) throw new ApiError('invalid', `An opening is one of: ${OPENING_KINDS.join(', ')}`);
        const from = spaceOf(input.fromId);
        if (input.toId !== null && spaceOf(input.toId).homeId !== from.homeId) throw new ApiError('invalid', 'An opening joins two spaces of one home');
        const opening = refusing(() => hub.spaces.addOpening(input as OpeningInput));
        record('opening.added', from.homeId, `Added ${opening.name ?? `a ${opening.kind}`} to ${from.name}`);
        return opening;
      },

      async update(id, changes) {
        const was = hub.spaces.opening(id);
        if (!was) throw new ApiError('not-found', 'No such opening');
        if (changes.kind !== undefined && !OPENING_KINDS.includes(changes.kind)) throw new ApiError('invalid', `An opening is one of: ${OPENING_KINDS.join(', ')}`);
        for (const end of [changes.fromId, changes.toId]) if (end) if (spaceOf(end).homeId !== was.homeId) throw new ApiError('invalid', 'An opening joins two spaces of one home');
        const opening = refusing(() => hub.spaces.updateOpening(id, changes))!;
        record('opening.changed', was.homeId, `Changed ${opening.name ?? `a ${opening.kind}`}`);
        return opening;
      },

      async remove(id) {
        const was = hub.spaces.opening(id);
        if (!was) throw new ApiError('not-found', 'No such opening');
        const opening = hub.spaces.archiveOpening(id)!;
        record('opening.removed', was.homeId, `Removed ${was.name ?? `a ${was.kind}`}`);
        return opening;
      },
    },
  };
}
