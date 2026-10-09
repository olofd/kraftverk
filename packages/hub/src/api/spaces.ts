import { ApiError, type Caller, type KraftverkApi, type OpeningInput, type SpaceHistory, type SpaceInput } from '@kraftverk/api-contract';
import { attributeMeaning, partsOf } from '@kraftverk/device-sdk';
import { frameProblem, heightProblem, nameProblem, planProblem, pointsProblem, turnOf } from '@kraftverk/map/limits';

import { resolutionOf, series } from '../history/sampler.ts';
import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';
import { spanOf } from './devices.ts';

/*
  A home's spaces and the openings between them, as a family answers them
  (docs/PLAN-WORLD-MODEL.md §8.5): a tree from each home's site, archived when
  it goes, since what stood there is history. On the timeline as the home's.
*/

const SPACE_KINDS = ['building', 'floor', 'room', 'area', 'stairs', 'outdoor'];
const OPENING_KINDS = ['door', 'opening', 'stairs', 'window', 'gate', 'garage-door', 'elevator'];

/** A refusal in words, when there is one. */
const refuse = (problem: string | null): void => {
  if (problem) throw new ApiError('invalid', problem);
};

/** A space given, checked by the limits every way in shares (`@kraftverk/map/limits`): a refusal in words. Its turns, kept from 0 to below 360. */
function checkedSpace(input: Partial<SpaceInput>): Partial<SpaceInput> {
  if (input.frame) refuse(frameProblem(input.frame));
  if (input.outline) refuse(pointsProblem(input.outline, 3, 'An outline'));
  if (input.plan) refuse(planProblem(input.plan));
  if (input.name !== undefined) refuse(nameProblem(input.name, 'A space'));
  if (input.kind !== undefined && !SPACE_KINDS.includes(input.kind)) throw new ApiError('invalid', `A space is one of: ${SPACE_KINDS.join(', ')}`);
  if (input.level !== undefined && input.level !== null && !(Number.isInteger(input.level) && Math.abs(input.level) <= 200)) throw new ApiError('invalid', 'A floor’s level is a whole number: 0 the ground floor');
  if (input.height !== undefined && input.height !== null) refuse(heightProblem(input.height));
  return { ...input, ...(input.frame ? { frame: { ...input.frame, turn: turnOf(input.frame.turn) } } : {}), ...(input.plan ? { plan: { ...input.plan, turn: turnOf(input.plan.turn) } } : {}) };
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
  const pictureOf = (id: string) => {
    if (!hub.media.get(id)) throw new ApiError('invalid', 'Add the drawing first: no such picture');
  };
  return {
    spaces: {
      list: async (homeId, options = {}) => hub.spaces.spaces(homeOf(homeId).id, options),

      async add(given) {
        const input = { ...given, ...checkedSpace(given) };
        if (input.plan) pictureOf(input.plan.pictureId);
        const parent = spaceOf(input.parentId);
        const space = refusing(() => hub.spaces.addSpace({ ...input, name: input.name.trim() }));
        record('space.added', parent.homeId, `Added ${space.name} to ${homeOf(parent.homeId).name}`);
        return space;
      },

      async update(id, given) {
        const was = spaceOf(id);
        if (was.kind === 'site') throw new ApiError('invalid', 'The site is the home itself: change the home');
        const changes = checkedSpace(given);
        if (changes.plan) pictureOf(changes.plan.pictureId);
        if (changes.plan && (changes.kind ?? was.kind) !== 'floor') throw new ApiError('invalid', 'Only a floor has a drawing');
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

      /*
        By meaning, not by key: a room's temperature is whatever stood there
        that reads one, under whatever key its type keeps it. A device placed
        as a whole reads there on every part not placed apart.
      */
      async history(id, query) {
        const space = spaceOf(id);
        const { from, to } = spanOf(query);
        const resolution = resolutionOf(from, to);
        const tree = hub.spaces.spaces(space.homeId, { removed: true });
        const within = [space.id];
        for (let index = 0; index < within.length; index++) for (const inner of tree) if (inner.parentId === within[index]) within.push(inner.id);
        const stays = within.flatMap((spaceId) => hub.spaces.stoodIn(spaceId, from, to).map((stay) => ({ ...stay, spaceId })));
        const found: SpaceHistory['series'] = stays.flatMap((stay) => {
          const device = hub.catalog.get(stay.deviceId);
          if (!device) return [];
          const description = hub.sessions.description(device);
          const parts = stay.part === 'main' ? partsOf(description).map((part) => part.id).filter((part) => part === 'main' || !hub.spaces.history(device.id, part).length) : [stay.part];
          const start = stay.since > from ? stay.since : from;
          const end = stay.until !== null && stay.until < to ? stay.until : to;
          return parts.flatMap((part) => {
            const attribute = attributeMeaning(description, part, query.means);
            return attribute ? [{ deviceId: device.id, part, key: attribute.key, spaceId: stay.spaceId, from: start, to: end, points: series(hub.history, device.id, attribute.key, start, end, query.points ?? 240, resolution) }] : [];
          });
        });
        return { spaceId: space.id, means: query.means, from, to, resolution, series: found };
      },
    },

    openings: {
      list: async (homeId) => hub.spaces.openings(homeOf(homeId).id),

      async add(input) {
        if (!OPENING_KINDS.includes(input.kind)) throw new ApiError('invalid', `An opening is one of: ${OPENING_KINDS.join(', ')}`);
        if (input.shape) refuse(pointsProblem(input.shape, 2, 'Its shape'));
        if (input.name) refuse(nameProblem(input.name, 'An opening'));
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
        if (changes.shape) refuse(pointsProblem(changes.shape, 2, 'Its shape'));
        if (changes.name) refuse(nameProblem(changes.name, 'An opening'));
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
