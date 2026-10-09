import type { AuditRecord, Actor, Clock } from '@kraftverk/device-sdk';
import { REAL_CLOCK } from '@kraftverk/device-sdk';
import type { EnginePlace, EngineWorld } from '@kraftverk/automation-engine';
import { PLACE_KINDS, type PlaceKind, type RuleMode, type VariableSpec, type WorldFill } from '@kraftverk/automation';
import type { ModeStore, NotificationStore, OccupancyStore, PeopleStore, PlaceStore, PresenceStore, SpaceStore } from '@kraftverk/store';

import type { Modes } from '../modes/modes.ts';
import type { Variables } from '../variables/variables.ts';
import { tell, type PushSender } from '../notifications/notify.ts';
import { whereabouts, type Whereabouts } from '../presence/whereabouts.ts';

/*
  The family's world, as its automations see it (docs/PLAN-WORLD-MODEL.md
  §8.9, §8.10): who is where — the one answer of where everyone is, as far
  as each shares (presence/whereabouts.ts), and who cannot be told — whether
  a place has anyone in it, a home's modes; and what an automation does
  there besides its devices: set a mode, on the timeline as its own, and
  tell people, in their inbox and by a push. And, for a draft, whether what
  fills a role of the world is there at all.

  Where everyone is is read once for everything that asks in the same turn
  — every automation hearing the same arrival — and again after.
*/

export type WorldDeps = {
  people: Pick<PeopleStore, 'members' | 'get'>;
  places: Pick<PlaceStore, 'home' | 'homes' | 'zone' | 'zones'>;
  spaces: Pick<SpaceStore, 'space' | 'spaces'>;
  stays: Pick<PresenceStore, 'allOpen' | 'allRooms'>;
  occupancies: Pick<OccupancyStore, 'open'>;
  modes: Pick<Modes, 'now' | 'set'>;
  modeStore: Pick<ModeStore, 'list'>;
  variables: Pick<Variables, 'specs' | 'now' | 'set'>;
  notifications: NotificationStore;
  push: PushSender | null;
  record: (entry: AuditRecord) => void;
  clock?: Clock;
};

/** What a draft asks of the world: whether what fills a role is there, and what it is called. */
export type WorldDirectory = {
  /** A member's name; null for one who is not in the family. */
  member(id: string): string | null;
  /** A place's name; null for one that is not there, or let go. */
  place(id: string, kind: EnginePlace['kind']): string | null;
  /** The home a space is of; null for one that is not there. */
  homeOfSpace(spaceId: string): string | null;
  /** The home an automation is for — none said, the family's first; one let go, none. */
  home(homeId: string | null): string | null;
  modes(): readonly RuleMode[];
  /** The home a place is, or is in; null for one that is neither. */
  homeOf(at: EnginePlace): string | null;
  /** A home's variables, as the language sees them. */
  variables(homeId: string): readonly VariableSpec[];
};

