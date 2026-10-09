import { useMemo } from 'react';

import type { ModeView, PersonView, ZoneView } from '@kraftverk/api-client';
import { ANYONE, EVERYONE, OWN_HOME, worldRole, type AutomationDraft, type PlaceKind, type WorldFill, type WorldNames } from '@kraftverk/automation';

import { useAnswer } from '../../../components/useAnswer';
import { useFamily } from '../../../state/FamilyProvider';
import { useHomeSpaces } from '../../../state/useHomeSpaces';

/*
  The family's world, as the automation editor offers it: its people, its
  places — homes, zones, the rooms of each home — and its modes; and, for
  a block, what may stand where it names who or where: a word for the whole
  family, a role the draft has, or one of them, made a role as it is picked.
*/

export type WorldOptions = {
  people: readonly { id: string; name: string }[];
  places: readonly { id: string; kind: PlaceKind; name: string; subtitle: string }[];
  modes: readonly { key: string; name: string; axis: ModeView['axis'] }[];
  /** How a draft's sentences name them. */
  names: WorldNames;
};

const NO_WORLD: WorldOptions = { people: [], places: [], modes: [], names: { person: () => null, place: () => null } };

const KINDS: Record<PlaceKind, string> = { home: 'A home', zone: 'A zone', space: 'A room' };

/** The family's people, places and modes, read once for the editor; null until read. */
export function useWorldOptions(): WorldOptions | null {
  const { api } = useFamily();
  const { homes } = useHomeSpaces();
  const read = useAnswer(() => Promise.all([api.people.list(), api.zones.list(), api.modes.list()]), [api]);
  return useMemo(() => {
    if (!read.value || !homes) return read.error ? NO_WORLD : null;
    const [people, zones, modes] = read.value as [PersonView[], ZoneView[], ModeView[]];
    const members = people.filter((person) => person.member).map((person) => ({ id: person.id, name: person.shownAs }));
    const places = [
      ...homes.map(({ home }) => ({ id: home.id, kind: 'home' as const, name: home.name, subtitle: KINDS.home })),
      ...zones.map((zone) => ({ id: zone.id, kind: 'zone' as const, name: zone.name, subtitle: KINDS.zone })),
      ...homes.flatMap(({ home, spaces }) => spaces.filter((space) => space.kind !== 'site').map((space) => ({ id: space.id, kind: 'space' as const, name: space.name, subtitle: `In ${home.name}` }))),
    ];
    return {
      people: members,
      places,
      modes: modes.map((mode) => ({ key: mode.key, name: mode.name, axis: mode.axis })),
      names: { person: (id) => members.find((person) => person.id === id)?.name ?? null, place: (id) => places.find((place) => place.id === id)?.name ?? null },
    };
  }, [read.value, read.error, homes]);
}

/** One choice where a block names who or where: a word, a role it has, or one made as it is picked. */
export type WorldChoice = { key: string; title: string; subtitle?: string; pick: (draft: AutomationDraft) => { draft: AutomationDraft; value: string } };

const kept = (value: string) => (draft: AutomationDraft) => ({ draft, value });
const made = (fill: WorldFill, label: string) => (draft: AutomationDraft) => {
  const picked = worldRole(draft, fill, label);
  return { draft: picked.draft, value: picked.role };
};

/** Who a block may name: the whole family's word where it takes one, the draft's people, and each of the family. */
export function whoChoices(world: WorldOptions, draft: AutomationDraft, name: (role: string) => string, options: { anyone?: string; crowd?: boolean }): WorldChoice[] {
  const words: WorldChoice[] = options.anyone === ANYONE ? [{ key: ANYONE, title: 'Someone', subtitle: 'Anyone of the family', pick: kept(ANYONE) }] : options.anyone === EVERYONE ? [{ key: EVERYONE, title: 'Everyone', subtitle: 'Everyone in the family', pick: kept(EVERYONE) }] : [];
  const roles = Object.entries(draft.rule.roles)
    .filter(([, spec]) => ('people' in spec && spec.people) || (!options.crowd && 'person' in spec && spec.person))
    .map(([role, spec]): WorldChoice => ({ key: `role:${role}`, title: name(role), subtitle: spec.label, pick: kept(role) }));
  const filled = new Set(Object.values(draft.world ?? {}).map((fill) => JSON.stringify(fill)));
  const people = world.people
    .filter((person) => !filled.has(JSON.stringify(options.crowd ? { people: [person.id] } : { person: person.id })))
    .map((person): WorldChoice => ({ key: `person:${person.id}`, title: person.name, ...(options.crowd ? { subtitle: 'Only them' } : {}), pick: made(options.crowd ? { people: [person.id] } : { person: person.id }, person.name) }));
  const everyone: WorldChoice[] = options.crowd && !filled.has(JSON.stringify({ everyone: true })) ? [{ key: 'everyone', title: 'Everyone in the family', subtitle: 'Whoever joins too', pick: made({ everyone: true }, 'Everyone') }] : [];
  return [...words, ...everyone, ...roles, ...people];
}

/** Where a block may name: the automation's own home, the draft's places, and each of the family's. */
export function placeChoices(world: WorldOptions, draft: AutomationDraft, name: (role: string) => string): WorldChoice[] {
  const roles = Object.entries(draft.rule.roles)
    .filter(([, spec]) => 'place' in spec && spec.place)
    .map(([role, spec]): WorldChoice => ({ key: `role:${role}`, title: name(role), subtitle: spec.label, pick: kept(role) }));
  const filled = new Set(Object.values(draft.world ?? {}).flatMap((fill) => ('place' in fill ? [fill.place] : [])));
  const places = world.places.filter((place) => !filled.has(place.id)).map((place): WorldChoice => ({ key: `place:${place.id}`, title: place.name, subtitle: place.subtitle, pick: made({ place: place.id, kind: place.kind }, place.name) }));
  return [{ key: OWN_HOME, title: 'Home', subtitle: 'The home this automation is for', pick: kept(OWN_HOME) }, ...roles, ...places];
}

/** What may fill a role of the world anew, as the Uses list offers it. */
export function fillChoices(world: WorldOptions, kind: 'person' | 'people' | 'place'): { key: string; title: string; subtitle?: string; fill: WorldFill }[] {
  if (kind === 'place') return world.places.map((place) => ({ key: place.id, title: place.name, subtitle: place.subtitle, fill: { place: place.id, kind: place.kind } }));
  if (kind === 'person') return world.people.map((person) => ({ key: person.id, title: person.name, fill: { person: person.id } }));
  return [{ key: 'everyone', title: 'Everyone in the family', subtitle: 'Whoever joins too', fill: { everyone: true } }, ...world.people.map((person) => ({ key: person.id, title: person.name, subtitle: 'Only them', fill: { people: [person.id] } }))];
}
