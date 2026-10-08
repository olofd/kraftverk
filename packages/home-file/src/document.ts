import { KEY } from '@kraftverk/device-sdk';
import { AUTOMATION_MODES, type AutomationMode, type Coordinates, type Rule } from '@kraftverk/automation';

import { CURRENT_VERSION } from './migrate.ts';
import { durationSeconds, durationText, ruleFromConfig, ruleToConfig, useOf, useText, type Issue, type Use } from '@kraftverk/automation';

/*
  A kraftverk configuration as data (docs/CONFIG.md): the home's settings, its
  devices and how each is reached, the links between them, and its
  automations — each by a key of its own, the name a file and an import know
  it by. What the file says, checked for its shape here; whether a type, a
  method or a setting exists is the server's to check, against what is
  installed.
*/

export type Scalar = string | number | boolean;

/**
 * A secret, as a file holds it:
 * - `secret` — a name, written `!secret name`: its value is under that name
 *   in the document's `secrets`, or in a secrets file kept beside it;
 * - `sealed` — sealed with a passphrase ("sealed:v1:…"), in an export that
 *   carries its secrets;
 * - `plain` — the value itself, for a connection whose secrets may leave in
 *   plain text.
 */
export type SecretValue = { secret: string } | { sealed: string } | { plain: string };

/** A passphrase shorter than this is refused: an export travels, and is guessed at offline. */
export const PASSPHRASE_MIN = 12;

/** Whether a secret in a file is sealed with a passphrase (`sealed:v1:…`), whichever version. */
export const isSealed = (value: string): boolean => /^sealed:v\d+:/.test(value);

/** Whether a file's text holds any secret sealed with a passphrase: what opening it will ask for. */
export const holdsSealed = (text: string): boolean => /sealed:v\d+:/.test(text);

/**
 * One way a device is reached: a method of its type, the address there, its
 * settings, its secrets — and whether its owner lets those secrets leave in
 * plain text (`exportable: true`, written only when so). A way through a
 * bridge names the bridge by its key (`through: family-account`), and its
 * address is its key there (docs/PLAN-INTEGRATIONS.md §4.3).
 */
export type ConnectEntry = { via: string; through: string | null; address: string | null; settings: Record<string, Scalar>; secrets: Record<string, SecretValue>; exportable: boolean };

export type DeviceEntry = {
  type: string;
  name: string;
  /** Who the hardware says it is, as it said when added; null when it has not said. */
  identity: string | null;
  /** Which of its pictures it shows ("type:2"); null for its type's first. */
  picture: string | null;
  /** Paused by its owner: kept, and not reached, until resumed. Written only when it is. */
  paused: boolean;
  /**
   * How many days where it has been is kept ("track: 30 days"), 1 to 366;
   * null when none of it is. What was kept is never in the file: only that
   * it is kept, and for how long.
   */
  track: number | null;
  /** Its type's settings. */
  settings: Record<string, Scalar>;
  /** The ways it is reached, preferred first. */
  connect: ConnectEntry[];
};

/** A fact about the house: this part of one device does this to that part of another. */
export type LinkEntry = { kind: string; from: { device: string; part: string }; to: { device: string; part: string } };


export type AutomationEntry = {
  name: string;
  mode: AutomationMode;
  /** The home it is for, by its key: its clock and its "home". Null: the family's. */
  home: string | null;
  /** A clock of its own: the time zone its times of day are in. Null: its home's. */
  clock: string | null;
  /** How often it looks again to keep things so; null for never. */
  recheckMinutes: number | null;
  /** Its place among the home page's shortcuts; null when it is not there. */
  homePlace: number | null;
  /** The recipe it was copied from; null when built from nothing. */
  madeFrom: string | null;
  uses: Record<string, Use>;
  rule: Rule;
};

/** What a family's kind is: only the words on screen. */
export const FAMILY_KINDS = ['family', 'household', 'friends', 'other'] as const;
export type FamilyKindEntry = (typeof FAMILY_KINDS)[number];

/** What the file says of the family itself; null for what it does not say, which an import leaves as it is. */
export type FamilyEntry = { name: string | null; kind: FamilyKindEntry | null; locale: string | null };

