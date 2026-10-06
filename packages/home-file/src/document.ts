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
 * plain text (`exportable: true`, written only when so).
 */
export type ConnectEntry = { via: string; address: string | null; settings: Record<string, Scalar>; secrets: Record<string, SecretValue>; exportable: boolean };

export type DeviceEntry = {
  type: string;
  name: string;
  /** Who the hardware says it is, as it said when added; null when it has not said. */
  identity: string | null;
  /** Which of its pictures it shows ("type:2"); null for its type's first. */
  picture: string | null;
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
  /** Its clock: the time zone its times of day are in. */
  clock: string;
  /** How often it looks again to keep things so; null for never. */
  recheckMinutes: number | null;
  /** Its place among the home page's shortcuts; null when it is not there. */
  homePlace: number | null;
  /** The recipe it was copied from; null when built from nothing. */
  madeFrom: string | null;
  uses: Record<string, Use>;
  rule: Rule;
};

export type ConfigDocument = {
  version: number;
  /** The home's values, and its clock: the time zone an automation that says none of its own keeps time in. */
  home: { policy: Record<string, number>; clock: string | null; location: Coordinates | null };
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
  if (!isRecord(data)) return { document: null, issues: [{ message: 'A configuration is a map: kraftverk, home, devices, links, automations', path: [] }] };
  for (const key of Object.keys(data)) if (!['kraftverk', 'home', 'devices', 'links', 'automations', 'secrets'].includes(key)) problem(`"${key}" is not part of a configuration: it has kraftverk, home, devices, links, automations and secrets`, [key]);

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

  // The home.
  const policy: Record<string, number> = {};
  let homeClock: string | null = null;
  let location: Coordinates | null = null;
  if (data.home !== undefined) {
    if (!isRecord(data.home)) problem('"home" is a map', ['home']);
    else {
      for (const field of Object.keys(data.home)) if (!['policy', 'clock', 'location'].includes(field)) problem(`"${field}" is not part of the home: it has policy, clock and location`, ['home', field]);
      if (data.home.clock !== undefined) homeClock = text(data.home.clock, ['home', 'clock'], 'its clock: the time zone its automations keep time in ("clock: Europe/Stockholm")');
      // Where it is: what sunrise and sunset are told by.
      if (data.home.location !== undefined) {
        const given = data.home.location;
        const fits = (value: unknown, most: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= most;
        if (!isRecord(given) || Object.keys(given).some((key) => key !== 'latitude' && key !== 'longitude')) problem('"location" is its latitude and longitude, in degrees: { latitude: 59.3, longitude: 18.1 }', ['home', 'location']);
        else if (!fits(given.latitude, 90)) problem('A latitude is a number from -90 to 90', ['home', 'location', 'latitude']);
        else if (!fits(given.longitude, 180)) problem('A longitude is a number from -180 to 180', ['home', 'location', 'longitude']);
        else location = { latitude: given.latitude as number, longitude: given.longitude as number };
      }
      if (data.home.policy !== undefined) {
        if (!isRecord(data.home.policy)) problem('"policy" is a map of the home\'s values', ['home', 'policy']);
        else for (const [name, value] of Object.entries(data.home.policy)) typeof value === 'number' ? (policy[name] = value) : problem('A policy value is a number', ['home', 'policy', name]);
      }
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
      for (const field of Object.keys(entry)) if (!['type', 'name', 'identity', 'picture', 'settings', 'connect'].includes(field)) problem(`"${field}" is not part of a device: it has type, name, identity, picture, settings and connect`, [...path, field]);
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
        for (const field of Object.keys(way)) if (!['via', 'address', 'settings', 'secrets', 'exportable'].includes(field)) problem(`"${field}" is not part of a way to reach it: via, address, settings, secrets and exportable`, [...at, field]);
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
        if (via) connect.push({ via, address: typeof way.address === 'string' ? way.address : null, settings: scalars(way.settings, [...at, 'settings']), secrets, exportable: way.exportable === true });
      }
      const optional = (field: 'identity' | 'picture') => (entry[field] === undefined || entry[field] === null ? null : typeof entry[field] === 'string' ? entry[field] : (problem(`"${field}" is text`, [...path, field]), null));
      if (type && name) devices[key] = { type, name, identity: optional('identity'), picture: optional('picture'), settings: scalars(entry.settings, [...path, 'settings']), connect };
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
      const own = ['name', 'mode', 'clock', 'recheck', 'home page', 'made from'];
      const rules = ['uses', 'settings', 'memory', 'when', 'while running', 'only if', 'do', 'if a step fails'];
      for (const field of Object.keys(entry)) if (![...own, ...rules].includes(field)) problem(`"${field}" is not part of an automation: it has ${[...own, ...rules].join(', ')}`, [...path, field]);
      const name = text(entry.name, [...path, 'name'], 'its name');
      const mode = entry.mode === undefined ? 'watch' : AUTOMATION_MODES.includes(entry.mode as AutomationMode) ? (entry.mode as AutomationMode) : (problem('"mode" is off, watch or act', [...path, 'mode']), 'watch');
      // Its own clock, or the home's.
      const clock = entry.clock === undefined && homeClock ? homeClock : text(entry.clock, [...path, 'clock'], 'its clock: the time zone its times are in ("clock: Europe/Stockholm"), or the home\'s ("home: { clock: … }")');
      const recheck = entry.recheck === undefined || entry.recheck === null ? null : durationSeconds(entry.recheck);
      if (entry.recheck !== undefined && entry.recheck !== null && (recheck === null || recheck % 60 !== 0)) problem('"recheck" is how often it looks again, in whole minutes ("15 min")', [...path, 'recheck']);
      const homePlace = entry['home page'] === undefined || entry['home page'] === null ? null : Number.isInteger(entry['home page']) ? (entry['home page'] as number) : (problem('"home page" is its place among the shortcuts: 0, 1, 2 …', [...path, 'home page']), null);
      const madeFrom = typeof entry['made from'] === 'string' ? entry['made from'] : null;
      const read = ruleFromConfig(entry, path);
      issues.push(...read.issues);
      if (name && clock && read.rule) automations[key] = { name, mode, clock, recheckMinutes: recheck === null ? null : recheck / 60, homePlace, madeFrom, uses: read.uses, rule: read.rule };
    }

  // Secrets by name.
  const secrets: Record<string, string> = {};
  if (data.secrets !== undefined) {
    if (!isRecord(data.secrets)) problem('"secrets" is a map: each secret by its name', ['secrets']);
    else for (const [name, value] of Object.entries(data.secrets)) typeof value === 'string' ? (secrets[name] = value) : problem('A secret is text: sealed, or the value itself', ['secrets', name]);
  }

  // Partial: what could be read, beside every problem — whose entries the reader leaves out (`readConfig`).
  if (issues.length && !options.partial) return { document: null, issues };
  return { document: { version: CURRENT_VERSION, home: { policy, clock: homeClock, location }, devices, links, automations, secrets }, issues };
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
        ...(Object.keys(device.settings).length ? { settings: device.settings } : {}),
        ...(device.connect.length
          ? {
              connect: device.connect.map((way) => ({
                via: way.via,
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
        clock: automation.clock,
        ...(automation.recheckMinutes !== null ? { recheck: durationText(automation.recheckMinutes * 60) } : {}),
        ...(automation.homePlace !== null ? { 'home page': automation.homePlace } : {}),
        ...(automation.madeFrom !== null ? { 'made from': automation.madeFrom } : {}),
        ...ruleToConfig(automation.rule, automation.uses),
      },
    ])
  );
  return {
    kraftverk: document.version,
    ...(Object.keys(document.home.policy).length || document.home.clock !== null || document.home.location !== null
      ? {
          home: {
            ...(document.home.clock !== null ? { clock: document.home.clock } : {}),
            ...(document.home.location !== null ? { location: { latitude: document.home.location.latitude, longitude: document.home.location.longitude } } : {}),
            ...(Object.keys(document.home.policy).length ? { policy: document.home.policy } : {}),
          },
        }
      : {}),
    ...(Object.keys(document.devices).length ? { devices } : {}),
    ...(document.links.length ? { links: document.links.map((link) => ({ [link.kind]: { from: useText(link.from), to: useText(link.to) } })) } : {}),
    ...(Object.keys(document.automations).length ? { automations } : {}),
    ...(Object.keys(document.secrets).length ? { secrets: document.secrets } : {}),
  };
}

/** An empty document of this version. */
export const emptyDocument = (): ConfigDocument => ({ version: CURRENT_VERSION, home: { policy: {}, clock: null, location: null }, devices: {}, links: [], automations: {}, secrets: {} });
