import { keyFrom } from '@kraftverk/device-sdk';
import type { AutomationMode, PlaceKind, Rule, WorldFill, WorldUse } from '@kraftverk/automation';

import type { AutomationEntry, DeviceEntry, DevicePeopleEntry, PlaceEntry, Scalar, SecretValue } from './document.ts';
import type { Use } from '@kraftverk/automation';

/*
  An automation as it lives — its rule, what fills each role by id, its mode
  as the engine says it — and as its entry in a file says it: each role by
  the key of what fills it, its mode in the file's words. Both ways, the same
  on the server, which exports and imports, and in the app, whose editor
  shows one as YAML and saves what is written there.
*/


/** An automation as it lives: what the server keeps, and the app is shown. */
export type AutomationSource = {
  name: string;
  mode: AutomationMode;
  /** The home it is for, by its id; null: the family's. */
  homeId: string | null;
  /** A clock of its own; null: its home's. */
  ownTimeZone: string | null;
  recheckMinutes: number | null;
  madeFrom: string | null;
  /** Its labels' keys, when whoever writes it knows them: the server's export does; one automation's YAML in the app leaves them out. */
  labels?: string[];
  rule: Rule;
  /** What fills each part role: a device by its id, and which of its parts. */
  roles: Readonly<Record<string, { device: string; part: string }>>;
  /** The parts filling each group, in order: each a device by its id, and which of its parts. */
  groups: Readonly<Record<string, readonly { device: string; part: string }[]>>;
  /** What fills each automation role: an automation by its id. */
  starts: Readonly<Record<string, string>>;
  /** Who and where fills each role of the family's world, by id. */
  world?: Readonly<Record<string, WorldFill>>;
};

/**
 * Each person's key in a file, by their id: made from their name, in the
 * order they joined — what an export writes them as, and what one
 * automation's YAML in the app names them by.
 */
export function personKeysOf(people: readonly { id: string; name: string }[]): Map<string, string> {
  const taken = new Set<string>();
  const keys = new Map<string, string>();
  for (const person of people) {
    const key = keyFrom(person.name, (candidate) => taken.has(candidate), 'person');
    taken.add(key);
    keys.set(person.id, key);
  }
  return keys;
}

/**
 * An automation as its entry: each role by the key of what fills it. A role
 * whose device or automation has gone is left unfilled — written as such —
 * and said, by role, in `gone`.
 */
export function automationEntryFrom(
  source: AutomationSource,
  keyOf: {
    device: (id: string) => string | null;
    automation: (id: string) => string | null;
    home?: (id: string) => string | null;
    /** A person's key; none known: the role is left unfilled. */
    person?: (id: string) => string | null;
    /** A zone's or a space's key, by its id. */
    place?: (id: string, kind: PlaceKind) => string | null;
  }
): { entry: AutomationEntry; gone: string[] } {
  const uses: Record<string, Use> = {};
  const gone: string[] = [];
  for (const [role, binding] of Object.entries(source.roles)) {
    const key = keyOf.device(binding.device);
    if (key) uses[role] = { device: key, part: binding.part };
    else gone.push(role);
  }
  // A group keeps the parts still here; one gone is said, by its group.
  for (const [role, parts] of Object.entries(source.groups)) {
    const kept = parts.flatMap((binding) => {
      const key = keyOf.device(binding.device);
      return key ? [{ device: key, part: binding.part }] : [];
    });
    uses[role] = { parts: kept };
    if (kept.length < parts.length) gone.push(role);
  }
  for (const [role, id] of Object.entries(source.starts)) {
    const key = keyOf.automation(id);
    if (key) uses[role] = { automation: key };
    else gone.push(role);
  }
  // A person, people, a place: by their keys — one no longer here said, by its role.
  for (const [role, fill] of Object.entries(source.world ?? {})) {
    if ('everyone' in fill) {
      uses[role] = { everyone: true };
      continue;
    }
    if ('person' in fill || 'people' in fill) {
      const ids = 'person' in fill ? [fill.person] : fill.people;
      const keys = ids.flatMap((id) => keyOf.person?.(id) ?? []);
      if (keys.length < ids.length) gone.push(role);
      if ('person' in fill) {
        if (keys[0]) uses[role] = { person: keys[0] };
      } else uses[role] = { people: keys };
      continue;
    }
    const key = fill.kind === 'home' ? (keyOf.home?.(fill.place) ?? null) : (keyOf.place?.(fill.place, fill.kind) ?? null);
    if (key) uses[role] = { [fill.kind]: key } as WorldUse;
    else gone.push(role);
  }
  return {
    entry: {
      name: source.name,
      mode: source.mode,
      home: source.homeId ? (keyOf.home?.(source.homeId) ?? null) : null,
      clock: source.ownTimeZone,
      recheckMinutes: source.recheckMinutes,
      madeFrom: source.madeFrom,
      labels: source.labels ?? [],
      uses,
      rule: source.rule,
    },
    gone,
  };
}