export const HOME_TYPES = ['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other'] as const;
export type HomeTypeEntry = (typeof HOME_TYPES)[number];

/** A home (docs/PLAN-WORLD-MODEL.md §8.4): where it is, its clock, and its values. */
export type HomeEntry = {
  name: string;
  type: HomeTypeEntry;
  /** Where it is, and its geofence in metres; the radius null when the file does not say. Null: not said. */
  location: (Coordinates & { radius: number | null }) | null;
  /** IANA: what its clocks keep, and what an automation for it keeps time in unless it says its own. */
  timeZone: string;
  address: { street: string | null; postalCode: string | null; locality: string | null; region: string | null };
  country: string | null;
  /** Its values: how much is a load, the reserve. */
  policy: Record<string, number>;
};

export type ConfigDocument = {
  version: number;
  family: FamilyEntry;
  /** Its homes, by key, in their order. */
  homes: Record<string, HomeEntry>;
  devices: Record<string, DeviceEntry>;
  links: LinkEntry[];
  automations: Record<string, AutomationEntry>;
  /** Secrets by name, for `!secret name`: sealed in an export, or plain where they may be. */
  secrets: Record<string, string>;
};

/** A secret's name, written `!secret name`, as the YAML reads it. */
export class SecretRef {
  constructor(readonly name: string) {}
}


type Path = readonly (string | number)[];
const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data) && !(data instanceof SecretRef);

/**
 * A document from its data, every problem with its path — the shape checked,
 * each rule read. Null with problems when any part cannot be read; the
 * document's version is the migration's to have brought to this one.
 */
