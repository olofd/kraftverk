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
  /** Where it stands, or is based; null: nowhere said. */
  place: PlaceEntry | null;
  /** Who it is with, by the people's keys in the file; null: not said, and left as it is. */
  people: DevicePeopleEntry | null;
  /** Its labels, by key. */
  labels: string[];
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
  /** The recipe it was copied from; null when built from nothing. */
  madeFrom: string | null;
  /** Its labels, by key. */
  labels: string[];
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
  /** A photo of it, by its picture's id: the SHA-256 of its bytes, kept beside the file. Null: none. */
  picture: string | null;
  /** Where it is, and its geofence in metres; the radius null when the file does not say. Null: not said. */
  location: (Coordinates & { radius: number | null }) | null;
  /** IANA: what its clocks keep, and what an automation for it keeps time in unless it says its own. */
  timeZone: string;
  address: { street: string | null; postalCode: string | null; locality: string | null; region: string | null };
  country: string | null;
  /** Its values: how much is a load, the reserve. */
  policy: Record<string, number>;
  /** Its spaces by key — unique within the home — as a tree under its site: buildings, floors, rooms. */
  spaces: SpaceEntry[];
  /** Where its spaces meet, or meet the outside, by key. */
  openings: Record<string, OpeningEntry>;
};

export const SPACE_KINDS = ['building', 'floor', 'room', 'area', 'stairs', 'outdoor'] as const;
export const SPACE_PURPOSES = ['kitchen', 'living', 'dining', 'bedroom', 'children', 'guest', 'bathroom', 'toilet', 'hallway', 'office', 'laundry', 'storage', 'utility', 'garage', 'gym', 'sauna', 'other'] as const;
export const OPENING_KINDS = ['door', 'opening', 'stairs', 'window', 'gate', 'garage-door', 'elevator'] as const;

/** A space of a home, and the spaces inside it, in their order. */
export type SpaceEntry = {
  key: string;
  kind: (typeof SPACE_KINDS)[number];
  name: string;
  purpose: (typeof SPACE_PURPOSES)[number] | null;
  /** A floor's: 0 the ground floor. */
  level: number | null;
  elevation: number | null;
  height: number | null;
  /** Its own frame within its parent's: an origin in metres, a turn in degrees. Null: its parent's. */
  frame: { x: number; y: number; turn: number } | null;
  /** Its outline in its own frame: its corners, metres, in order. Null: not drawn. */
  outline: [number, number][] | null;
  /** A floor's drawing: its picture's id, the metres a pixel is, where its top-left corner falls and its turn. */
  plan: { picture: string; scale: number; x: number; y: number; turn: number } | null;
  /** Its labels, by key: on what stands in it too. */
  labels: string[];
  spaces: SpaceEntry[];
};

/**
 * A person in the family, by a key for the file: their id verbatim, and
 * their chain — who they are, as they prove it, base64url of its JSON — with
 * what this family calls them, their colour and their role, and their own
 * shortcuts on their home page: automations by key, in order. A restore
 * checks the chain again; nothing private is in it.
 */
export type PersonEntry = {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'child';
  nickname: string | null;
  color: string | null;
  chain: string;
  shortcuts: string[];
  /** What they share of where they are, and how many days their stays are kept; null: never said, the family's default. */
  sharing: { level: 'precise' | 'places' | 'home-away' | 'off'; keepDays: number } | null;
};

export const PERSON_ID = /^p-[0-9A-HJKMNP-TV-Z]{26}$/;

/** Who a device is with, by the people's keys in the file: who carries it — its position is theirs — drives it, owns it, uses it. */
export type DevicePeopleEntry = { carries: string | null; drives: string | null; owns: string[]; uses: string[] };

/** A label: any grouping the family wants, by its key. */
export type LabelEntry = { name: string; color: string | null; icon: string | null };

/** A zone: a place the family knows that is no home — school, work — always somewhere, by its key. */
export type ZoneEntry = { name: string; icon: string | null; location: Coordinates & { radius: number | null } };

/** Where two spaces meet — by their keys — or a space meets the outside (`to` null). */
export type OpeningEntry = { kind: (typeof OPENING_KINDS)[number]; from: string; to: string | null; name: string | null; shape: [number, number][] | null };

