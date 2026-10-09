import { capabilitySpec, isCapability, UNIT_LIST, unitSpec, valueTypeOf, type ConfigField, type ScalarValueType, type ValueType } from '@kraftverk/device-sdk';

import { scriptNames } from './names.ts';
import { UNIT_TYPES } from './signature.ts';

/*
  The types a script is written against (docs/PLAN-SCRIPTS.md §11.1): the
  SDK's own declarations — what the guest SDK (guest/sdk.ts) gives, said
  for TypeScript, and the types a step's and a function's signature are
  written in (signature.ts) — and the family's, generated from what it has:
  each person, home, room and device by the name a script writes it with
  (names.ts), a device's readings by key with their types, and, on each
  part, its capabilities' commands with their arguments. One
  `kraftverk.d.ts`, which the editor's language service checks a script
  against. The hub never checks types: what crosses is checked when it runs.
*/

/** A family, as its scripts' types are made from it: its people, its homes with their rooms and variables, its modes, and its devices. */
export type ScriptHome = {
  people: readonly { name: string }[];
  homes: readonly { key: string; name: string; rooms: readonly { key: string; name: string }[]; variables: readonly { key: string; kind: string; field: ConfigField }[] }[];
  modes: readonly { key: string; axis: string; name: string }[];
  devices: readonly {
    key: string;
    name: string;
    type: string;
    parts: readonly { id: string; label: string; capabilities: readonly string[] }[];
    readings: readonly { key: string; label: string; value: ValueType }[];
  }[];
};

/** A value's type, as TypeScript says it. */
function typeOf(value: ValueType | ScalarValueType): string {
  switch (value.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
    case 'timestamp':
      return 'string';
    case 'enum':
      return value.options.length ? value.options.map((option) => JSON.stringify(option.value)).join(' | ') : 'string';
    case 'list':
      return `Array<${typeOf(value.of)}>`;
    case 'object':
      return `{ ${Object.entries(value.fields)
        .map(([name, field]) => `${JSON.stringify(name)}: ${typeOf(field)} | null`)
        .join('; ')} }`;
  }
}

/** A comment for TypeScript to show on hover: one line, nothing that ends it. */
const doc = (text: string): string => `/** ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */`;

/** A capability's interface's name: one declaration each, so its commands keep their words on hover. */
const interfaceOf = (name: string): string => `Capability_${name.replace(/[^A-Za-z0-9]/g, '_')}`;

/** A capability as an interface: its commands, each a call with its arguments and its words. Null when it has none. */
function capabilityInterface(name: string): string | null {
  if (!isCapability(name)) return null;
  const spec = capabilitySpec(name);
  const commands = Object.entries(spec.commands).map(([command, declared]) => {
    const args = Object.entries(declared.args);
    const given = args.length ? `args: { ${args.map(([arg, type]) => `${JSON.stringify(arg)}: ${typeOf(type)}`).join('; ')} }` : 'args?: Record<string, never>';
    return `    ${doc(declared.description)}\n    ${JSON.stringify(command)}(${given}): Promise<CommandResult>;`;
  });
  return commands.length ? `  ${doc(spec.label)}\n  export interface ${interfaceOf(name)} {\n${commands.join('\n')}\n  }` : null;
}