export function documentFromData(data: unknown, options: { partial?: boolean } = {}): { document: ConfigDocument | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const problem = (message: string, path: Path) => void issues.push({ message, path });
  if (!isRecord(data)) return { document: null, issues: [{ message: 'A configuration is a map: kraftverk, family, homes, devices, links, automations', path: [] }] };
  for (const key of Object.keys(data)) if (!['kraftverk', 'family', 'homes', 'devices', 'links', 'automations', 'secrets'].includes(key)) problem(`"${key}" is not part of a configuration: it has kraftverk, family, homes, devices, links, automations and secrets`, [key]);

  const text = (value: unknown, path: Path, what: string): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    problem(`Expected ${what}`, path);
    return null;
  };
  const scalars = (value: unknown, path: Path): Record<string, Scalar> => {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) return (problem('Expected a map of settings', path), {});
    const out: Record<string, Scalar> = {};
    for (const [name, each] of Object.entries(value)) {
      if (typeof each === 'string' || typeof each === 'number' || typeof each === 'boolean') out[name] = each;
      else problem('A setting is text, a number, or true or false', [...path, name]);
    }
    return out;
  };

  // The family itself: what the file says of it.
  const family: FamilyEntry = { name: null, kind: null, locale: null };
  if (data.family !== undefined) {
    if (!isRecord(data.family)) problem('"family" is a map: its name, kind and locale', ['family']);
    else {
      for (const field of Object.keys(data.family)) if (!['name', 'kind', 'locale'].includes(field)) problem(`"${field}" is not part of the family: it has name, kind and locale`, ['family', field]);
      if (data.family.name !== undefined) family.name = text(data.family.name, ['family', 'name'], 'its name');
      if (data.family.kind !== undefined) family.kind = FAMILY_KINDS.includes(data.family.kind as FamilyKindEntry) ? (data.family.kind as FamilyKindEntry) : (problem(`"kind" is one of ${FAMILY_KINDS.join(', ')}`, ['family', 'kind']), null);
      if (data.family.locale !== undefined) family.locale = text(data.family.locale, ['family', 'locale'], 'its language: "en-GB", "sv-SE"');
    }
  }

  // The homes, in the order the file has them.
  const homes: Record<string, HomeEntry> = {};
  const homesData = data.homes ?? {};
  const fits = (value: unknown, most: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= most;
  const optionalText = (value: unknown, path: Path, what: string): string | null => (value === undefined || value === null ? null : text(value, path, what));
  if (!isRecord(homesData)) problem('"homes" is a map: each home by its key', ['homes']);
  else
    for (const [key, entry] of Object.entries(homesData)) {
      const path = ['homes', key];
      if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
      if (!isRecord(entry)) {
        problem('Expected a home: its name, type, where it is and its time zone', path);
        continue;
      }
      for (const field of Object.keys(entry)) if (!['name', 'type', 'location', 'time zone', 'address', 'country', 'policy'].includes(field)) problem(`"${field}" is not part of a home: it has name, type, location, time zone, address, country and policy`, [...path, field]);
      const name = text(entry.name, [...path, 'name'], 'its name');
      const type = entry.type === undefined ? 'house' : HOME_TYPES.includes(entry.type as HomeTypeEntry) ? (entry.type as HomeTypeEntry) : (problem(`"type" is one of ${HOME_TYPES.join(', ')}`, [...path, 'type']), 'house');
      const timeZone = text(entry['time zone'], [...path, 'time zone'], 'its time zone: "Europe/Stockholm"');
      // Where it is: what sunrise and sunset are told by, and its geofence.
      let location: HomeEntry['location'] = null;
      if (entry.location !== undefined && entry.location !== null) {
        const given = entry.location;
        if (!isRecord(given) || Object.keys(given).some((field) => !['latitude', 'longitude', 'radius'].includes(field))) problem('"location" is its latitude and longitude, in degrees, and a radius in metres: { latitude: 59.3, longitude: 18.1, radius: 150 }', [...path, 'location']);
        else if (!fits(given.latitude, 90)) problem('A latitude is a number from -90 to 90', [...path, 'location', 'latitude']);
        else if (!fits(given.longitude, 180)) problem('A longitude is a number from -180 to 180', [...path, 'location', 'longitude']);
        else if (given.radius !== undefined && !(typeof given.radius === 'number' && given.radius > 0 && given.radius <= 50_000)) problem('A radius is metres, from 1 to 50 000', [...path, 'location', 'radius']);
        else location = { latitude: given.latitude as number, longitude: given.longitude as number, radius: typeof given.radius === 'number' ? given.radius : null };
      }
      const address: HomeEntry['address'] = { street: null, postalCode: null, locality: null, region: null };
      if (entry.address !== undefined && entry.address !== null) {
        if (!isRecord(entry.address)) problem('"address" is a map: street, postal code, locality, region', [...path, 'address']);
        else {
          for (const field of Object.keys(entry.address)) if (!['street', 'postal code', 'locality', 'region'].includes(field)) problem(`"${field}" is not part of an address: it has street, postal code, locality and region`, [...path, 'address', field]);
          address.street = optionalText(entry.address.street, [...path, 'address', 'street'], 'a street');
          address.postalCode = optionalText(entry.address['postal code'], [...path, 'address', 'postal code'], 'a postal code');
          address.locality = optionalText(entry.address.locality, [...path, 'address', 'locality'], 'a town');
          address.region = optionalText(entry.address.region, [...path, 'address', 'region'], 'a region');
        }
      }
      const country = entry.country === undefined || entry.country === null ? null : typeof entry.country === 'string' && /^[A-Z]{2}$/.test(entry.country) ? entry.country : (problem('"country" is its two letters: SE, GB', [...path, 'country']), null);
      const policy: Record<string, number> = {};
      if (entry.policy !== undefined) {
        if (!isRecord(entry.policy)) problem('"policy" is a map of the home\'s values', [...path, 'policy']);
        else for (const [value, each] of Object.entries(entry.policy)) typeof each === 'number' ? (policy[value] = each) : problem('A policy value is a number', [...path, 'policy', value]);
      }
      if (name && timeZone) homes[key] = { name, type, location, timeZone, address, country, policy };
    }

  // The devices.
  const devices: Record<string, DeviceEntry> = {};
  const devicesData = data.devices ?? {};
  if (!isRecord(devicesData)) problem('"devices" is a map: each device by its key', ['devices']);
  else
    for (const [key, entry] of Object.entries(devicesData)) {
      const path = ['devices', key];
      if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
      if (!isRecord(entry)) {
        problem('Expected a device: its type, name and how it is reached', path);
        continue;
      }
      for (const field of Object.keys(entry)) if (!['type', 'name', 'identity', 'picture', 'paused', 'track', 'settings', 'connect'].includes(field)) problem(`"${field}" is not part of a device: it has type, name, identity, picture, paused, track, settings and connect`, [...path, field]);
      const type = text(entry.type, [...path, 'type'], 'its type ("type: acme.plug")');
      const name = text(entry.name, [...path, 'name'], 'its name');
      const connect: ConnectEntry[] = [];
      if (entry.connect !== undefined && !Array.isArray(entry.connect)) problem('"connect" is a list: the ways it is reached, preferred first', [...path, 'connect']);
      for (const [index, way] of (Array.isArray(entry.connect) ? entry.connect : []).entries()) {
        const at = [...path, 'connect', index];
        if (!isRecord(way)) {
          problem('Expected a way to reach it: via, address, settings, secrets', at);
          continue;
        }
        for (const field of Object.keys(way)) if (!['via', 'through', 'address', 'settings', 'secrets', 'exportable'].includes(field)) problem(`"${field}" is not part of a way to reach it: via, through, address, settings, secrets and exportable`, [...at, field]);
        if (way.exportable !== undefined && typeof way.exportable !== 'boolean') problem('"exportable" is true or false: whether its secrets may leave in plain text', [...at, 'exportable']);
        const via = text(way.via, [...at, 'via'], 'how it is reached ("via: lan")');
        const secrets: Record<string, SecretValue> = {};
        if (way.secrets !== undefined && way.secrets !== null) {
          if (!isRecord(way.secrets)) problem('"secrets" is a map: each secret by its field', [...at, 'secrets']);
          else
            for (const [field, value] of Object.entries(way.secrets)) {
              if (value instanceof SecretRef) secrets[field] = { secret: value.name };
              else if (typeof value === 'string' && value.startsWith('sealed:')) secrets[field] = { sealed: value };
              else if (typeof value === 'string') secrets[field] = { plain: value };
              else problem('A secret is "!secret name", a sealed value, or the text itself', [...at, 'secrets', field]);
            }
        }
        if (way.address !== undefined && way.address !== null && typeof way.address !== 'string') problem('An address is text', [...at, 'address']);
        if (way.through !== undefined && way.through !== null && typeof way.through !== 'string') problem('"through" is the key of the device it is reached through', [...at, 'through']);
        const through = typeof way.through === 'string' && way.through.trim() ? way.through.trim() : null;
        if (via) connect.push({ via, through, address: typeof way.address === 'string' ? way.address : null, settings: scalars(way.settings, [...at, 'settings']), secrets, exportable: way.exportable === true });
      }
      const optional = (field: 'identity' | 'picture') => (entry[field] === undefined || entry[field] === null ? null : typeof entry[field] === 'string' ? entry[field] : (problem(`"${field}" is text`, [...path, field]), null));
      if (entry.paused !== undefined && typeof entry.paused !== 'boolean') problem('"paused" is true or false', [...path, 'paused']);
      const track = entry.track === undefined || entry.track === null ? null : trackDays(entry.track);
      if (track === undefined) problem('"track" is how long where it has been is kept: "30 days", from 1 day to 366', [...path, 'track']);
      if (type && name) devices[key] = { type, name, identity: optional('identity'), picture: optional('picture'), paused: entry.paused === true, track: track ?? null, settings: scalars(entry.settings, [...path, 'settings']), connect };
    }

  // The links.
  const links: LinkEntry[] = [];
  if (data.links !== undefined && !Array.isArray(data.links)) problem('"links" is a list', ['links']);
  for (const [index, link] of (Array.isArray(data.links) ? data.links : []).entries()) {
    const path = ['links', index];
    if (!isRecord(link) || Object.keys(link).length !== 1) {
      problem('A link is its kind and its two parts: "- feeds: { from: plug, to: station.input.ac }"', path);
      continue;
    }
    const [kind, ends] = Object.entries(link)[0]!;
    if (!isRecord(ends)) {
      problem('Expected its two parts: from, to', [...path, kind]);
      continue;
    }
    const from = typeof ends.from === 'string' ? useOf(ends.from) : null;
    const to = typeof ends.to === 'string' ? useOf(ends.to) : null;
    if (!from) problem('Expected the part it is from: "device-key" or "device-key.part"', [...path, kind, 'from']);
    if (!to) problem('Expected the part it is to: "device-key" or "device-key.part"', [...path, kind, 'to']);
    if (from && to) links.push({ kind, from, to });
  }

  // The automations.
  const automations: Record<string, AutomationEntry> = {};
  const automationsData = data.automations ?? {};
  if (!isRecord(automationsData)) problem('"automations" is a map: each automation by its key', ['automations']);
  else
    for (const [key, entry] of Object.entries(automationsData)) {
      const path = ['automations', key];
      if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
      if (!isRecord(entry)) {
        problem('Expected an automation: its name, what it uses and what it does', path);
        continue;
      }
      const own = ['name', 'mode', 'home', 'clock', 'recheck', 'home page', 'made from'];
      const rules = ['uses', 'settings', 'memory', 'inputs', 'result', 'when', 'while running', 'only if', 'do', 'if a step fails'];
      for (const field of Object.keys(entry)) if (![...own, ...rules].includes(field)) problem(`"${field}" is not part of an automation: it has ${[...own, ...rules].join(', ')}`, [...path, field]);
      const name = text(entry.name, [...path, 'name'], 'its name');
      const mode = entry.mode === undefined ? 'watch' : AUTOMATION_MODES.includes(entry.mode as AutomationMode) ? (entry.mode as AutomationMode) : (problem('"mode" is off, watch or act', [...path, 'mode']), 'watch');
      // The home it is for, and a clock of its own — or its home's.
      const home = entry.home === undefined || entry.home === null ? null : typeof entry.home === 'string' && KEY.test(entry.home) ? entry.home : (problem('"home" is the key of the home it is for', [...path, 'home']), null);
      const clock = entry.clock === undefined || entry.clock === null ? null : text(entry.clock, [...path, 'clock'], 'its clock: the time zone its times are in ("clock: Europe/Stockholm")');
      const recheck = entry.recheck === undefined || entry.recheck === null ? null : durationSeconds(entry.recheck);
      if (entry.recheck !== undefined && entry.recheck !== null && (recheck === null || recheck % 60 !== 0)) problem('"recheck" is how often it looks again, in whole minutes ("15 min")', [...path, 'recheck']);
      const homePlace = entry['home page'] === undefined || entry['home page'] === null ? null : Number.isInteger(entry['home page']) ? (entry['home page'] as number) : (problem('"home page" is its place among the shortcuts: 0, 1, 2 …', [...path, 'home page']), null);
      const madeFrom = typeof entry['made from'] === 'string' ? entry['made from'] : null;
      const read = ruleFromConfig(entry, path);
      issues.push(...read.issues);
      if (name && read.rule) automations[key] = { name, mode, home, clock, recheckMinutes: recheck === null ? null : recheck / 60, homePlace, madeFrom, uses: read.uses, rule: read.rule };
    }

  // Secrets by name.
  const secrets: Record<string, string> = {};
  if (data.secrets !== undefined) {
    if (!isRecord(data.secrets)) problem('"secrets" is a map: each secret by its name', ['secrets']);
    else for (const [name, value] of Object.entries(data.secrets)) typeof value === 'string' ? (secrets[name] = value) : problem('A secret is text: sealed, or the value itself', ['secrets', name]);
  }

  // Partial: what could be read, beside every problem — whose entries the reader leaves out (`readConfig`).
  if (issues.length && !options.partial) return { document: null, issues };
  return { document: { version: CURRENT_VERSION, family, homes, devices, links, automations, secrets }, issues };
}