/** Where a device stands, or is based: a home by its key, a space of it (none: the home itself), perhaps an opening. */
export type PlaceEntry = {
  home: string;
  space: string | null;
  opening: string | null;
  role: 'stands' | 'based';
  /** Where in the space, metres in its frame; null: not said. */
  at: [number, number] | null;
  /** Metres above the floor. */
  height: number | null;
  /** Degrees in the space's frame: which way a radar or a camera looks. */
  facing: number | null;
};

export type ConfigDocument = {
  version: number;
  family: FamilyEntry;
  /** Its people, each by a key for the file. */
  people: Record<string, PersonEntry>;
  /** Its labels, by key. */
  labels: Record<string, LabelEntry>;
  /** Its zones, by key. */
  zones: Record<string, ZoneEntry>;
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
  for (const key of Object.keys(data)) if (!['kraftverk', 'family', 'people', 'labels', 'homes', 'zones', 'devices', 'links', 'automations', 'secrets'].includes(key)) problem(`"${key}" is not part of a configuration: it has kraftverk, family, people, labels, homes, zones, devices, links, automations and secrets`, [key]);

  /** A record of numbers, each of `fields`. */
  const numbersOf = (value: unknown, fields: readonly string[], path: Path, what: string): Record<string, number> | null => {
    if (!isRecord(value) || Object.keys(value).some((field) => !fields.includes(field)) || !fields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))) return (problem(what, path), null);
    return Object.fromEntries(fields.map((field) => [field, value[field] as number]));
  };
  /** Points in a frame, metres: at least `least`. */
  const pointsOf = (value: unknown, least: number, path: Path, what: string): [number, number][] | null => {
    const fine = Array.isArray(value) && value.length >= least && value.every((point) => Array.isArray(point) && point.length === 2 && point.every((each) => typeof each === 'number' && Number.isFinite(each)));
    return fine ? (value as [number, number][]).map(([x, y]) => [x, y]) : (problem(what, path), null);
  };
  /** A floor's drawing. */
  const planOf = (value: unknown, path: Path): SpaceEntry['plan'] => {
    const what = 'A drawing is { picture, scale, x, y, turn }: its picture\'s id, the metres a pixel is, where its top-left corner falls, and its turn';
    if (!isRecord(value) || typeof value.picture !== 'string' || !/^[0-9a-f]{64}$/.test(value.picture)) return (problem(what, path), null);
    const { picture, ...rest } = value;
    const numbers = numbersOf({ turn: 0, ...rest }, ['scale', 'x', 'y', 'turn'], path, what);
    if (numbers && !(numbers.scale! > 0)) return (problem('A drawing\'s scale is the metres a pixel is: above 0', [...path, 'scale']), null);
    return numbers ? { picture, scale: numbers.scale!, x: numbers.x!, y: numbers.y!, turn: numbers.turn! } : null;
  };
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

  // Its people, by a key for the file: each their id verbatim, and their chain.
  const people: Record<string, PersonEntry> = {};
  if (data.people !== undefined && data.people !== null) {
    if (!isRecord(data.people)) problem('"people" is a map: each person by a key', ['people']);
    else {
      const ids = new Set<string>();
      for (const [key, entry] of Object.entries(data.people)) {
        const path = ['people', key];
        if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
        if (!isRecord(entry)) {
          problem('Expected a person: their id, name, role and chain', path);
          continue;
        }
        for (const field of Object.keys(entry)) if (!['id', 'name', 'role', 'nickname', 'color', 'chain', 'shortcuts', 'sharing'].includes(field)) problem(`"${field}" is not part of a person: they have id, name, role, nickname, color, chain, shortcuts and sharing`, [...path, field]);
        const id = typeof entry.id === 'string' && PERSON_ID.test(entry.id) ? entry.id : (problem('"id" is a person’s id: p- and 26 letters and digits', [...path, 'id']), null);
        if (id && ids.has(id)) problem('Another person in this file has that id', [...path, 'id']);
        if (id) ids.add(id);
        const name = text(entry.name, [...path, 'name'], 'their name');
        const role = entry.role === undefined ? 'member' : ['admin', 'member', 'child'].includes(entry.role as string) ? (entry.role as PersonEntry['role']) : (problem('"role" is admin, member or child', [...path, 'role']), null);
        const nickname = entry.nickname === undefined || entry.nickname === null ? null : text(entry.nickname, [...path, 'nickname'], 'what the family calls them');
        const color = entry.color === undefined || entry.color === null ? null : typeof entry.color === 'string' && /^#[0-9a-f]{6}$/.test(entry.color) ? entry.color : (problem('"color" is "#rrggbb", in lowercase', [...path, 'color']), null);
        const chain = typeof entry.chain === 'string' && /^[A-Za-z0-9_-]+$/.test(entry.chain) ? entry.chain : (problem('"chain" is who they are, as they prove it: as the file was written', [...path, 'chain']), null);
        const shortcuts =
          entry.shortcuts === undefined || entry.shortcuts === null
            ? []
            : Array.isArray(entry.shortcuts)
              ? entry.shortcuts.flatMap((each, index) => (typeof each === 'string' && KEY.test(each) ? [each] : (problem('A shortcut is an automation, by its key', [...path, 'shortcuts', index]), [])))
              : (problem('"shortcuts" is a list of automation keys, in order: [good-morning, away]', [...path, 'shortcuts']), []);
        // What they share, and how long their stays are kept: "sharing: { level: places, keep: 90 days }".
        let sharing: PersonEntry['sharing'] = null;
        if (entry.sharing !== undefined && entry.sharing !== null) {
          const given = entry.sharing;
          const LEVELS = ['precise', 'places', 'home-away', 'off'];
          if (!isRecord(given) || Object.keys(given).some((field) => !['level', 'keep'].includes(field))) problem('"sharing" is what they share, and how long their stays are kept: { level: places, keep: 90 days }', [...path, 'sharing']);
          else if (!LEVELS.includes(given.level as string)) problem(`"level" is one of ${LEVELS.join(', ')}`, [...path, 'sharing', 'level']);
          else {
            const keep = given.keep === undefined || given.keep === null ? 90 : trackDays(given.keep);
            if (keep === undefined) problem('"keep" is how long their stays are kept: "90 days", from 1 day to 366', [...path, 'sharing', 'keep']);
            else sharing = { level: given.level as NonNullable<PersonEntry['sharing']>['level'], keepDays: keep };
          }
        }
        if (id && name && role && chain) people[key] = { id, name, role, nickname, color, chain, shortcuts, sharing };
      }
    }
  }

  // Its labels, by key.
  const labels: Record<string, LabelEntry> = {};
  if (data.labels !== undefined && data.labels !== null) {
    if (!isRecord(data.labels)) problem('"labels" is a map: each label by its key', ['labels']);
    else
      for (const [key, entry] of Object.entries(data.labels)) {
        const path = ['labels', key];
        if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
        if (!isRecord(entry)) {
          problem('Expected a label: its name, and perhaps a colour', path);
          continue;
        }
        for (const field of Object.keys(entry)) if (!['name', 'color', 'icon'].includes(field)) problem(`"${field}" is not part of a label: it has name, color and icon`, [...path, field]);
        const name = entry.name === undefined ? key : text(entry.name, [...path, 'name'], 'its name');
        if (name && name.length > 30) problem('A label’s name is at most 30 characters', [...path, 'name']);
        const color = entry.color === undefined || entry.color === null ? null : typeof entry.color === 'string' && /^#[0-9a-f]{6}$/.test(entry.color) ? entry.color : (problem('"color" is "#rrggbb", in lowercase', [...path, 'color']), null);
        const icon = entry.icon === undefined || entry.icon === null ? null : text(entry.icon, [...path, 'icon'], 'an icon\'s name');
        if (name) labels[key] = { name, color, icon };
      }
  }
  /** A list of labels, by key: each a key — whether the label is in the file or already here is the import's to say. */
  const labelKeys = (value: unknown, path: Path): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return (problem('"labels" is a list of label keys: [heating, upstairs]', path), []);
    return value.flatMap((each, index) => (typeof each === 'string' && KEY.test(each) ? [each] : (problem('A label is its key', [...path, index]), [])));
  };

  // The homes, in the order the file has them.
  const homes: Record<string, HomeEntry> = {};
  const homesData = data.homes ?? {};
  const fits = (value: unknown, most: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= most;
  /** Where a place is — a home, a zone — and its geofence: what sunrise and sunset are told by, and what presence is measured from. */
  const locationOf = (given: unknown, path: Path): ZoneEntry['location'] | null => {
    if (!isRecord(given) || Object.keys(given).some((field) => !['latitude', 'longitude', 'radius'].includes(field))) problem('"location" is its latitude and longitude, in degrees, and a radius in metres: { latitude: 59.3, longitude: 18.1, radius: 150 }', path);
    else if (!fits(given.latitude, 90)) problem('A latitude is a number from -90 to 90', [...path, 'latitude']);
    else if (!fits(given.longitude, 180)) problem('A longitude is a number from -180 to 180', [...path, 'longitude']);
    else if (given.radius !== undefined && !(typeof given.radius === 'number' && given.radius > 0 && given.radius <= 50_000)) problem('A radius is metres, from 1 to 50 000', [...path, 'radius']);
    else return { latitude: given.latitude as number, longitude: given.longitude as number, radius: typeof given.radius === 'number' ? given.radius : null };
    return null;
  };
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
      for (const field of Object.keys(entry)) if (!['name', 'type', 'picture', 'location', 'time zone', 'address', 'country', 'policy', 'spaces', 'openings'].includes(field)) problem(`"${field}" is not part of a home: it has name, type, picture, location, time zone, address, country, policy, spaces and openings`, [...path, field]);
      const picture = entry.picture === undefined || entry.picture === null ? null : typeof entry.picture === 'string' && /^[0-9a-f]{64}$/.test(entry.picture) ? entry.picture : (problem('"picture" is a picture\'s id: the SHA-256 of its bytes, in hex', [...path, 'picture']), null);
      const name = text(entry.name, [...path, 'name'], 'its name');
      const type = entry.type === undefined ? 'house' : HOME_TYPES.includes(entry.type as HomeTypeEntry) ? (entry.type as HomeTypeEntry) : (problem(`"type" is one of ${HOME_TYPES.join(', ')}`, [...path, 'type']), 'house');
      const timeZone = text(entry['time zone'], [...path, 'time zone'], 'its time zone: "Europe/Stockholm"');
      // Where it is: what sunrise and sunset are told by, and its geofence.
      const location = entry.location === undefined || entry.location === null ? null : locationOf(entry.location, [...path, 'location']);
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
      // Its spaces, a tree: each by a key no other space of this home has.
      const seen = new Set<string>();
      const spacesOf = (data: unknown, at: Path): SpaceEntry[] => {
        if (data === undefined || data === null) return [];
        if (!isRecord(data)) return (problem('"spaces" is a map: each space by its key', at), []);
        return Object.entries(data).flatMap(([spaceKey, space]): SpaceEntry[] => {
          const here = [...at, spaceKey];
          if (!KEY.test(spaceKey) || spaceKey === 'site') problem(`"${spaceKey}" is not a key: lowercase letters, digits and dashes — and not "site", which is the home itself`, here);
          if (seen.has(spaceKey)) problem(`"${spaceKey}" is another space's key in this home already`, here);
          seen.add(spaceKey);
          if (!isRecord(space)) return (problem('Expected a space: its kind and name', here), []);
          for (const field of Object.keys(space))
            if (!['kind', 'name', 'purpose', 'level', 'elevation', 'height', 'frame', 'outline', 'plan', 'labels', 'spaces'].includes(field))
              problem(`"${field}" is not part of a space: it has kind, name, purpose, level, elevation, height, frame, outline, plan, labels and spaces`, [...here, field]);
          const kind = SPACE_KINDS.includes(space.kind as SpaceEntry['kind']) ? (space.kind as SpaceEntry['kind']) : (problem(`"kind" is one of ${SPACE_KINDS.join(', ')}`, [...here, 'kind']), null);
          const spaceName = space.name === undefined ? spaceKey : text(space.name, [...here, 'name'], 'its name');
          const purpose = space.purpose === undefined || space.purpose === null ? null : SPACE_PURPOSES.includes(space.purpose as never) ? (space.purpose as SpaceEntry['purpose']) : (problem(`"purpose" is one of ${SPACE_PURPOSES.join(', ')}`, [...here, 'purpose']), null);
          const number = (field: string, whole: boolean): number | null =>
            space[field] === undefined || space[field] === null ? null : typeof space[field] === 'number' && Number.isFinite(space[field]) && (!whole || Number.isInteger(space[field])) ? (space[field] as number) : (problem(`"${field}" is a number`, [...here, field]), null);
          const level = number('level', true);
          const elevation = number('elevation', false);
          const height = number('height', false);
          if (kind !== 'floor' && (level !== null || elevation !== null)) problem('Only a floor has a level and an elevation', here);
          const frame = space.frame === undefined || space.frame === null ? null : numbersOf(space.frame, ['x', 'y', 'turn'], [...here, 'frame'], 'A frame is { x, y, turn }: its origin in metres, its turn in degrees');
          const outline = space.outline === undefined || space.outline === null ? null : pointsOf(space.outline, 3, [...here, 'outline'], 'An outline is its corners, at least three: [[0, 0], [4, 0], [4, 3]]');
          const plan = space.plan === undefined || space.plan === null ? null : planOf(space.plan, [...here, 'plan']);
          if (plan && kind !== 'floor') problem('Only a floor has a drawing', [...here, 'plan']);
          const inner = spacesOf(space.spaces, [...here, 'spaces']);
          const spaceLabels = labelKeys(space.labels, [...here, 'labels']);
          return kind && spaceName
            ? [{ key: spaceKey, kind, name: spaceName, purpose, level: kind === 'floor' ? (level ?? 0) : null, elevation, height, frame: frame as SpaceEntry['frame'], outline, plan: kind === 'floor' ? plan : null, labels: spaceLabels, spaces: inner }]
            : [];
        });
      };
      const spaces = spacesOf(entry.spaces, [...path, 'spaces']);
      const openings: Record<string, OpeningEntry> = {};
      if (entry.openings !== undefined && entry.openings !== null) {
        if (!isRecord(entry.openings)) problem('"openings" is a map: each opening by its key', [...path, 'openings']);
        else
          for (const [openingKey, opening] of Object.entries(entry.openings)) {
            const here = [...path, 'openings', openingKey];
            if (!KEY.test(openingKey)) problem(`"${openingKey}" is not a key: lowercase letters, digits and dashes`, here);
            if (!isRecord(opening)) {
              problem('Expected an opening: its kind, from, and to', here);
              continue;
            }
            for (const field of Object.keys(opening)) if (!['kind', 'from', 'to', 'name', 'shape'].includes(field)) problem(`"${field}" is not part of an opening: it has kind, from, to, name and shape`, [...here, field]);
            const kind = OPENING_KINDS.includes(opening.kind as OpeningEntry['kind']) ? (opening.kind as OpeningEntry['kind']) : (problem(`"kind" is one of ${OPENING_KINDS.join(', ')}`, [...here, 'kind']), null);
            const from = typeof opening.from === 'string' && seen.has(opening.from) ? opening.from : (problem('"from" is the key of a space of this home', [...here, 'from']), null);
            const to = opening.to === undefined || opening.to === null || opening.to === 'outside' ? null : typeof opening.to === 'string' && seen.has(opening.to) ? opening.to : (problem('"to" is the key of a space of this home, or "outside"', [...here, 'to']), undefined);
            const openingName = opening.name === undefined || opening.name === null ? null : text(opening.name, [...here, 'name'], 'its name');
            const shape = opening.shape === undefined || opening.shape === null ? null : pointsOf(opening.shape, 2, [...here, 'shape'], 'A shape is where in the wall it is, a line of points: [[4, 1], [4, 1.9]]');
            if (kind && from && to !== undefined) openings[openingKey] = { kind, from, to, name: openingName, shape };
          }
      }
      if (name && timeZone) homes[key] = { name, type, picture, location, timeZone, address, country, policy, spaces, openings };
    }

  // The zones, by key: each somewhere.
  const zones: Record<string, ZoneEntry> = {};
  if (data.zones !== undefined && data.zones !== null) {
    if (!isRecord(data.zones)) problem('"zones" is a map: each zone by its key', ['zones']);
    else
      for (const [key, entry] of Object.entries(data.zones)) {
        const path = ['zones', key];
        if (!KEY.test(key)) problem(`"${key}" is not a key: lowercase letters, digits and dashes`, path);
        if (!isRecord(entry)) {
          problem('Expected a zone: its name and where it is', path);
          continue;
        }
        for (const field of Object.keys(entry)) if (!['name', 'icon', 'location'].includes(field)) problem(`"${field}" is not part of a zone: it has name, icon and location`, [...path, field]);
        const name = text(entry.name, [...path, 'name'], 'its name');
        const icon = entry.icon === undefined || entry.icon === null ? null : text(entry.icon, [...path, 'icon'], 'its icon');
        const location = entry.location === undefined || entry.location === null ? (problem('A zone is somewhere: "location: { latitude: 59.3, longitude: 18.1, radius: 200 }"', [...path, 'location']), null) : locationOf(entry.location, [...path, 'location']);
        if (name && location) zones[key] = { name, icon, location };
      }
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
      for (const field of Object.keys(entry)) if (!['type', 'name', 'identity', 'picture', 'paused', 'track', 'place', 'based', 'people', 'labels', 'settings', 'connect'].includes(field)) problem(`"${field}" is not part of a device: it has type, name, identity, picture, paused, track, place, based, people, labels, settings and connect`, [...path, field]);
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
      // Where it stands — or, for one that moves, where it is based: a home, a space of it, perhaps an opening.
      if (entry.place !== undefined && entry.based !== undefined) problem('A device stands somewhere, or is based somewhere: one of "place" and "based"', path);
      const placeData = entry.place ?? entry.based;
      const role = entry.based !== undefined ? 'based' : 'stands';
      let place: PlaceEntry | null = null;
      if (placeData !== undefined && placeData !== null) {
        const at = [...path, entry.based !== undefined ? 'based' : 'place'];
        if (!isRecord(placeData)) problem('Expected where it is: { home: home, space: kitchen }', at);
        else {
          for (const field of Object.keys(placeData)) if (!['home', 'space', 'opening', 'at', 'height', 'facing'].includes(field)) problem(`"${field}" is not part of where it is: it has home, space, opening, at, height and facing`, [...at, field]);
          const homeKey = typeof placeData.home === 'string' && KEY.test(placeData.home) ? placeData.home : (problem('"home" is the key of a home', [...at, 'home']), null);
          const spaceKey = placeData.space === undefined || placeData.space === null ? null : typeof placeData.space === 'string' && KEY.test(placeData.space) ? placeData.space : (problem('"space" is the key of a space of that home', [...at, 'space']), null);
          const openingKey = placeData.opening === undefined || placeData.opening === null ? null : typeof placeData.opening === 'string' && KEY.test(placeData.opening) ? placeData.opening : (problem('"opening" is the key of an opening of that home', [...at, 'opening']), null);
          const point = placeData.at === undefined || placeData.at === null ? null : (pointsOf([placeData.at], 1, [...at, 'at'], '"at" is where in the space, metres in its frame: [1.5, 2]')?.[0] ?? null);
          const metres = (field: 'height' | 'facing', what: string): number | null =>
            placeData[field] === undefined || placeData[field] === null ? null : typeof placeData[field] === 'number' && Number.isFinite(placeData[field]) ? (placeData[field] as number) : (problem(what, [...at, field]), null);
          const height = metres('height', '"height" is metres above the floor');
          const facing = metres('facing', '"facing" is degrees in the space\'s frame');
          if ((height !== null || facing !== null) && !point) problem('A height or a facing is of a point: say "at" too', at);
          if (homeKey) place = { home: homeKey, space: spaceKey, opening: openingKey, role, at: point, height, facing };
        }
      }
      // Who it is with: each by a person's key in this file.
      let with_: DevicePeopleEntry | null = null;
      if (entry.people !== undefined && entry.people !== null) {
        const given = entry.people;
        if (!isRecord(given)) problem('"people" is who it is with: { carries: anna, drives: anna, owns: [anna], uses: [sam] }', [...path, 'people']);
        else {
          for (const field of Object.keys(given)) if (!['carries', 'drives', 'owns', 'uses'].includes(field)) problem(`"${field}" is not who a device is with: carries, drives, owns or uses`, [...path, 'people', field]);
          const someone = (value: unknown, at: Path): string | null => {
            if (typeof value !== 'string' || !KEY.test(value)) return (problem('A person, by their key in this file', at), null);
            if (!(value in people)) return (problem(`There is no person "${value}" in this file`, at), null);
            return value;
          };
          const one = (role: 'carries' | 'drives') => (given[role] === undefined || given[role] === null ? null : someone(given[role], [...path, 'people', role]));
          const many = (role: 'owns' | 'uses') => {
            const value = given[role];
            if (value === undefined || value === null) return [];
            const list = Array.isArray(value) ? value : [value];
            return list.flatMap((each, index) => someone(each, [...path, 'people', role, index]) ?? []);
          };
          with_ = { carries: one('carries'), drives: one('drives'), owns: many('owns'), uses: many('uses') };
        }
      }
      if (type && name) devices[key] = { type, name, identity: optional('identity'), picture: optional('picture'), paused: entry.paused === true, track: track ?? null, place, people: with_, labels: labelKeys(entry.labels, [...path, 'labels']), settings: scalars(entry.settings, [...path, 'settings']), connect };
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
      const own = ['name', 'mode', 'home', 'clock', 'recheck', 'made from', 'labels'];
      const rules = ['uses', 'settings', 'memory', 'inputs', 'result', 'when', 'while running', 'only if', 'do', 'if a step fails'];
      for (const field of Object.keys(entry)) if (![...own, ...rules].includes(field)) problem(`"${field}" is not part of an automation: it has ${[...own, ...rules].join(', ')}`, [...path, field]);
      const name = text(entry.name, [...path, 'name'], 'its name');
      const mode = entry.mode === undefined ? 'watch' : AUTOMATION_MODES.includes(entry.mode as AutomationMode) ? (entry.mode as AutomationMode) : (problem('"mode" is off, watch or act', [...path, 'mode']), 'watch');
      // The home it is for, and a clock of its own — or its home's.
      const home = entry.home === undefined || entry.home === null ? null : typeof entry.home === 'string' && KEY.test(entry.home) ? entry.home : (problem('"home" is the key of the home it is for', [...path, 'home']), null);
      const clock = entry.clock === undefined || entry.clock === null ? null : text(entry.clock, [...path, 'clock'], 'its clock: the time zone its times are in ("clock: Europe/Stockholm")');
      const recheck = entry.recheck === undefined || entry.recheck === null ? null : durationSeconds(entry.recheck);
      if (entry.recheck !== undefined && entry.recheck !== null && (recheck === null || recheck % 60 !== 0)) problem('"recheck" is how often it looks again, in whole minutes ("15 min")', [...path, 'recheck']);
      const madeFrom = typeof entry['made from'] === 'string' ? entry['made from'] : null;
      const read = ruleFromConfig(entry, path);
      issues.push(...read.issues);
      if (name && read.rule) automations[key] = { name, mode, home, clock, recheckMinutes: recheck === null ? null : recheck / 60, madeFrom, labels: labelKeys(entry.labels, [...path, 'labels']), uses: read.uses, rule: read.rule };
    }

  // A shortcut is to an automation in the file.
  for (const [key, person] of Object.entries(people))
    person.shortcuts.forEach((shortcut, index) => {
      if (isRecord(automationsData) && !(shortcut in automationsData)) problem(`There is no automation "${shortcut}" in this file`, ['people', key, 'shortcuts', index]);
    });

  // Secrets by name.
  const secrets: Record<string, string> = {};
  if (data.secrets !== undefined) {
    if (!isRecord(data.secrets)) problem('"secrets" is a map: each secret by its name', ['secrets']);
    else for (const [name, value] of Object.entries(data.secrets)) typeof value === 'string' ? (secrets[name] = value) : problem('A secret is text: sealed, or the value itself', ['secrets', name]);
  }

  // Partial: what could be read, beside every problem — whose entries the reader leaves out (`readConfig`).
  if (issues.length && !options.partial) return { document: null, issues };
  return { document: { version: CURRENT_VERSION, family, people, labels, homes, zones, devices, links, automations, secrets }, issues };
}