/** The SDK, as TypeScript reads it: what `import ... from 'kraftverk'` gives. */
const SDK = `
  /** A unit kraftverk knows. */
  export type Unit = ${UNIT_LIST.map((unit) => JSON.stringify(unit)).join(' | ')};
  /** A number in a unit: Quantity<'W'>, Quantity<'°C'>. Tag it \`@min 0\`, \`@max 100\`, \`@integer\`. */
  export type Quantity<U extends Unit> = number;
  /** A length of time, in seconds, as the language keeps every duration. Tag it \`@min 1 min\`, \`@default 5 min\`. */
  export type Duration = number;
  /** An instant: a date and a time, as ISO text. */
  export type Instant = string;
  /** What a step remembers between runs: one parameter of its own, \`memory: Kept<{ times: number }>\`. Each starts as nothing, none, the first choice — or its \`@default\`. */
  export type Kept<T extends object> = T;
${Object.entries(UNIT_TYPES).map(([name, unit]) => `  /** A number in ${unitSpec(unit).label} (${unit}). */\n  export type ${name} = Quantity<${JSON.stringify(unit)}>;`).join('\n')}

  /** A line in the run's log, beneath the step. */
  export function log(...parts: unknown[]): void;
  /** A pause, on the home's clock: at most until the step must end; stopped with its run. */
  export function sleep(seconds: number): Promise<void>;
  /** The family told something, as this run tells it: everyone, or the people named by id. */
  export function notify(title: string, options?: { text?: string; to?: readonly string[] }): Promise<{ told: string[] }>;
  /** A home put in a mode — this script's home, unless one is named by id — as this run puts it. */
  export function setMode(mode: Mode, homeId?: string): Promise<unknown>;

  /** A refusal from the home: its kind — refused, failed, forbidden, not-found, conflict, invalid — its words, each problem. */
  export class KraftverkError extends Error {
    readonly kind: string;
    readonly problems: readonly string[];
  }

  /** What came of a command, through the gateway: refused or failed is thrown, as a KraftverkError. */
  export type CommandResult = { outcome: 'verified' | 'unverified'; detail?: string };

  /** A device, as a script sees it: what it is, what it reports now, and by capability what it can be told. */
  export type Device<Readings, Parts> = {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly type: string;
    readonly parts: readonly (keyof Parts & string)[];
    /** What it reports now, by key; null when it has not said. */
    reading<K extends keyof Readings & string>(key: K): Readings[K] | null;
    /** Everything it reports now, by key. */
    readings(): Partial<Readings>;
    /** One of its parts, by id: its capabilities, each with its commands. */
    part<P extends keyof Parts & string>(id: P): Parts[P];
  };
  /** What a device that switches can do besides: turned on and off, through the gateway. */
  export type Switches = {
    /** Turn it on. */
    turnOn(): Promise<CommandResult>;
    /** Turn it off. */
    turnOff(): Promise<CommandResult>;
  };

  /** A room — any space of a home but its ground — as a script sees it. */
  export interface Room {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    /** Whether anyone is in it now, by what stands there: null when it cannot be told. */
    readonly occupied: boolean | null;
  }

  /** A home, as a script sees it: its rooms, who is there, its modes and variables now — and set. */
  export interface Home<Rooms = Record<string, Room>, Vars = Record<string, unknown>, Counters extends string = string> {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    /** Its rooms, by name. */
    readonly rooms: Rooms;
    /** Whether anyone of the family is home: null when it cannot be told. */
    readonly occupied: boolean | null;
    /** Its mode on the presence axis now; null when none is set. */
    readonly presence: PresenceMode | null;
    /** Its mode on the day axis now; null when none is set. */
    readonly day: DayMode | null;
    /** Who of the family is home now, by name, as far as each shares. */
    readonly people: readonly string[];
    /** It put in a mode, as this run puts it. */
    setMode(mode: Mode): Promise<unknown>;
    /** Its variables now, by key: \`home.vars.guests\` — as set, or what each starts as. */
    readonly vars: Readonly<Vars>;
    /** One of its variables set, as this run sets it: to a value of its kind, in its range. */
    setVariable<K extends keyof Vars & string>(key: K, value: NonNullable<Vars[K]>): Promise<unknown>;
    /** One of its counters counted, as this run counts it: by one, or by so many — below nought counts down. */
    count(key: Counters, by?: number): Promise<unknown>;
    /** One of its counters back to what it starts as. */
    resetCounter(key: Counters): Promise<unknown>;
  }

  /** A person of the family, as a script sees them: where they are, as far as they share. */
  export interface Person {
    readonly id: string;
    readonly name: string;
    /** Whether they are at this script's home now: null when they share too little to tell. */
    readonly isHome: boolean | null;
    /** Whether they are at a home, or in a room of one: null when they share too little to tell. */
    isAt(place: Home<unknown> | Room): boolean | null;
    /** Them told something, as this run tells them. */
    tell(title: string, text?: string): Promise<{ told: string[] }>;
  }

  /** The family, by name: \`family.maria\`. */
  export const family: Family;
  /** The family's homes, by name: \`homes.cabin\`. */
  export const homes: Homes;
  /** This script's home: its automation's, or the family's first. */
  export const home: Homes[keyof Homes];
  /** The devices, by name: \`devices.garagePlug.turnOn()\`. */
  export const devices: Devices;
`;

