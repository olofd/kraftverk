/*
  The document's version, and the way from each to the next (docs/CONFIG.md).

  The configuration is the one thing in kraftverk versioned on purpose: the
  database is evergreen and set aside on any change to its schema, and the
  configuration is what carries a home across that. So a document written
  by an older kraftverk is read by every newer one: `kraftverk: n` at its
  top, and each change to the document's shape adds `MIGRATIONS[n]`, taking
  a version-n document to n + 1, with a kept fixture of version n to test
  it against.
*/

import type { FileMigration, FileTypes } from '@kraftverk/device-sdk';

/** The version this kraftverk writes. */
export const CURRENT_VERSION = 11;

/** Each version's document, as data, made into the next version's. */
export const MIGRATIONS: Readonly<Record<number, (document: Record<string, unknown>) => Record<string, unknown>>> = {
  1: (document) => ({ ...document, automations: renamedMeanings(document.automations, MEANINGS_1_TO_2) }),
  2: (document) => ({ ...document, automations: withoutRoleDescriptions(document.automations) }),
  3: (document) => ({ ...document, automations: inTextsOf(document.automations, plainerExpressions) }),
  // Version 5 may say a way goes through another device (`through:`): nothing older does, so nothing changes.
  4: (document) => document,
  // Version 6: an integration's own entries changed, as its file migrations say (`FileMigration`); the document's shape did not.
  5: (document) => document,
  // Version 7: as 6 — an integration's entries changed (a Zigbee socket through its gateway); the document's shape did not.
  6: (document) => document,
  // Version 8 may say a device is paused (`paused: true`): nothing older does, so nothing changes.
  7: (document) => document,
  // Version 9 may say how long where a device has been is kept (`track: 30 days`): nothing older does, so nothing changes.
  8: (document) => document,
  // Version 10 has a family and its homes (docs/PLAN-WORLD-MODEL.md): `home:` becomes the first home.
  9: (document) => homesFromHome(document),
  // Version 11 keeps shortcuts per person: an automation's `home page:` becomes everyone's shortcut to it.
  10: (document) => shortcutsPerPerson(document),
};

/**
 * Version 11 keeps each person's own shortcuts, not one list for everyone:
 * the automations version 10 put on "the home page", in their places, are
 * every person's shortcuts. A file with no people keeps none.
 */
function shortcutsPerPerson(document: Record<string, unknown>): Record<string, unknown> {
  const automations = (document.automations && typeof document.automations === 'object' ? document.automations : {}) as Record<string, Record<string, unknown>>;
  const placed = Object.entries(automations)
    .filter(([, automation]) => typeof automation?.['home page'] === 'number')
    .sort(([, a], [, b]) => (a['home page'] as number) - (b['home page'] as number))
    .map(([key]) => key);
  const people = (document.people && typeof document.people === 'object' ? document.people : {}) as Record<string, Record<string, unknown>>;
  return {
    ...document,
    automations: Object.fromEntries(
      Object.entries(automations).map(([key, automation]) => {
        if (!automation || typeof automation !== 'object') return [key, automation];
        const { 'home page': _place, ...rest } = automation;
        return [key, rest];
      })
    ),
    ...(document.people && typeof document.people === 'object'
      ? { people: Object.fromEntries(Object.entries(people).map(([key, person]) => [key, person && typeof person === 'object' && placed.length ? { ...person, shortcuts: placed } : person])) }
      : {}),
  };
}

/**
 * Version 10 names homes: the one `home:` of version 9 — its clock, where it
 * is, its values — becomes the family's first, `home`. An automation that
 * said no clock kept the home's, and keeps it: it is its home's clock now.
 * Where the file said no clock, the first automation's is the home's, or UTC.
 * A file with no `home:` — one device, one automation — makes no home.
 */
function homesFromHome(document: Record<string, unknown>): Record<string, unknown> {
  const { home, ...rest } = document;
  // A file that says no home is about its devices or automations alone: a home it never named is not made, nor any home's clock changed by importing it.
  if (home === undefined || home === null) return rest;
  const was = (home && typeof home === 'object' ? home : {}) as { clock?: unknown; location?: unknown; policy?: unknown };
  const automations = (document.automations && typeof document.automations === 'object' ? Object.values(document.automations) : []) as { clock?: unknown }[];
  const clock = typeof was.clock === 'string' ? was.clock : (automations.find((automation) => typeof automation.clock === 'string')?.clock as string | undefined) ?? 'UTC';
  return {
    ...rest,
    homes: {
      home: {
        name: 'Home',
        type: 'house',
        ...(was.location !== undefined ? { location: was.location } : {}),
        'time zone': clock,
        ...(was.policy !== undefined ? { policy: was.policy } : {}),
      },
    },
  };
}

/** What an integration brings to a file's migration: its own steps, and what is installed for them to find their entries by. */
export type PackageMigrations = { migrations: readonly FileMigration[]; installed: FileTypes };