/** Days from "30 days" or "1 day", 1 to 366; undefined for anything else. */
function trackDays(data: unknown): number | undefined {
  const match = typeof data === 'string' ? /^(\d+)\s*days?$/.exec(data.trim()) : null;
  const days = match ? Number(match[1]) : NaN;
  return days >= 1 && days <= 366 ? days : undefined;
}

/** A document as data, in the order a person reads it: what a YAML file is written from. */
export function documentToData(document: ConfigDocument): Record<string, unknown> {
  const devices = Object.fromEntries(
    Object.entries(document.devices).map(([key, device]) => [
      key,
      {
        type: device.type,
        name: device.name,
        ...(device.identity !== null ? { identity: device.identity } : {}),
        ...(device.picture !== null ? { picture: device.picture } : {}),
        ...(device.paused ? { paused: true } : {}),
        ...(device.track !== null ? { track: device.track === 1 ? '1 day' : `${device.track} days` } : {}),
        ...(Object.keys(device.settings).length ? { settings: device.settings } : {}),
        ...(device.connect.length
          ? {
              connect: device.connect.map((way) => ({
                via: way.via,
                ...(way.through !== null ? { through: way.through } : {}),
                ...(way.address !== null ? { address: way.address } : {}),
                ...(Object.keys(way.settings).length ? { settings: way.settings } : {}),
                ...(Object.keys(way.secrets).length
                  ? { secrets: Object.fromEntries(Object.entries(way.secrets).map(([field, value]) => [field, 'secret' in value ? new SecretRef(value.secret) : 'sealed' in value ? value.sealed : value.plain])) }
                  : {}),
                ...(way.exportable ? { exportable: true } : {}),
              })),
            }
          : {}),
      },
    ])
  );
  const automations = Object.fromEntries(
    Object.entries(document.automations).map(([key, automation]) => [
      key,
      {
        name: automation.name,
        mode: automation.mode,
        ...(automation.home !== null ? { home: automation.home } : {}),
        ...(automation.clock !== null ? { clock: automation.clock } : {}),
        ...(automation.recheckMinutes !== null ? { recheck: durationText(automation.recheckMinutes * 60) } : {}),
        ...(automation.homePlace !== null ? { 'home page': automation.homePlace } : {}),
        ...(automation.madeFrom !== null ? { 'made from': automation.madeFrom } : {}),
        ...ruleToConfig(automation.rule, automation.uses),
      },
    ])
  );
  return {
    kraftverk: document.version,
    ...(document.family.name !== null || document.family.kind !== null || document.family.locale !== null
      ? {
          family: {
            ...(document.family.name !== null ? { name: document.family.name } : {}),
            ...(document.family.kind !== null ? { kind: document.family.kind } : {}),
            ...(document.family.locale !== null ? { locale: document.family.locale } : {}),
          },
        }
      : {}),
    ...(Object.keys(document.homes).length
      ? {
          homes: Object.fromEntries(
            Object.entries(document.homes).map(([key, home]) => {
              const address = Object.entries({ street: home.address.street, 'postal code': home.address.postalCode, locality: home.address.locality, region: home.address.region }).filter(([, value]) => value !== null);
              return [
                key,
                {
                  name: home.name,
                  type: home.type,
                  ...(home.location ? { location: { latitude: home.location.latitude, longitude: home.location.longitude, ...(home.location.radius !== null ? { radius: home.location.radius } : {}) } } : {}),
                  'time zone': home.timeZone,
                  ...(address.length ? { address: Object.fromEntries(address) } : {}),
                  ...(home.country !== null ? { country: home.country } : {}),
                  ...(Object.keys(home.policy).length ? { policy: home.policy } : {}),
                },
              ];
            })
          ),
        }
      : {}),
    ...(Object.keys(document.devices).length ? { devices } : {}),
    ...(document.links.length ? { links: document.links.map((link) => ({ [link.kind]: { from: useText(link.from), to: useText(link.to) } })) } : {}),
    ...(Object.keys(document.automations).length ? { automations } : {}),
    ...(Object.keys(document.secrets).length ? { secrets: document.secrets } : {}),
  };
}

/** An empty document of this version. */
export const emptyDocument = (): ConfigDocument => ({ version: CURRENT_VERSION, family: { name: null, kind: null, locale: null }, homes: {}, devices: {}, links: [], automations: {}, secrets: {} });