/**
 * What fills each role, by id, from an entry's keys: each part role's device
 * and part, each automation role's automation — and, by role, each key that
 * names nothing here.
 */
export function fillsFrom(
  uses: Readonly<Record<string, Use>>,
  idOf: {
    device: (key: string) => string | null;
    automation: (key: string) => string | null;
    /** A person's id, by their key. */
    person?: (key: string) => string | null;
    /** A home's, a zone's or — of the automation's home — a space's id, by its key. */
    place?: (kind: PlaceKind, key: string) => string | null;
  }
): {
  roles: Record<string, { device: string; part: string }>;
  groups: Record<string, { device: string; part: string }[]>;
  starts: Record<string, string>;
  world: Record<string, WorldFill>;
  missing: { role: string; key: string }[];
} {
  const roles: Record<string, { device: string; part: string }> = {};
  const groups: Record<string, { device: string; part: string }[]> = {};
  const starts: Record<string, string> = {};
  const world: Record<string, WorldFill> = {};
  const missing: { role: string; key: string }[] = [];
  for (const [role, use] of Object.entries(uses)) {
    // A person, people, a place: by their keys — one not here, said.
    if ('everyone' in use) {
      world[role] = { everyone: true };
      continue;
    }
    if ('person' in use || 'people' in use) {
      const keys = 'person' in use ? [use.person] : use.people;
      const ids = keys.flatMap((key) => {
        const id = idOf.person?.(key) ?? null;
        if (!id) missing.push({ role, key });
        return id ? [id] : [];
      });
      if ('person' in use) {
        if (ids[0]) world[role] = { person: ids[0] };
      } else world[role] = { people: ids };
      continue;
    }
    if ('home' in use || 'zone' in use || 'space' in use) {
      const kind: PlaceKind = 'home' in use ? 'home' : 'zone' in use ? 'zone' : 'space';
      const key = (use as Record<PlaceKind, string>)[kind];
      const id = idOf.place?.(kind, key) ?? null;
      if (id) world[role] = { place: id, kind };
      else missing.push({ role, key });
      continue;
    }
    if ('automation' in use) {
      const id = idOf.automation(use.automation);
      if (id) starts[role] = id;
      else missing.push({ role, key: use.automation });
      continue;
    }
    // A group: each part it names that is here, in order; each that is not, said.
    if ('parts' in use) {
      groups[role] = use.parts.flatMap((part) => {
        const id = idOf.device(part.device);
        if (!id) missing.push({ role, key: part.device });
        return id ? [{ device: id, part: part.part }] : [];
      });
      continue;
    }
    const id = idOf.device(use.device);
    if (id) roles[role] = { device: id, part: use.part };
    else missing.push({ role, key: use.device });
  }
  return { roles, groups, starts, world, missing };
}

/** A device as it lives: what the server keeps, and the app is shown. */
export type DeviceSource = {
  typeId: string;
  name: string;
  identity: string | null;
  picture: string | null;
  pausedAt: string | null;
  trackDays: number | null;
  config: Readonly<Record<string, unknown>>;
  /** Where it stands, by keys, when whoever writes it knows the home's: the server's export does; one device's YAML in the app leaves it out. */
  place?: PlaceEntry | null;
  /** Its labels' keys, likewise. */
  labels?: string[];
  /** Who it is with, by the people's keys in the file, likewise. */
  people?: DevicePeopleEntry | null;
};

/** One way a device is reached, as an entry is written from it: its secrets as asked for — by name, sealed, or plain — and whether its method fixes the address. */
export type WaySource = {
  method: string;
  /** The key of the device it goes through, for a way through a bridge. */
  through: string | null;
  address: string;
  config: Readonly<Record<string, unknown>>;
  secrets: Record<string, SecretValue>;
  exportable: boolean;
  /** Its method has an address of its own — a web API's — which a file does not repeat. */
  fixedAddress: boolean;
};

/** What a file can say of settings: text, numbers, true or false. */
const scalars = (values: Readonly<Record<string, unknown>>): Record<string, Scalar> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, Scalar] => typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'));

/**
 * A device as its entry: what it is, its settings, and the ways given,
 * preferred first — each by its method, its address unless the method fixes
 * one, its settings and its secrets as given. The same on the server, which
 * exports a home, and in the app, which shows one device as YAML.
 */
export function deviceEntryFrom(device: DeviceSource, ways: readonly WaySource[]): DeviceEntry {
  return {
    type: device.typeId,
    name: device.name,
    identity: device.identity,
    picture: device.picture,
    paused: device.pausedAt !== null,
    track: device.trackDays,
    place: device.place ?? null,
    people: device.people ?? null,
    labels: device.labels ?? [],
    settings: scalars(device.config),
    connect: ways.map((way) => ({ via: way.method, through: way.through, address: way.fixedAddress ? null : way.address, settings: scalars(way.config), secrets: way.secrets, exportable: way.exportable })),
  };
}
