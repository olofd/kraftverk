/*
  The guest SDK: what runs inside a sandbox before a script, and what a
  script imports as `kraftverk` (docs/PLAN-SCRIPTS.md §6). Bundled into one
  string of JavaScript (`../generated/guest.ts`, by
  scripts/gen-script-guest.ts) and evaluated first in every sandbox.

  It imports nothing at run time: inside there is only the language itself
  and what the host lends as globals. Types are its own to say, and erased.

  What it holds: `log`; the family's world as objects, each by the name a
  script writes it with (../names.ts) — `family.maria`, `home` and
  `homes.cabin` with their rooms and modes, `devices.garagePlug`, each
  read and told by its capabilities; the whole API (`kraftverk/api`, as the app
  has it); `sleep`, `notify` and `setMode`; the `require` a compiled script
  is given; and the entries the host calls — `__describe`, `__fn`, `__step`.
  A script declares itself by its exported functions' types, read from what
  is written (../signature.ts): nothing here is a builder of them.

  What the host lends, only while a step runs (none to a function, none to
  its top level): `__read` (answered at once, from the home as it is),
  `__call` and `__wait` (answered later: one more slice each).
*/

import { scriptNames } from '../names.ts';

/** The host's functions, when it lends them: answered at once, or later. */
declare const __log: ((text: string) => string) | undefined;
declare const __read: ((query: string) => string) | undefined;
declare const __call: ((call: string) => Promise<string>) | undefined;
declare const __wait: ((ms: string) => Promise<string>) | undefined;

/** A line in the run's log, or the trace of the expression a function is called from. */
const log = (...parts: unknown[]): void => {
  const text = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
  if (typeof __log === 'function') __log(text);
};

/** A refusal from the home, as a script catches it: its kind — "forbidden", "refused", "not-found" — its words, and each problem. */
class KraftverkError extends Error {
  readonly kind: string;
  readonly problems: readonly string[];
  constructor(kind: string, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = 'KraftverkError';
    this.kind = kind;
    this.problems = problems;
  }
}

/** What only a running step may do: refused at the top level and in a function. */
const host = <T>(fn: T | undefined, what: string): T => {
  if (typeof fn !== 'function') throw new KraftverkError('forbidden', `Only a step may ${what}: at the top level and in a function it is not reached`);
  return fn;
};

/** One call of the home's API, by its path: its answer, or the refusal it was, thrown. */
const call = async (path: readonly string[], args: readonly unknown[]): Promise<unknown> => {
  let answer: string;
  try {
    answer = await host(typeof __call === 'undefined' ? undefined : __call, 'reach the home')(JSON.stringify({ path, args }));
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    let refusal: { kind?: string; message?: string; problems?: string[] } = {};
    try {
      refusal = JSON.parse(said) as typeof refusal;
    } catch {
      refusal = { message: said };
    }
    throw new KraftverkError(refusal.kind ?? 'failed', refusal.message ?? said, refusal.problems ?? []);
  }
  return JSON.parse(answer);
};

/** The home's API, as the app has it: each name one more step of a path, a call of it the call (`kraftverk/api`). */
const apiAt = (path: readonly string[]): unknown =>
  new Proxy(function api() {}, {
    get: (_, key) => (typeof key === 'string' && key !== 'then' ? apiAt([...path, key]) : undefined),
    apply: (_, __, args: unknown[]) => call(path, args),
  });
const API = apiAt([]);

/** What the home says of itself, now: answered at once, between a step's waits. */
const read = (query: unknown): unknown => JSON.parse(host(typeof __read === 'undefined' ? undefined : __read, 'read the home')(JSON.stringify(query)));

type PartInfo = { id: string; label: string; capabilities: string[] };
type DeviceInfo = { id: string; key: string; name: string; type: string; parts: PartInfo[] };
type CommandResult = { outcome: string; detail?: string };

/** A command through the gateway, as this automation: what came of it — refused or failed, thrown. */
const command = async (device: DeviceInfo, part: string, capability: string, name: string, args: Record<string, unknown>): Promise<CommandResult> => {
  const result = (await call(['devices', 'command'], [device.id, part, capability, name, { args, reason: 'A script' }])) as CommandResult;
  if (result.outcome === 'refused' || result.outcome === 'failed') throw new KraftverkError(result.outcome, result.detail ?? `${device.name} did not ${name}`);
  return result;
};

/** A capability of one part, as a script tells it: each of its commands a call — `lamp.switch.set({ on: false })`. */
const capabilityOf = (device: DeviceInfo, part: string, capability: string) =>
  new Proxy({} as Record<string, (args?: Record<string, unknown>) => Promise<CommandResult>>, {
    get: (_, name) => (typeof name === 'string' && name !== 'then' ? (args: Record<string, unknown> = {}) => command(device, part, capability, name, args) : undefined),
  });

