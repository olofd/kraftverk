import { ApiError, type Caller, type HomeModeView, type KraftverkApi, type ModeView } from '@kraftverk/api-contract';
import { MODE_AXES, MODE_KEY } from '@kraftverk/device-sdk';
import type { ModeRecord } from '@kraftverk/store';

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
  const now = () => new Date(hub.clock.now()).toISOString();
  const record = (kind: string, resourceKind: 'mode' | 'home', resource: string, summary: string) => hub.audit.record({ at: now(), kind, actor: by, resourceKind, resource, summary });
  /** The family's modes changed: every screen that offers them reads them again. */
  const listChanged = () => hub.bus.publish({ kind: 'modes', at: now() });
  /** A time as it is kept: an instant, in UTC — however it was written. */
  const instant = (text: string, what: string): string => {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) throw new ApiError('invalid', `${what} is not a time: "${text}"`);
    return new Date(at).toISOString();
  };
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
    const at = now();
    return MODE_AXES.map((axis) => {
      const kept = hub.modeStore.at(homeId, axis, at);
      const mode = kept ? hub.modeStore.get(kept.modeId) : null;
      return {
        axis,
        mode: mode ? viewOf(mode) : null,
        since: kept?.since ?? null,
        by: kept?.by.name ?? null,
        ahead: hub.modeStore.ahead(homeId, axis, at).flatMap((each) => {
          const coming = hub.modeStore.get(each.modeId);
          return coming ? [{ mode: viewOf(coming), from: each.since, until: each.until, planned: each.planned }] : [];
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
        listChanged();
        return viewOf(mode);
      },

      async update(id, changes) {
        const was = modeOf(id);
        if (was.builtIn) throw new ApiError('invalid', `${was.name} is built in: it is as it is`);
        if (changes.key !== undefined && changes.key !== was.key && hub.modeStore.keyTaken(changes.key, id)) throw new ApiError('conflict', `Another mode is "${changes.key}" already`);
        const mode = refusing(() => hub.modeStore.update(id, { ...changes, ...(changes.name !== undefined ? { name: name(changes.name) } : {}) }))!;
        record('mode.changed', 'mode', id, `Changed the mode ${mode.name}: ${Object.keys(changes).join(', ')}`);
        listChanged();
        return viewOf(mode);
      },

      async remove(id) {
        const was = modeOf(id);
        if (was.builtIn) throw new ApiError('invalid', `${was.name} is built in: it stays`);
        const mode = hub.modeStore.remove(id, now())!;
        record('mode.removed', 'mode', id, `Let the mode ${was.name} go`);
        listChanged();
        return viewOf(mode);
      },

      of: async (homeId) => of(homeOf(homeId).id),

      async set(homeId, input) {
        const home = homeOf(homeId);
        const mode = hub.modeStore.get(input.mode) ?? hub.modeStore.byKey(input.mode);
        if (!mode || mode.removedAt) throw new ApiError('invalid', `There is no mode "${input.mode}"`);
        const from = input.from === undefined ? now() : instant(input.from, 'From');
        const until = input.until ? instant(input.until, 'Until') : null;
        if (until && until <= from) throw new ApiError('invalid', 'A mode ends after it begins');
        refusing(() => hub.modes.set(home.id, mode.id, by, from, until));
        const when = input.from ? ` from ${from}${until ? ` until ${until}` : ''}` : until ? ` until ${until}` : '';
        record('home.mode', 'home', home.id, `${home.name} is ${mode.name}${when}`);
        return of(home.id);
      },

      async cancel(homeId, input) {
        const home = homeOf(homeId);
        if (!MODE_AXES.includes(input.axis)) throw new ApiError('invalid', 'A mode is of presence or of the day');
        const from = instant(input.from, 'From');
        const planned = hub.modeStore.ahead(home.id, input.axis, now()).find((each) => each.since === from && each.planned);
        if (!planned) throw new ApiError('not-found', 'Nothing is planned then');
        hub.modes.cancel(home.id, input.axis, from);
        record('home.mode', 'home', home.id, `${home.name}: ${hub.modeStore.get(planned.modeId)?.name ?? 'a mode'} from ${from} let go`);
        return of(home.id);
      },
    },
  };
}
