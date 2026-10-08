import { ApiError, type Caller, type HomeModeView, type KraftverkApi, type ModeView } from '@kraftverk/api-contract';
import { MODE_AXES, MODE_KEY, type ModeRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  A home's modes (docs/PLAN-WORLD-MODEL.md §8.10), as a family answers them:
  the built-in ones and its own, and which each home is in — set by a
  person now or ahead, on the timeline as theirs.
*/

const viewOf = (mode: ModeRecord): ModeView => ({ id: mode.id, key: mode.key, axis: mode.axis, name: mode.name, icon: mode.icon, builtIn: mode.builtIn, removedAt: mode.removedAt });

/** A refusal from the store, said as the family's. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
  }
};

export function modesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'modes'> {
  const by = actorOf(caller);
  const record = (kind: string, resourceKind: 'mode' | 'home', resource: string, summary: string) => hub.audit.record({ at: new Date().toISOString(), kind, actor: by, resourceKind, resource, summary });
  const homeOf = (id: string) => {
    const home = hub.places.home(id);
    if (!home || home.removedAt) throw new ApiError('not-found', 'No such home');
    return home;
  };
  const modeOf = (id: string) => {
    const mode = hub.modeStore.get(id);
    if (!mode) throw new ApiError('not-found', 'No such mode');
    return mode;
  };
  const name = (text: string) => {
    const trimmed = text.trim();
    if (!(trimmed.length >= 1 && trimmed.length <= 30)) throw new ApiError('invalid', 'A mode’s name is 1 to 30 characters');
    return trimmed;
  };

  /** A home's modes, as a person reads them. */
  const of = (homeId: string): HomeModeView[] => {
    const now = new Date().toISOString();
    return MODE_AXES.map((axis) => {
      const kept = hub.modeStore.at(homeId, axis, now);
      const mode = kept ? hub.modeStore.get(kept.modeId) : null;
      return {
        axis,
        mode: mode ? viewOf(mode) : null,
        since: kept?.since ?? null,
        by: kept?.by.name ?? null,
        ahead: hub.modeStore.ahead(homeId, axis, now).flatMap((each) => {
          const coming = hub.modeStore.get(each.modeId);
          return coming ? [{ mode: viewOf(coming), from: each.since, until: each.until }] : [];
        }),
      };
    });
  };

  return {
    modes: {
      list: async (options = {}) => hub.modeStore.list(options).map(viewOf),

      async add(input) {
        if (!MODE_AXES.includes(input.axis)) throw new ApiError('invalid', 'A mode is of presence or of the day');
        if (input.key !== undefined && !MODE_KEY.test(input.key)) throw new ApiError('invalid', 'A mode’s key is lowercase letters, digits and dashes, from a letter: "guests-over"');
        if (input.key !== undefined && hub.modeStore.keyTaken(input.key)) throw new ApiError('conflict', `Another mode is "${input.key}" already`);
        const mode = refusing(() => hub.modeStore.add({ ...input, name: name(input.name) }));
        record('mode.added', 'mode', mode.id, `Added the mode ${mode.name}`);
        return viewOf(mode);
      },

      async update(id, changes) {
        const was = modeOf(id);
        if (was.builtIn) throw new ApiError('invalid', `${was.name} is built in: it is as it is`);
        if (changes.key !== undefined && changes.key !== was.key && hub.modeStore.keyTaken(changes.key, id)) throw new ApiError('conflict', `Another mode is "${changes.key}" already`);
        const mode = refusing(() => hub.modeStore.update(id, { ...changes, ...(changes.name !== undefined ? { name: name(changes.name) } : {}) }))!;
        record('mode.changed', 'mode', id, `Changed the mode ${mode.name}: ${Object.keys(changes).join(', ')}`);
        return viewOf(mode);
      },

      async remove(id) {
        const was = modeOf(id);
        if (was.builtIn) throw new ApiError('invalid', `${was.name} is built in: it stays`);
        const mode = hub.modeStore.remove(id)!;
        record('mode.removed', 'mode', id, `Let the mode ${was.name} go`);
        return viewOf(mode);
      },

      of: async (homeId) => of(homeOf(homeId).id),

      async set(homeId, input) {
        const home = homeOf(homeId);
        const mode = hub.modeStore.get(input.mode) ?? hub.modeStore.byKey(input.mode);
        if (!mode || mode.removedAt) throw new ApiError('invalid', `There is no mode "${input.mode}"`);
        const from = input.from ?? new Date().toISOString();
        if (input.until && input.until <= from) throw new ApiError('invalid', 'A mode ends after it begins');
        refusing(() => hub.modes.set(home.id, mode.id, by, from, input.until ?? null));
        const when = input.from ? ` from ${input.from}${input.until ? ` until ${input.until}` : ''}` : input.until ? ` until ${input.until}` : '';
        record('home.mode', 'home', home.id, `${home.name} is ${mode.name}${when}`);
        return of(home.id);
      },
    },
  };
}
