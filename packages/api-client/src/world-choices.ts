import type { ModeView, PersonView, ZoneView } from '@kraftverk/api-contract';
import { ANYONE, EVERYONE, OWN_HOME, PLACE_KINDS, sameFill, worldRole, type AutomationDraft, type PlaceKind, type WorldFill, type WorldNames } from '@kraftverk/automation';

import type { HomeSpaces } from './spaces.ts';

/*
  The family's world, as an automation editor offers it (docs/AUTOMATION-EDITOR.md):
  its people, its places — homes, zones, the rooms of each home — and its
  modes; and, for a block, what may stand where it names who or where: a
  word for the whole family, a role the draft has, or one of them, made a
  role as it is picked — only the kinds of place it may be, and only the
  rooms of the automation's own home. Any editor's: the app's, an
  assistant's.
*/

export type WorldOptions = {
  people: readonly { id: string; name: string }[];
  places: readonly { id: string; kind: PlaceKind; name: string; subtitle: string; homeId: string | null }[];
  modes: readonly { key: string; name: string; axis: ModeView['axis'] }[];
  /** How a draft's sentences name them. */
  names: WorldNames;
};

export const NO_WORLD: WorldOptions = { people: [], places: [], modes: [], names: { person: () => null, place: () => null } };

const KINDS: Record<PlaceKind, string> = { home: 'A home', zone: 'A zone', space: 'A room' };

/** The family's people, places and modes, as an editor offers them: members, each home and its rooms, the zones. */
export function worldOptionsOf(people: readonly PersonView[], zones: readonly ZoneView[], modes: readonly ModeView[], homes: readonly HomeSpaces[]): WorldOptions {
  const members = people.filter((person) => person.member).map((person) => ({ id: person.id, name: person.shownAs }));
  const places = [
    ...homes.map(({ home }) => ({ id: home.id, kind: 'home' as const, name: home.name, subtitle: KINDS.home, homeId: home.id })),
    ...zones.map((zone) => ({ id: zone.id, kind: 'zone' as const, name: zone.name, subtitle: KINDS.zone, homeId: null })),
    ...homes.flatMap(({ home, spaces }) => spaces.filter((space) => space.kind !== 'site').map((space) => ({ id: space.id, kind: 'space' as const, name: space.name, subtitle: `In ${home.name}`, homeId: home.id }))),
  ];
  return {
    people: members,
    places,
    modes: modes.map((mode) => ({ key: mode.key, name: mode.name, axis: mode.axis })),
    names: { person: (id) => members.find((person) => person.id === id)?.name ?? null, place: (id) => places.find((place) => place.id === id)?.name ?? null },
  };
}

/** What a place may be, where a block or a role names one: these kinds — and a room, one of the automation's own home: the one it is for, or the family's first. */
export type PlaceScope = { kinds?: readonly PlaceKind[]; homeId: string | null };

/** The places that may stand where one is named. */
const placesIn = (world: WorldOptions, scope: PlaceScope) => {
  const kinds = scope.kinds ?? PLACE_KINDS;
  const home = scope.homeId ?? world.places.find((place) => place.kind === 'home')?.id ?? null;
  return world.places.filter((place) => kinds.includes(place.kind) && (place.kind !== 'space' || place.homeId === home));
};

/** One choice where a block names who or where: a word, a role it has, or one made as it is picked. */
export type WorldChoice = { key: string; title: string; subtitle?: string; pick: (draft: AutomationDraft) => { draft: AutomationDraft; value: string } };

const kept = (value: string) => (draft: AutomationDraft) => ({ draft, value });
const made = (fill: WorldFill, label: string) => (draft: AutomationDraft) => {
  const picked = worldRole(draft, fill, label);
  return { draft: picked.draft, value: picked.role };
};
/** Whether the draft has a role filled so already. */
const filledSo = (draft: AutomationDraft, fill: WorldFill) => Object.values(draft.world ?? {}).some((had) => sameFill(had, fill));

/** Who a block may name: the whole family's word where it takes one, the draft's people, and each of the family. */
export function whoChoices(world: WorldOptions, draft: AutomationDraft, name: (role: string) => string, options: { anyone?: string; crowd?: boolean }): WorldChoice[] {
  const words: WorldChoice[] = options.anyone === ANYONE ? [{ key: ANYONE, title: 'Someone', subtitle: 'Anyone of the family', pick: kept(ANYONE) }] : options.anyone === EVERYONE ? [{ key: EVERYONE, title: 'Everyone', subtitle: 'Everyone in the family', pick: kept(EVERYONE) }] : [];
  const roles = Object.entries(draft.rule.roles)
    .filter(([, spec]) => ('people' in spec && spec.people) || (!options.crowd && 'person' in spec && spec.person))
    .map(([role, spec]): WorldChoice => ({ key: `role:${role}`, title: name(role), subtitle: spec.label, pick: kept(role) }));
  const fillOf = (id: string): WorldFill => (options.crowd ? { people: [id] } : { person: id });
  const people = world.people
    .filter((person) => !filledSo(draft, fillOf(person.id)))
    .map((person): WorldChoice => ({ key: `person:${person.id}`, title: person.name, ...(options.crowd ? { subtitle: 'Only them' } : {}), pick: made(fillOf(person.id), person.name) }));
  const everyone: WorldChoice[] = options.crowd && !filledSo(draft, { everyone: true }) ? [{ key: 'everyone', title: 'Everyone in the family', subtitle: 'Whoever joins too', pick: made({ everyone: true }, 'Everyone') }] : [];
  return [...words, ...everyone, ...roles, ...people];
}

/** Where a block may name: the automation's own home, the draft's places, and each of the family's it may be. */
export function placeChoices(world: WorldOptions, draft: AutomationDraft, name: (role: string) => string, scope: PlaceScope): WorldChoice[] {
  const roles = Object.entries(draft.rule.roles)
    .filter(([, spec]) => 'place' in spec && spec.place)
    .map(([role, spec]): WorldChoice => ({ key: `role:${role}`, title: name(role), subtitle: spec.label, pick: kept(role) }));
  const places = placesIn(world, scope)
    .filter((place) => !filledSo(draft, { place: place.id, kind: place.kind }))
    .map((place): WorldChoice => ({ key: `place:${place.id}`, title: place.name, subtitle: place.subtitle, pick: made({ place: place.id, kind: place.kind }, place.name) }));
  const own: WorldChoice[] = (scope.kinds ?? PLACE_KINDS).includes('home') ? [{ key: OWN_HOME, title: 'Home', subtitle: 'The home this automation is for', pick: kept(OWN_HOME) }] : [];
  return [...own, ...roles, ...places];
}

/** What may fill a role of the world anew, as a list of what fills each role offers it. */
export function fillChoices(world: WorldOptions, kind: 'person' | 'people' | 'place', scope: PlaceScope): { key: string; title: string; subtitle?: string; fill: WorldFill }[] {
  if (kind === 'place') return placesIn(world, scope).map((place) => ({ key: place.id, title: place.name, subtitle: place.subtitle, fill: { place: place.id, kind: place.kind } }));
  if (kind === 'person') return world.people.map((person) => ({ key: person.id, title: person.name, fill: { person: person.id } }));
  return [{ key: 'everyone', title: 'Everyone in the family', subtitle: 'Whoever joins too', fill: { everyone: true } }, ...world.people.map((person) => ({ key: person.id, title: person.name, subtitle: 'Only them', fill: { people: [person.id] } }))];
}
