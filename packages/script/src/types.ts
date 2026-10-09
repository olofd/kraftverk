import { capabilitySpec, isCapability, type ScalarValueType, type ValueType } from '@kraftverk/device-sdk';

/*
  The types a script is written against (docs/PLAN-SCRIPTS.md §11.1): the
  SDK's own declarations — what the guest SDK (guest/sdk.ts) gives, said
  for TypeScript — and the home's, generated from what it has: each device
  by its key, its readings by key with their types, and, on each part, its
  capabilities' commands with their arguments. One `kraftverk.d.ts`, which
  the editor's language service checks a script against. The hub never
  checks types: what crosses is checked when it runs.
*/

/** A home, as its scripts' types are made from it: its devices, each by its key. */
export type ScriptHome = {
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
  /** A field a script declares its shape with: the language's own, typed by what it holds. */
  export type Field<T> = { readonly __holds?: T };
  type Of<F> = F extends Field<infer T> ? T : never;
  type Values<S> = { -readonly [K in keyof S]: Of<S[K]> };
  type Said = { title?: string; description?: string };
  type Numbered = Said & { min?: number; max?: number; step?: number; default?: number };

  /** The fields a shape is declared in. */
  export const t: {
    /** A number, in a unit when it has one: W, %, °C. */
    number(options?: Numbered & { unit?: string; integer?: boolean }): Field<number>;
    /** A length of time, in seconds, as the language keeps every duration. */
    duration(options?: Numbered): Field<number>;
    /** A whole number from nothing up. */
    count(options?: Numbered): Field<number>;
    flag(options?: Said & { default?: boolean }): Field<boolean>;
    text(options?: Said & { default?: string }): Field<string>;
    choice<const T extends string>(options: readonly (T | { value: T; label: string })[], more?: Said & { default?: T }): Field<T>;
    /** An instant: a date and a time, as ISO text. */
    instant(options?: Said): Field<string>;
  };

  /** One of a script's steps: given its inputs, it may read the home, act and wait, and answers. */
  export type Step = { readonly kind: 'step' };
  /** One of a script's functions: pure, its arguments in order, its answer at once. */
  export type Fn = { readonly kind: 'fn' };

  /** A step: what it takes, answers and remembers — and what it does, given them. */
  export function step<const I extends Record<string, Field<unknown>> = {}, const M extends Record<string, Field<unknown>> = {}, const A extends Field<unknown> | undefined = undefined>(
    spec: { inputs?: I; answer?: A; memory?: M },
    run: (inputs: Values<I>, context: { memory: Values<M> }) => Promise<A extends Field<infer T> ? T | null : void> | (A extends Field<infer T> ? T | null : void)
  ): Step;

  /** A function: pure, its arguments in order, its answer at once. */
  export function fn<const Args extends readonly Field<unknown>[], const R extends Field<unknown>>(
    spec: { args?: Args; returns: R },
    run: (...args: { [K in keyof Args]: Of<Args[K]> }) => Of<R> | null
  ): Fn;

  /** A line in the run's log, beneath the step. */
  export function log(...parts: unknown[]): void;
  /** A pause, on the home's clock: at most until the step must end; stopped with its run. */
  export function sleep(seconds: number): Promise<void>;
  /** The family told something, as this automation tells it: everyone, or the people named by id. */
  export function notify(title: string, options?: { text?: string; to?: readonly string[] }): Promise<{ told: string[] }>;
  /** A home put in a mode — its own, unless one is named by id — as this automation puts it. */
  export function setMode(mode: string, homeId?: string): Promise<unknown>;

  /** A refusal from the home: its kind — refused, forbidden, not-found — its words, each problem. */
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

  /** The home as objects: its devices, by key — read again each time they are asked for. */
  export const home: { readonly devices: Devices };
`;

/**
 * The types a script is checked against, for one home: the SDK, and the
 * home's devices — `home.devices['garage-plug'].switch.set({ on: false })`
 * completes, and a key it does not have is an error as it is typed.
 */
export function typesOf(home: ScriptHome): string {
  const devices = home.devices.map((device) => {
    const readings = device.readings.map((reading) => `${doc(reading.label)} ${JSON.stringify(reading.key)}: ${typeOf(reading.value)};`).join(' ');
    const parts = device.parts.map((part) => {
      const capabilities = part.capabilities.flatMap((name) => (capabilityInterface(name) ? [`${JSON.stringify(name)}: ${interfaceOf(name)};`] : []));
      return `${JSON.stringify(part.id)}: { ${capabilities.join(' ')} };`;
    });
    const partsType = `{ ${parts.join(' ')} }`;
    // Its main part's capabilities, on the device itself: `plug.switch.set(...)`.
    const main = device.parts.find((part) => part.id === 'main') ?? device.parts[0];
    const own = main ? `${partsType}[${JSON.stringify(main.id)}]` : '{}';
    return `${doc(`${device.name}: ${device.type}`)} readonly ${JSON.stringify(device.key)}: Device<{ ${readings} }, ${partsType}> & ${own};`;
  });
  // Every capability any device has, declared once.
  const used = [...new Set(home.devices.flatMap((device) => device.parts.flatMap((part) => part.capabilities)))].sort();
  const interfaces = used.flatMap((name) => capabilityInterface(name) ?? []);
  return [
    '// The types of kraftverk scripts, for this home: generated, never edited.',
    "declare module 'kraftverk' {",
    SDK,
    ...interfaces,
    '  /** The home\'s devices, by key. */',
    `  export interface Devices { ${devices.join(' ')} }`,
    '}',
    "declare module 'kraftverk/api' {",
    '  /** The home\'s API, as the app has it: each namespace, each of its calls. */',
    '  const api: { readonly [namespace: string]: { readonly [call: string]: (...args: any[]) => Promise<any> } } & { readonly [call: string]: any };',
    '  export = api;',
    '}',
    '',
  ].join('\n');
}
