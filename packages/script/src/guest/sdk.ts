/*
  The guest SDK: what runs inside a sandbox before a script, and what a
  script imports as `kraftverk` (docs/PLAN-SCRIPTS.md §6). Bundled into one
  string of JavaScript (`../generated/guest.ts`, by
  scripts/gen-script-guest.ts) and evaluated first in every sandbox.

  It imports nothing at run time: inside there is only the language itself
  and what the host lends as globals. Types are its own to say, and erased.

  What it holds so far: the builders a script declares its shape with
  (`step`, `fn`, `t`), `log`, the `require` a compiled script is given, and
  the entries the host calls — `__describe`, `__fn`, `__step`. The home and
  the API come with the script step.
*/

/** A host function, when the host lends it: answered at once. */
declare const __log: ((text: string) => string) | undefined;

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

const KRAFTVERK = Object.freeze({ step, fn, t, log });

/** What a script imports, by name: the SDK, and nothing else — given to it as its `require`. */
const imported = (name: string): unknown => {
  if (name === 'kraftverk') return KRAFTVERK;
  throw new Error(`A script imports only "kraftverk", not "${name}"`);
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
  const { name, inputs, memory } = JSON.parse(text) as { name: string; inputs: Record<string, unknown>; memory: Record<string, unknown> };
  const found = steps.get(name);
  if (!found) throw new Error(`There is no step "${name}"`);
  const kept = { ...memory };
  const answer = await found.run(inputs, { memory: kept });
  return JSON.stringify({ answer: answer ?? null, memory: kept });
};

const scope = globalThis as unknown as Record<string, unknown>;
scope.__kraftverk = Object.freeze({ load });
scope.__describe = describe;
scope.__fn = callFn;
scope.__step = callStep;