/** Days from "30 days" or "1 day", 1 to 366; undefined for anything else. */
function trackDays(data: unknown): number | undefined {
  const match = typeof data === 'string' ? /^(\d+)\s*days?$/.exec(data.trim()) : null;
  const days = match ? Number(match[1]) : NaN;
  return days >= 1 && days <= 366 ? days : undefined;
}

/** A home's spaces as data: each by its key, what it is, and the spaces inside it. */
function spacesData(spaces: readonly SpaceEntry[]): Record<string, unknown> {
  return Object.fromEntries(
    spaces.map((space) => [
      space.key,
      {
        kind: space.kind,
        ...(space.name !== space.key ? { name: space.name } : {}),
        ...(space.purpose !== null ? { purpose: space.purpose } : {}),
        ...(space.level !== null ? { level: space.level } : {}),
        ...(space.elevation !== null ? { elevation: space.elevation } : {}),
        ...(space.height !== null ? { height: space.height } : {}),
        ...(space.frame !== null ? { frame: space.frame } : {}),
        ...(space.outline !== null ? { outline: space.outline } : {}),
        ...(space.plan !== null ? { plan: space.plan } : {}),
        ...(space.labels.length ? { labels: space.labels } : {}),
        ...(space.spaces.length ? { spaces: spacesData(space.spaces) } : {}),
      },
    ])
  );
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
        ...(device.place !== null
          ? {
              [device.place.role === 'based' ? 'based' : 'place']: {
                home: device.place.home,
                ...(device.place.space !== null ? { space: device.place.space } : {}),
                ...(device.place.opening !== null ? { opening: device.place.opening } : {}),
                ...(device.place.at !== null ? { at: device.place.at } : {}),
                ...(device.place.height !== null ? { height: device.place.height } : {}),
                ...(device.place.facing !== null ? { facing: device.place.facing } : {}),
              },
            }
          : {}),
        ...(device.people && (device.people.carries || device.people.drives || device.people.owns.length || device.people.uses.length)
          ? {
              people: {
                ...(device.people.carries ? { carries: device.people.carries } : {}),
                ...(device.people.drives ? { drives: device.people.drives } : {}),
                ...(device.people.owns.length ? { owns: device.people.owns } : {}),
                ...(device.people.uses.length ? { uses: device.people.uses } : {}),
              },
            }
          : {}),
        ...(device.labels.length ? { labels: device.labels } : {}),
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
        ...(automation.madeFrom !== null ? { 'made from': automation.madeFrom } : {}),
        ...(automation.labels.length ? { labels: automation.labels } : {}),
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
    ...(Object.keys(document.people).length
      ? {
          people: Object.fromEntries(
            Object.entries(document.people).map(([key, person]) => [
              key,
              { id: person.id, name: person.name, role: person.role, ...(person.nickname !== null ? { nickname: person.nickname } : {}), ...(person.color !== null ? { color: person.color } : {}), chain: person.chain, ...(person.shortcuts.length ? { shortcuts: person.shortcuts } : {}), ...(person.sharing ? { sharing: { level: person.sharing.level, keep: person.sharing.keepDays === 1 ? '1 day' : `${person.sharing.keepDays} days` } } : {}) },
            ])
          ),
        }
      : {}),
    ...(Object.keys(document.labels).length
      ? { labels: Object.fromEntries(Object.entries(document.labels).map(([key, label]) => [key, { name: label.name, ...(label.color !== null ? { color: label.color } : {}), ...(label.icon !== null ? { icon: label.icon } : {}) }])) }
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
                  ...(home.picture !== null ? { picture: home.picture } : {}),
                  ...(home.location ? { location: { latitude: home.location.latitude, longitude: home.location.longitude, ...(home.location.radius !== null ? { radius: home.location.radius } : {}) } } : {}),
                  'time zone': home.timeZone,
                  ...(address.length ? { address: Object.fromEntries(address) } : {}),
                  ...(home.country !== null ? { country: home.country } : {}),
                  ...(Object.keys(home.policy).length ? { policy: home.policy } : {}),
                  ...(home.spaces.length ? { spaces: spacesData(home.spaces) } : {}),
                  ...(Object.keys(home.openings).length
                    ? {
                        openings: Object.fromEntries(
                          Object.entries(home.openings).map(([key, opening]) => [key, { kind: opening.kind, from: opening.from, to: opening.to ?? 'outside', ...(opening.name !== null ? { name: opening.name } : {}), ...(opening.shape !== null ? { shape: opening.shape } : {}) }])
                        ),
                      }
                    : {}),
                },
              ];
            })
          ),
        }
      : {}),
    ...(Object.keys(document.zones).length
      ? {
          zones: Object.fromEntries(
            Object.entries(document.zones).map(([key, zone]) => [
              key,
              {
                name: zone.name,
                ...(zone.icon !== null ? { icon: zone.icon } : {}),
                location: { latitude: zone.location.latitude, longitude: zone.location.longitude, ...(zone.location.radius !== null ? { radius: zone.location.radius } : {}) },
              },
            ])
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
export const emptyDocument = (): ConfigDocument => ({ version: CURRENT_VERSION, family: { name: null, kind: null, locale: null }, people: {}, labels: {}, homes: {}, zones: {}, devices: {}, links: [], automations: {}, secrets: {} });
