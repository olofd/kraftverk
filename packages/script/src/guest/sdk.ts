/*
  The guest SDK: what runs inside a sandbox before a script, and what a
  script imports as `kraftverk` (docs/PLAN-SCRIPTS.md §6). Bundled into one
  string of JavaScript (`../generated/guest.ts`, by
  scripts/gen-script-guest.ts) and evaluated first in every sandbox.

  It imports nothing at run time: inside there is only the language itself
  and what the host lends as globals. Types are its own to say, and erased.

  What it holds: the builders a script declares its shape with (`step`,
  `fn`, `t`); `log`; the home as objects (`home.devices`, each read and
  told by its capabilities); the whole API (`kraftverk/api`, as the app
  has it); `sleep`, `notify` and `setMode`; the `require` a compiled script
  is given; and the entries the host calls — `__describe`, `__fn`, `__step`.

  What the host lends, only while a step runs (none to a function, none to
  its top level): `__read` (answered at once, from the home as it is),
  `__call` and `__wait` (answered later: one more slice each).
*/

/** The host's functions, when it lends them: answered at once, or later. */
declare const __log: ((text: string) => string) | undefined;
declare const __read: ((query: string) => string) | undefined;
declare const __call: ((call: string) => Promise<string>) | undefined;
declare const __wait: ((ms: string) => Promise<string>) | undefined;

type Field = { type: string; [more: string]: unknown };
type Fields = Record<string, Field>;

type StepSpec = { inputs?: Fields; answer?: Field; memory?: Fields };
type FnSpec = { args?: readonly Field[]; returns: Field };

type StepDecl = { readonly kind: 'step'; readonly spec: StepSpec; readonly run: (inputs: Record<string, unknown>, context: { memory: Record<string, unknown> }) => unknown };
type FnDecl = { readonly kind: 'fn'; readonly spec: FnSpec; readonly run: (...args: unknown[]) => unknown };

const DECLARED = Symbol('kraftverk.declared');
type Declared = (StepDecl | FnDecl) & { readonly [DECLARED]: true };

const declared = (value: unknown): value is Declared => typeof value === 'object' && value !== null && (value as { [DECLARED]?: boolean })[DECLARED] === true;

/** A step: given its inputs, it may wait on the home and act, and answers. */
const step = (spec: StepSpec, run: StepDecl['run']): Declared => Object.freeze({ kind: 'step', spec, run, [DECLARED]: true }) as Declared;
/** A function: pure, its arguments in order, its answer at once. */
const fn = (spec: FnSpec, run: FnDecl['run']): Declared => Object.freeze({ kind: 'fn', spec, run, [DECLARED]: true }) as Declared;

type Options = Record<string, unknown>;
/** The fields a shape is declared in: the language's own, named for what they hold. */
const t = {
  number: (options: Options = {}): Field => ({ ...options, type: 'number' }),
  /** A length of time, in seconds, as the language keeps every duration. */
  duration: (options: Options = {}): Field => ({ min: 0, ...options, type: 'number', unit: 's' }),
  /** A whole number from nothing up. */
  count: (options: Options = {}): Field => ({ min: 0, ...options, type: 'number', integer: true }),
  flag: (options: Options = {}): Field => ({ ...options, type: 'boolean' }),
  text: (options: Options = {}): Field => ({ ...options, type: 'string' }),
  choice: (options: readonly (string | { value: string; label: string })[], more: Options = {}): Field => ({
    ...more,
    type: 'enum',
    options: options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option)),
  }),
  /** An instant: a date and a time. */
  instant: (options: Options = {}): Field => ({ ...options, type: 'timestamp' }),
};

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
 * and, by capability, what it can be told — on its main part, or `part(id)`.
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
    },
    {
      get: (target, name, receiver) => {
        if (typeof name !== 'string' || name in target) return Reflect.get(target, name, receiver);
        return main?.capabilities.includes(name) ? capabilityOf(info, main.id, name) : undefined;
      },
    }
  );
};

/** The home as objects: its devices, by key — read again each time they are asked for. */
const home = Object.freeze({
  get devices(): Record<string, ReturnType<typeof deviceOf>> {
    return Object.fromEntries((read({ devices: true }) as DeviceInfo[]).map((info) => [info.key, deviceOf(info)]));
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

const KRAFTVERK = Object.freeze({ step, fn, t, log, home, sleep, notify, setMode, KraftverkError });

/** What a script imports, by name: the SDK, and nothing else — given to it as its `require`. */
const imported = (name: string): unknown => {
  if (name === 'kraftverk') return KRAFTVERK;
  if (name === 'kraftverk/api') return API;
  throw new Error(`A script imports only "kraftverk" and "kraftverk/api", not "${name}"`);
};

const steps = new Map<string, StepDecl>();
const functions = new Map<string, FnDecl>();
const problems: string[] = [];

/** A compiled script's module, run once: what it exports, kept by name. */
const load = (module: (exports: Record<string, unknown>, require: (name: string) => unknown) => void): void => {
  const exports: Record<string, unknown> = {};
  module(exports, imported);
  for (const [name, value] of Object.entries(exports)) {
    if (name === '__esModule') continue;
    if (!declared(value)) problems.push(`"${name}" is neither a step nor a function: export only step(...) and fn(...)`);
    else if (value.kind === 'step') steps.set(name, value);
    else functions.set(name, value);
  }
};

/** What the script declares, as JSON: its steps, its functions, and what is wrong with its exports. */
const describe = (): string =>
  JSON.stringify({
    steps: Object.fromEntries([...steps].map(([name, { spec }]) => [name, { inputs: spec.inputs ?? {}, answer: spec.answer ?? null, memory: spec.memory ?? {} }])),
    functions: Object.fromEntries([...functions].map(([name, { spec }]) => [name, { args: spec.args ?? [], returns: spec.returns }])),
    problems,
  });

/** One of its functions, called with its arguments: its answer, as JSON. */
const callFn = (text: string): string => {
  const { name, args } = JSON.parse(text) as { name: string; args: unknown[] };
  const found = functions.get(name);
  if (!found) throw new Error(`There is no function "${name}"`);
  return JSON.stringify(found.run(...args) ?? null);
};

/** One of its steps, run with its inputs and memory: its answer and its memory after, as JSON. */
const callStep = async (text: string): Promise<string> => {
  const { name, inputs, memory } = JSON.parse(text) as { name: string | null; inputs: Record<string, unknown>; memory: Record<string, unknown> };
  // Its only step, when the automation does not say which.
  const found = name === null ? (steps.size === 1 ? [...steps.values()][0] : undefined) : steps.get(name);
  if (!found) throw new Error(name === null ? `Which of its steps? It has ${[...steps.keys()].join(', ') || 'none'}` : `There is no step "${name}"`);
  const kept = { ...memory };
  const answer = await found.run(inputs, { memory: kept });
  return JSON.stringify({ answer: answer ?? null, memory: kept });
};

const scope = globalThis as unknown as Record<string, unknown>;
scope.__kraftverk = Object.freeze({ load });
scope.__describe = describe;
scope.__fn = callFn;
scope.__step = callStep;