export function familyWorld(deps: WorldDeps): EngineWorld & WorldDirectory {
  const clock = deps.clock ?? REAL_CLOCK;
  // Read once for everything asked in the same turn — every automation hearing one arrival — and again after.
  let known: readonly Whereabouts[] | null = null;
  const everyone = (): readonly Whereabouts[] => {
    if (!known) {
      known = whereabouts(deps);
      queueMicrotask(() => (known = null));
    }
    return known;
  };

  const member = (id: string): string | null => {
    const person = deps.people.get(id);
    return person?.member ? person.shownAs : null;
  };
  const liveHome = (id: string) => {
    const home = deps.places.home(id);
    return home && !home.removedAt ? home : null;
  };
  const place = (id: string, kind: EnginePlace['kind']): string | null => {
    if (kind === 'home') return liveHome(id)?.name ?? null;
    if (kind === 'zone') {
      const zone = deps.places.zone(id);
      return zone && !zone.removedAt ? zone.name : null;
    }
    const space = deps.spaces.space(id);
    return space && !space.removedAt && liveHome(space.homeId) ? space.name : null;
  };
  const homeOfSpace = (spaceId: string): string | null => {
    const space = deps.spaces.space(spaceId);
    return space && !space.removedAt ? space.homeId : null;
  };
  const homeOf = (at: EnginePlace): string | null => (at.kind === 'home' ? at.id : at.kind === 'space' ? homeOfSpace(at.id) : null);
  /** Whether a space is another, or within it: walked up its home's tree. */
  const spaceWithin = (spaceId: string, outerId: string): boolean => {
    if (spaceId === outerId) return true;
    const home = homeOfSpace(spaceId);
    if (!home) return false;
    const byId = new Map(deps.spaces.spaces(home).map((space) => [space.id, space]));
    for (let at = byId.get(spaceId), depth = 0; at && depth < 64; at = at.parentId ? byId.get(at.parentId) : undefined, depth++) if (at.id === outerId) return true;
    return false;
  };
  const within = (inner: EnginePlace, outer: EnginePlace): boolean => (inner.kind === 'space' && outer.kind === 'space' ? spaceWithin(inner.id, outer.id) : inner.kind === outer.kind && inner.id === outer.id);

  const whoAt = (at: EnginePlace): { at: string[]; unknown: string[] } | null => {
    if (!place(at.id, at.kind)) return null;
    const there: string[] = [];
    const unknown: string[] = [];
    for (const person of everyone()) {
      if (!person.tells[at.kind]) {
        unknown.push(person.personId);
        continue;
      }
      const is =
        at.kind === 'home' ? person.home?.id === at.id : at.kind === 'zone' ? person.zones.some((zone) => zone.id === at.id) : person.room !== null && spaceWithin(person.room.spaceId, at.id);
      if (is) there.push(person.personId);
    }
    return { at: there, unknown };
  };

  return {
    // None said, the family's first; one let go, none: it does not stand in for another.
    home: (homeId) => (homeId ? (liveHome(homeId)?.id ?? null) : (deps.places.homes()[0]?.id ?? null)),
    members: () => deps.people.members().map((person) => person.id),
    personName: (id) => deps.people.get(id)?.shownAs ?? null,
    placeName: (at) => place(at.id, at.kind),
    homeOf,
    within,
    whoAt,
    occupied: (at) => {
      if (!place(at.id, at.kind)) return null;
      if (at.kind === 'space') {
        const home = homeOf(at);
        return home ? deps.occupancies.open(home).some((record) => record.spaceId === at.id) || (whoAt(at)?.at.length ?? 0) > 0 : null;
      }
      // A home has someone in it when its sensors say so, or someone is at it; a zone, when someone is.
      if (at.kind === 'home' && deps.occupancies.open(at.id).some((record) => deps.spaces.space(record.spaceId)?.kind === 'site')) return true;
      const there = whoAt(at);
      if (!there) return null;
      return there.at.length > 0 ? true : there.unknown.length ? null : false;
    },
    mode: (homeId, axis) => deps.modes.now(homeId, axis),
    modes: () => deps.modeStore.list().map((mode) => ({ key: mode.key, axis: mode.axis, name: mode.name })),
    setMode(homeId, mode, by, cause) {
      deps.modes.set(homeId, mode, by as Actor, undefined, undefined, cause);
      const home = deps.places.home(homeId);
      deps.record({ at: new Date(clock.now()).toISOString(), kind: 'home.mode', actor: by as Actor, resourceKind: 'home', resource: homeId, summary: `${home?.name ?? 'The home'} is ${mode}` });
    },
    variables: (homeId) => deps.variables.specs(homeId),
    variable: (homeId, key) => deps.variables.now(homeId, key),
    // An automation's set is a line of its run, not the timeline's: as its devices' commands are.
    setVariable: (homeId, key, value, by, cause) => void deps.variables.set(homeId, key, value, by as Actor, cause),
    notify(people, message, by) {
      const told = [...new Set(people)].filter((person) => member(person));
      for (const person of told) tell(deps.notifications, deps.push, person, { title: message.title, body: message.text, level: message.level, homeId: message.homeId, from: by as Actor });
      return { told };
    },
    member,
    place,
    homeOfSpace,
  };
}

/**
 * Whether what fills a role of the world is there: a member, members — or
 * everyone — a place not let go; a space, of the automation's home. Null:
 * it is; else why not.
 */
export function worldFillProblem(directory: WorldDirectory, label: string, kind: 'person' | 'people' | 'place', fill: WorldFill | undefined, homeId: string | null, kinds: readonly PlaceKind[] = PLACE_KINDS): string | null {
  if (!fill) return `${label}: choose ${kind === 'place' ? 'a place' : kind === 'person' ? 'someone' : 'who'}`;
  if (kind === 'person') return 'person' in fill && directory.member(fill.person) ? null : `${label}: choose someone in the family`;
  if (kind === 'people') {
    if ('everyone' in fill) return null;
    if (!('people' in fill) || !fill.people.length) return `${label}: choose who — some of you, or everyone`;
    return fill.people.every((id) => directory.member(id)) ? null : `${label}: someone chosen is not in the family`;
  }
  if (!('place' in fill) || !directory.place(fill.place, fill.kind)) return `${label}: choose a home, a zone or a room that is there`;
  // What the rule asks of it: a mode is a home's.
  if (!kinds.includes(fill.kind)) return `${label}: choose ${kinds.length === 1 ? { home: 'a home', zone: 'a zone', space: 'a room' }[kinds[0]!] : kinds.map((each) => ({ home: 'a home', zone: 'a zone', space: 'a room' })[each]).join(' or ')}`;
  // A room is of a home: the automation's own — one for the whole family names its home first.
  if (fill.kind === 'space' && directory.homeOfSpace(fill.place) !== homeId) return homeId ? `${label}: choose a room of the automation’s own home` : `${label}: a room is of a home — say which home the automation is for`;
  return null;
}