/**
 * A device, as a script sees it: its key, name and parts; what it reports
 * now (`reading('power')`, by its key — `outlet.ac.power` for a part's);
 * by capability, what it can be told — on its main part, or `part(id)`;
 * and, when its main part switches, `turnOn()` and `turnOff()`.
 */
const deviceOf = (info: DeviceInfo) => {
  const partOf = (id: string) => {
    const part = info.parts.find((each) => each.id === id);
    if (!part) throw new KraftverkError('not-found', `${info.name} has no part "${id}"`);
    return Object.fromEntries(part.capabilities.map((capability) => [capability, capabilityOf(info, id, capability)]));
  };
  const main = info.parts.find((each) => each.id === 'main') ?? info.parts[0];
  return new Proxy(
    {
      id: info.id,
      key: info.key,
      name: info.name,
      type: info.type,
      parts: info.parts.map((each) => each.id),
      reading: (key: string): unknown => read({ reading: [info.id, key] }),
      readings: (): Record<string, unknown> => read({ readings: info.id }) as Record<string, unknown>,
      part: partOf,
      turnOn: () => command(info, main?.id ?? 'main', 'switch', 'set', { on: true }),
      turnOff: () => command(info, main?.id ?? 'main', 'switch', 'set', { on: false }),
    },
    {
      get: (target, name, receiver) => {
        if (typeof name !== 'string' || name in target) return Reflect.get(target, name, receiver);
        return main?.capabilities.includes(name) ? capabilityOf(info, main.id, name) : undefined;
      },
    }
  );
};

/**
 * Things by the names a script writes them with, each read again as it is
 * asked for: `list` gives them as they are now, `nameOf` what each is
 * called by, `make` the object a script is given.
 */
const named = <Info, Made>(what: string, list: () => readonly Info[], nameOf: (info: Info) => string, make: (info: Info) => Made): Record<string, Made> => {
  const now = (): Map<string, Info> => {
    const infos = list();
    const names = scriptNames(infos.map(nameOf));
    return new Map(infos.map((info, at) => [names[at]!, info]));
  };
  return new Proxy({} as Record<string, Made>, {
    get: (_, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      const info = now().get(name);
      if (info === undefined) throw new KraftverkError('not-found', `There is no ${what} "${name}"`);
      return make(info);
    },
    has: (_, name) => typeof name === 'string' && now().has(name),
    ownKeys: () => [...now().keys()],
    getOwnPropertyDescriptor: (_, name) => (typeof name === 'string' && now().has(name) ? { enumerable: true, configurable: true } : undefined),
  });
};

/** The devices, by key: `devices.garagePlug`. */
const devices = named('device', () => read({ devices: true }) as DeviceInfo[], (info) => info.key, deviceOf);

type PlaceInfo = { id: string; key: string; name: string };
type HomeInfo = PlaceInfo & { rooms: PlaceInfo[] };
type PersonInfo = { id: string; name: string };

/** Who of the family is at a place, as far as each shares: yes, no, or null when they share too little to tell. */
const isAt = (person: string, kind: string, place: string): boolean | null => {
  const at = read({ at: [kind, place] }) as { at: string[]; unknown: string[] } | null;
  if (!at) return null;
  return at.at.includes(person) ? true : at.unknown.includes(person) ? null : false;
};

/** A room — any space of a home but its ground — as a script sees it: whether anyone is in it. */
const roomOf = (info: PlaceInfo) =>
  Object.freeze({
    id: info.id,
    key: info.key,
    name: info.name,
    get occupied(): boolean | null {
      return read({ occupied: ['space', info.id] }) as boolean | null;
    },
  });

/** A home, as a script sees it: its rooms, who is there, its modes now — and set. */
const homeOf = (info: HomeInfo) =>
  Object.freeze({
    id: info.id,
    key: info.key,
    name: info.name,
    rooms: named('room', () => info.rooms, (room) => room.key, roomOf),
    /** Whether anyone is home: null when it cannot be told. */
    get occupied(): boolean | null {
      return read({ occupied: ['home', info.id] }) as boolean | null;
    },
    /** Its mode on the presence axis now — home, away — by key; null when none is set. */
    get presence(): string | null {
      return read({ mode: [info.id, 'presence'] }) as string | null;
    },
    /** Its mode on the day axis now — morning, night — by key; null when none is set. */
    get day(): string | null {
      return read({ mode: [info.id, 'day'] }) as string | null;
    },
    /** Who of the family is home now, as far as each shares. */
    get people(): string[] {
      return ((read({ at: ['home', info.id] }) as { at: string[] } | null)?.at ?? []).map((id) => (read({ people: true }) as PersonInfo[]).find((each) => each.id === id)?.name ?? id);
    },
    /** It put in a mode, as this run puts it. */
    setMode: (mode: string): Promise<unknown> => call(['run', 'setMode'], [{ mode, home: info.id }]),
  });