/**
 * The types a script is checked against, for one family: the SDK, and the
 * family's people, homes, rooms, modes and devices, each by its name —
 * `devices.garagePlug.turnOn()` and `family.maria.isHome` complete, and a
 * name it does not have is an error as it is typed.
 */
export function typesOf(home: ScriptHome): string {
  const deviceNames = scriptNames(home.devices.map((device) => device.key));
  const devices = home.devices.map((device, at) => {
    const readings = device.readings.map((reading) => `${doc(reading.label)} ${JSON.stringify(reading.key)}: ${typeOf(reading.value)};`).join(' ');
    const parts = device.parts.map((part) => {
      const capabilities = part.capabilities.flatMap((name) => (capabilityInterface(name) ? [`${JSON.stringify(name)}: ${interfaceOf(name)};`] : []));
      return `${JSON.stringify(part.id)}: { ${capabilities.join(' ')} };`;
    });
    const partsType = `{ ${parts.join(' ')} }`;
    // Its main part's capabilities, on the device itself: `plug.switch.set(...)`.
    const main = device.parts.find((part) => part.id === 'main') ?? device.parts[0];
    const own = main ? `${partsType}[${JSON.stringify(main.id)}]` : '{}';
    const switches = main?.capabilities.includes('switch') ? ' & Switches' : '';
    return `${doc(`${device.name}: ${device.type}`)} readonly ${deviceNames[at]}: Device<{ ${readings} }, ${partsType}> & ${own}${switches};`;
  });
  const personNames = scriptNames(home.people.map((person) => person.name));
  const people = home.people.map((person, at) => `${doc(person.name)} readonly ${personNames[at]}: Person;`);
  const homeNames = scriptNames(home.homes.map((each) => each.key));
  const homes = home.homes.map((each, at) => {
    const roomNames = scriptNames(each.rooms.map((room) => room.key));
    const rooms = `{ ${each.rooms.map((room, index) => `${doc(room.name)} readonly ${roomNames[index]}: Room;`).join(' ')} }`;
    // Each variable by its key, of its field's type: a time of day not set yet is nothing.
    const vars = `{ ${each.variables.map((variable) => `${doc(variable.field.title)} readonly ${variable.key}: ${typeOf(valueTypeOf(variable.field))}${variable.kind === 'time' ? ' | null' : ''};`).join(' ')} }`;
    const counters = each.variables.filter((variable) => variable.kind === 'counter').map((variable) => JSON.stringify(variable.key)).join(' | ') || 'never';
    return `${doc(each.name)} readonly ${homeNames[at]}: Home<${rooms}, ${vars}, ${counters}>;`;
  });
  const modesOn = (axis: string): string => home.modes.filter((mode) => mode.axis === axis).map((mode) => JSON.stringify(mode.key)).join(' | ') || 'never';
  // Every capability any device has, declared once.
  const used = [...new Set(home.devices.flatMap((device) => device.parts.flatMap((part) => part.capabilities)))].sort();
  const interfaces = used.flatMap((name) => capabilityInterface(name) ?? []);
  return [
    '// The types of kraftverk scripts, for this home: generated, never edited.',
    "declare module 'kraftverk' {",
    SDK,
    ...interfaces,
    '  /** The devices, by name. */',
    `  export interface Devices { ${devices.join(' ')} }`,
    '  /** The family, by name. */',
    `  export interface Family { ${people.join(' ')} }`,
    '  /** The family\'s homes, by name. */',
    `  export interface Homes { ${homes.join(' ')} }`,
    `  export type PresenceMode = ${modesOn('presence')};`,
    `  export type DayMode = ${modesOn('day')};`,
    `  export type Mode = PresenceMode | DayMode;`,
    '}',
    "declare module 'kraftverk/api' {",
    '  /** The home\'s API, as the app has it: each namespace, each of its calls. */',
    '  const api: { readonly [namespace: string]: { readonly [call: string]: (...args: any[]) => Promise<any> } } & { readonly [call: string]: any };',
    '  export = api;',
    '}',
    '',
  ].join('\n');
}
