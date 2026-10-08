import type { AuditRecord, Actor } from '@kraftverk/device-sdk';
import type { EnginePlace, EngineWorld } from '@kraftverk/automation-engine';
import type { WorldFill } from '@kraftverk/automation';
import type { ModeStore, NotificationStore, OccupancyStore, PeopleStore, PlaceStore, PresenceStore, SpaceStore } from '@kraftverk/store';

import type { Modes } from '../modes/modes.ts';
import { notify, type PushSender } from '../notifications/notify.ts';

/*
  The family's world, as its automations see it (docs/PLAN-WORLD-MODEL.md
  §8.9, §8.10): who is where — by the stays presence keeps, which are only
  what each person shares — whether a place has anyone in it, a home's modes;
  and what an automation does there besides its devices: set a mode, on the
  timeline as its own, and tell people, in their inbox and by a push. And,
  for a draft, whether what fills a role of the world is there at all.
*/

export type WorldDeps = {
  people: Pick<PeopleStore, 'members' | 'get'>;
  places: Pick<PlaceStore, 'home' | 'homes' | 'zone'>;
  spaces: Pick<SpaceStore, 'space' | 'spaces'>;
  stays: Pick<PresenceStore, 'allOpen' | 'rooms'>;
  occupancies: Pick<OccupancyStore, 'open'>;
  modes: Pick<Modes, 'now' | 'set'>;
  modeStore: Pick<ModeStore, 'list'>;
  notifications: NotificationStore;
  push: PushSender | null;
  record: (entry: AuditRecord) => void;
};

/** What a draft asks of the world: whether what fills a role is there, and what it is called. */
export type WorldDirectory = {
  /** A member's name; null for one who is not in the family. */
  member(id: string): string | null;
  /** A place's name; null for one that is not there, or let go. */
  place(id: string, kind: EnginePlace['kind']): string | null;
  modes(): readonly string[];
};

export function familyWorld(deps: WorldDeps): EngineWorld & WorldDirectory {
  const member = (id: string): string | null => {
    const person = deps.people.get(id);
    return person?.member ? person.shownAs : null;
  };
  const place = (id: string, kind: EnginePlace['kind']): string | null => {
    if (kind === 'home') {
      const home = deps.places.home(id);
      return home && !home.removedAt ? home.name : null;
    }
    if (kind === 'zone') {
      const zone = deps.places.zone(id);
      return zone && !zone.removedAt ? zone.name : null;
    }
    const space = deps.spaces.space(id);
    return space && !space.removedAt ? space.name : null;
  };
  const homeOf = (at: EnginePlace): string | null => (at.kind === 'home' ? at.id : at.kind === 'space' ? (deps.spaces.space(at.id)?.homeId ?? null) : null);
  /** A space, and every space within it: what someone in a room of a floor is in. */
  const within = (spaceId: string): Set<string> => {
    const home = deps.spaces.space(spaceId)?.homeId;
    const ids = new Set([spaceId]);
    if (!home) return ids;
    const tree = deps.spaces.spaces(home);
    for (let grew = true; grew; ) {
      grew = false;
      for (const space of tree) if (space.parentId && ids.has(space.parentId) && !ids.has(space.id)) (ids.add(space.id), (grew = true));
    }
    return ids;
  };
  const peopleAt = (at: EnginePlace): readonly string[] => {
    if (at.kind === 'space') {
      const home = homeOf(at);
      const inside = within(at.id);
      return home ? [...new Set(deps.stays.rooms(home).filter((stay) => inside.has(stay.spaceId)).map((stay) => stay.personId))] : [];
    }
    return [...new Set(deps.stays.allOpen().filter((stay) => stay.placeId === at.id).map((stay) => stay.personId))];
  };
  return {
    home: (homeId) => {
      const own = homeId ? deps.places.home(homeId) : null;
      return own && !own.removedAt ? own.id : (deps.places.homes()[0]?.id ?? null);
    },
    members: () => deps.people.members().map((person) => person.id),
    personName: (id) => deps.people.get(id)?.shownAs ?? null,
    placeName: (at) => place(at.id, at.kind),
    homeOf,
    peopleAt,
    occupied: (at) => {
      if (at.kind === 'space') {
        const home = homeOf(at);
        return home ? deps.occupancies.open(home).some((record) => record.spaceId === at.id) || peopleAt(at).length > 0 : null;
      }
      // A home has someone in it when its sensors say so, or someone is at it; a zone, when someone is.
      if (at.kind === 'home' && deps.occupancies.open(at.id).some((record) => deps.spaces.space(record.spaceId)?.kind === 'site')) return true;
      return peopleAt(at).length > 0;
    },
    mode: (homeId, axis) => deps.modes.now(homeId, axis),
    modes: () => deps.modeStore.list().map((mode) => mode.key),
    setMode(homeId, mode, by) {
      deps.modes.set(homeId, mode, by as Actor);
      const home = deps.places.home(homeId);
      deps.record({ at: new Date().toISOString(), kind: 'home.mode', actor: by as Actor, resourceKind: 'home', resource: homeId, summary: `${home?.name ?? 'The home'} is ${mode}` });
    },
    async notify(people, message, by) {
      for (const person of new Set(people)) {
        if (!member(person)) continue;
        await notify(deps.notifications, deps.push, person, { title: message.title, body: message.text, level: message.level, homeId: message.homeId, from: by as Actor });
      }
    },
    member,
    place,
  };
}

/** Whether what fills a role of the world is there: a member, members — or everyone — a place not let go. Null: it is; else why not. */
export function worldFillProblem(directory: WorldDirectory, label: string, kind: 'person' | 'people' | 'place', fill: WorldFill | undefined): string | null {
  if (!fill) return `${label}: choose ${kind === 'place' ? 'a place' : kind === 'person' ? 'someone' : 'who'}`;
  if (kind === 'person') return 'person' in fill && directory.member(fill.person) ? null : `${label}: choose someone in the family`;
  if (kind === 'people') {
    if ('everyone' in fill) return null;
    if (!('people' in fill) || !fill.people.length) return `${label}: choose who — some of you, or everyone`;
    return fill.people.every((id) => directory.member(id)) ? null : `${label}: someone chosen is not in the family`;
  }
  return 'place' in fill && directory.place(fill.place, fill.kind) ? null : `${label}: choose a home, a zone or a room that is there`;
}