const homesNow = (): HomeInfo[] => read({ homes: true }) as HomeInfo[];

/** The family's homes, by key: `homes.cabin`. */
const homes = named('home', homesNow, (info) => info.key, homeOf);

/** A person of the family, as a script sees them: where they are, as far as they share, and told something. */
const personOf = (info: PersonInfo) =>
  Object.freeze({
    id: info.id,
    name: info.name,
    /** Whether they are at this script's home: null when they share too little to tell. */
    get isHome(): boolean | null {
      const own = read({ home: true }) as string | null;
      return own ? isAt(info.id, 'home', own) : null;
    },
    /** Whether they are at a home, or in one of its rooms: null when they share too little to tell. */
    isAt: (place: { id: string }): boolean | null => {
      const home = homesNow().find((each) => each.id === place.id);
      return isAt(info.id, home ? 'home' : 'space', place.id);
    },
    /** Them told something, as this run tells them. */
    tell: (title: string, text?: string): Promise<unknown> => call(['run', 'notify'], [{ title, ...(text ? { text } : {}), to: [info.id] }]),
  });

/** The family, by name: `family.maria`. */
const family = named('person', () => read({ people: true }) as PersonInfo[], (info) => info.name, personOf);

/** This script's home: the automation's, or the family's first. */
const home = new Proxy({} as ReturnType<typeof homeOf>, {
  get: (_, name) => {
    const own = read({ home: true }) as string | null;
    const info = homesNow().find((each) => each.id === own);
    if (!info) throw new KraftverkError('not-found', 'The family has no home');
    return Reflect.get(homeOf(info), name);
  },
});

/** A pause, on the home's clock: at most until the step must end; stopped with its run. */
const sleep = async (seconds: number): Promise<void> => {
  await host(typeof __wait === 'undefined' ? undefined : __wait, 'wait')(String(Math.max(0, seconds) * 1000));
};

/** The family told something, as this automation tells it: everyone, or the people it names by id. */
const notify = (title: string, options: { text?: string; to?: readonly string[] } = {}): Promise<unknown> => call(['run', 'notify'], [{ title, ...options }]);

/** A home put in a mode — its own, unless it names another — as this automation puts it. */
const setMode = (mode: string, homeId?: string): Promise<unknown> => call(['run', 'setMode'], [{ mode, ...(homeId ? { home: homeId } : {}) }]);

const KRAFTVERK = Object.freeze({ log, family, home, homes, devices, sleep, notify, setMode, KraftverkError });

/** What a script imports, by name: the SDK, and nothing else — given to it as its `require`. */
const imported = (name: string): unknown => {
  if (name === 'kraftverk') return KRAFTVERK;
  if (name === 'kraftverk/api') return API;
  throw new Error(`A script imports only "kraftverk" and "kraftverk/api", not "${name}"`);
};

const exported: Record<string, unknown> = {};

/** A compiled script's module, run once: what it exports, kept by name. */
const load = (module: (exports: Record<string, unknown>, require: (name: string) => unknown) => void): void => {
  module(exported, imported);
};

/** What the script exports, as JSON: each name, and whether it is a function. */
const describe = (): string => JSON.stringify(Object.fromEntries(Object.entries(exported).flatMap(([name, value]) => (name === '__esModule' ? [] : [[name, typeof value === 'function' ? 'function' : 'other']]))));

/** One of its exports, by name, as a function. */
const exportedFn = (name: string): ((...args: unknown[]) => unknown) => {
  const found = exported[name];
  if (typeof found !== 'function' || !Object.hasOwn(exported, name)) throw new Error(`It exports no function "${name}"`);
  return found as (...args: unknown[]) => unknown;
};

/** One of its functions, called with its arguments: its answer, as JSON. */
const callFn = (text: string): string => {
  const { name, args } = JSON.parse(text) as { name: string; args: unknown[] };
  return JSON.stringify(exportedFn(name)(...args) ?? null);
};

/** One of its steps, run with its arguments in order — what it remembers among them, at `memory` — its answer and its memory after, as JSON. */
const callStep = async (text: string): Promise<string> => {
  const { name, args, memory } = JSON.parse(text) as { name: string; args: unknown[]; memory: number | null };
  const answer = await exportedFn(name)(...args);
  return JSON.stringify({ answer: answer ?? null, memory: memory === null ? {} : args[memory] });
};

const scope = globalThis as unknown as Record<string, unknown>;
scope.__kraftverk = Object.freeze({ load });
scope.__describe = describe;
scope.__fn = callFn;
scope.__step = callStep;