/**
 * Version 4 writes a setting as `setting.low`, not `$low`, and a package's
 * function by its id alone, `acme.weather.sunny(forecast)`, not
 * `call acme.weather.sunny(forecast)` — in an expression's text, outside its
 * quoted texts, which are kept as they are.
 */
function plainerExpressions(text: string): string {
  return text
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, 'setting.$1').replace(/\bcall\s+(?=[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+\s*\()/g, '')
    )
    .join('');
}

/** Every text within the automations, changed: what an expression is written in. */
function inTextsOf(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) return value.map((each) => inTextsOf(each, change));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, inTextsOf(each, change)]));
  return value;
}

/**
 * Version 3 keeps no description on an automation's roles: what a recipe
 * says for whoever fills a role stays with the recipe, and an automation's
 * role is what fills it, what it is called and what it needs.
 */
function withoutRoleDescriptions(automations: unknown): unknown {
  if (!automations || typeof automations !== 'object') return automations;
  return Object.fromEntries(
    Object.entries(automations).map(([key, automation]) => {
      if (!automation || typeof automation !== 'object' || !('uses' in automation) || !automation.uses || typeof automation.uses !== 'object') return [key, automation];
      const uses = Object.fromEntries(
        Object.entries(automation.uses).map(([role, use]) => {
          if (!use || typeof use !== 'object' || Array.isArray(use)) return [role, use];
          const { description: _description, ...kept } = use as Record<string, unknown>;
          return [role, kept];
        })
      );
      return [key, { ...automation, uses }];
    })
  );
}

/**
 * Version 2 names each standard meaning by one word: `battery.soc` is
 * `charge`, read as `station.charge`. As version 1 named them — kept here as
 * they were, whatever the meanings become.
 */
const MEANINGS_1_TO_2: readonly (readonly [string, string])[] = [
  ['power.in.ac.max', 'mainsInputLimit'],
  ['power.in.ac', 'mainsInput'],
  ['power.in.solar', 'solarInput'],
  ['power.in', 'input'],
  ['power.out', 'output'],
  ['power.draw', 'power'],
  ['battery.soc', 'charge'],
  ['battery.capacity', 'capacity'],
  ['battery.chargeLimit', 'chargeLimit'],
  ['battery.dischargeFloor', 'dischargeFloor'],
  ['energy.total', 'energy'],
  ['voltage.ac', 'voltage'],
  ['current.ac', 'current'],
  ['frequency.ac', 'frequency'],
  ['grid.present', 'mainsPresent'],
  ['switch.on', 'on'],
  ['temperature.air', 'temperature'],
  ['sky.cloudCover', 'cloudCover'],
  ['price.now', 'price'],
  ['price.rank', 'priceRank'],
];

/**
 * The automations, with each meaning renamed where they name one: a reading
 * in an expression's text, after its role (`station.battery.soc`), and a
 * setting changed by its meaning (`meaning: battery.chargeLimit`). Longer
 * names first, so `power.in.ac` is not taken for `power.in`.
 */
function renamedMeanings(value: unknown, renames: readonly (readonly [string, string])[], key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'meaning') return renames.find(([from]) => from === value)?.[1] ?? value;
    return renames.reduce((text, [from, to]) => text.replace(new RegExp(`(?<=[A-Za-z0-9_]\\.)${from.replaceAll('.', '\\.')}(?![A-Za-z0-9_]|\\.[A-Za-z_])`, 'g'), to), value);
  }
  if (Array.isArray(value)) return value.map((each) => renamedMeanings(each, renames));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, renamedMeanings(each, renames, name)]));
  return value;
}

export type Migrated = { ok: true; document: Record<string, unknown>; from: number } | { ok: false; message: string };

/** A document of any version this kraftverk can read, brought to the current one. */
export function migrate(document: Record<string, unknown>, packages: PackageMigrations = { migrations: [], installed: [] }): Migrated {
  const version = document.kraftverk;
  if (version === undefined) return { ok: false, message: `The document says which version it is: "kraftverk: ${CURRENT_VERSION}" at its top` };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, message: '"kraftverk" is the document\'s version: a whole number' };
  if (version > CURRENT_VERSION) return { ok: false, message: `It was written by a newer kraftverk (version ${version}); this one reads up to version ${CURRENT_VERSION}` };
  let migrated = document;
  for (let at = version; at < CURRENT_VERSION; at++) {
    const step = MIGRATIONS[at];
    if (!step) return { ok: false, message: `There is no way from version ${at} to ${at + 1}` };
    migrated = step(migrated);
    // Then each integration's own, from this version: its entries, as its types now are.
    for (const own of packages.migrations.filter((each) => each.from === at)) migrated = own.migrate(migrated, packages.installed);
    migrated = { ...migrated, kraftverk: at + 1 };
  }
  return { ok: true, document: migrated, from: version };
}
