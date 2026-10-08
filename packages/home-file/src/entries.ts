import type { AutomationMode, Rule } from '@kraftverk/automation';

import type { AutomationEntry, DeviceEntry, PlaceEntry, Scalar, SecretValue } from './document.ts';
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
  homePlace: number | null;
  madeFrom: string | null;
  rule: Rule;
  /** What fills each part role: a device by its id, and which of its parts. */
  roles: Readonly<Record<string, { device: string; part: string }>>;
  /** The parts filling each group, in order: each a device by its id, and which of its parts. */
  groups: Readonly<Record<string, readonly { device: string; part: string }[]>>;
  /** What fills each automation role: an automation by its id. */
  starts: Readonly<Record<string, string>>;
};

/**
 * An automation as its entry: each role by the key of what fills it. A role
 * whose device or automation has gone is left unfilled — written as such —
 * and said, by role, in `gone`.
 */
export function automationEntryFrom(
  source: AutomationSource,
  keyOf: { device: (id: string) => string | null; automation: (id: string) => string | null; home?: (id: string) => string | null }
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
  return {
    entry: {
      name: source.name,
      mode: source.mode,
      home: source.homeId ? (keyOf.home?.(source.homeId) ?? null) : null,
      clock: source.ownTimeZone,
      recheckMinutes: source.recheckMinutes,
      homePlace: source.homePlace,
      madeFrom: source.madeFrom,
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
  idOf: { device: (key: string) => string | null; automation: (key: string) => string | null }
): { roles: Record<string, { device: string; part: string }>; groups: Record<string, { device: string; part: string }[]>; starts: Record<string, string>; missing: { role: string; key: string }[] } {
  const roles: Record<string, { device: string; part: string }> = {};
  const groups: Record<string, { device: string; part: string }[]> = {};
  const starts: Record<string, string> = {};
  const missing: { role: string; key: string }[] = [];
  for (const [role, use] of Object.entries(uses)) {
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
  return { roles, groups, starts, missing };
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
    settings: scalars(device.config),
    connect: ways.map((way) => ({ via: way.method, through: way.through, address: way.fixedAddress ? null : way.address, settings: scalars(way.config), secrets: way.secrets, exportable: way.exportable })),
  };
}
