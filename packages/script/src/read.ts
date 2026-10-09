import { SCRIPT_LIMITS, type ScriptCheck, type ScriptFunctionShape, type ScriptProblem, type ScriptShape, type ScriptStepShape } from '@kraftverk/automation';
import { isUnit, type ConfigField, type ConfigSchema } from '@kraftverk/device-sdk';

import { compileScript, type Compiled } from './compile.ts';
import { ScriptFault, type Sandbox, type ScriptEngine } from './engine.ts';
import { GUEST_SDK } from './generated/guest.ts';

/*
  Reading a script (docs/PLAN-SCRIPTS.md §8.4): how long it is, whether it
  compiles, what it imports, and what it declares — read by running its top
  level once in a sandbox that reaches nothing, the SDK's `step` and `fn`
  keeping what they are given. No compiler of types is needed, so a hub
  reads a script wherever it runs; the editor checks its types besides.
*/

/** What a script imports: the SDK alone, until the script step brings the API. */
const IMPORTS: readonly string[] = ['kraftverk'];

/** What a script's exports are named: as recipes and the language's own names are. */
const NAME = /^[a-z][A-Za-z0-9]*$/;

/** A script read: its JavaScript and its shape, or what is wrong with it. */
export type ReadScript = ScriptCheck & { compiled: Compiled | null };

const problem = (message: string, at: { line?: number | null; column?: number | null } = {}): ScriptProblem => ({ message, line: at.line ?? null, column: at.column ?? null });

/**
 * The SDK and then the script, run into a sandbox: what every sandbox a
 * script runs in starts from. The script's lines are its own, as written —
 * the line it is wrapped in begins on its first.
 */
export function loadScript(sandbox: Sandbox, compiled: Compiled): void {
  sandbox.evaluate(GUEST_SDK, 'kraftverk.js');
  sandbox.evaluate(`__kraftverk.load(function (exports, require) {${compiled.code}\n});`, 'script.ts');
}

/** A name in words: "emptyFor" is "Empty for". */
const wordsOf = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A field as the guest declared it, as the language's own — or what is wrong with it. */
function fieldOf(raw: unknown, title: string, where: string, problems: ScriptProblem[]): ConfigField | null {
  if (typeof raw !== 'object' || raw === null) {
    problems.push(problem(`${where}: declare it with t.number(), t.text() and the rest`));
    return null;
  }
  const given = raw as Record<string, unknown>;
  const presented = {
    title: typeof given.title === 'string' && given.title.trim() ? given.title.trim() : title,
    ...(typeof given.description === 'string' ? { description: given.description } : {}),
  };
  const number = (key: string): number | undefined => (typeof given[key] === 'number' && Number.isFinite(given[key]) ? (given[key] as number) : undefined);
  switch (given.type) {
    case 'number': {
      if (given.unit !== undefined && !isUnit(given.unit)) {
        problems.push(problem(`${where}: "${String(given.unit)}" is not a unit kraftverk knows`));
        return null;
      }
      const field: ConfigField = { type: 'number', ...presented };
      if (isUnit(given.unit)) field.unit = given.unit;
      for (const key of ['min', 'max', 'step', 'default'] as const) {
        const value = number(key);
        if (value !== undefined) field[key] = value;
      }
      if (given.integer === true) field.integer = true;
      return field;
    }
    case 'boolean':
      return { type: 'boolean', ...presented, ...(typeof given.default === 'boolean' ? { default: given.default } : {}) };
    case 'string':
      return { type: 'string', ...presented, ...(typeof given.default === 'string' ? { default: given.default } : {}) };
    case 'timestamp':
      return { type: 'timestamp', ...presented };
    case 'enum': {
      const options = Array.isArray(given.options) ? given.options : [];
      const fine = options.every((option) => typeof option === 'object' && option !== null && typeof option.value === 'string' && typeof option.label === 'string');
      if (!options.length || !fine) {
        problems.push(problem(`${where}: a choice has its options, each a value and its words`));
        return null;
      }
      return { type: 'enum', ...presented, options: options as { value: string; label: string }[], ...(typeof given.default === 'string' ? { default: given.default } : {}) };
    }
    default:
      problems.push(problem(`${where}: declare it with t.number(), t.text() and the rest`));
      return null;
  }
}

/** Fields by name, as a schema of the language's. */
function schemaOf(raw: unknown, where: string, problems: ScriptProblem[]): ConfigSchema {
  const fields: ConfigSchema['fields'] = {};
  for (const [name, value] of Object.entries(typeof raw === 'object' && raw !== null ? raw : {})) {
    if (!NAME.test(name)) {
      problems.push(problem(`${where} "${name}": a name is a word in camelCase, as "emptyFor"`));
      continue;
    }
    const field = fieldOf(value, wordsOf(name), `${where} "${name}"`, problems);
    if (field) fields[name] = field;
  }
  return { fields };
}

/** What the guest said the script declares, as the language's shape — or what is wrong with it. */
function shapeOf(text: string, problems: ScriptProblem[]): ScriptShape {
  const said = JSON.parse(text) as { steps: Record<string, Record<string, unknown>>; functions: Record<string, Record<string, unknown>>; problems: string[] };
  problems.push(...said.problems.map((message) => problem(message)));
  const steps: Record<string, ScriptStepShape> = {};
  const functions: Record<string, ScriptFunctionShape> = {};
  for (const [name, step] of Object.entries(said.steps)) {
    if (!NAME.test(name)) problems.push(problem(`The step "${name}": a name is a word in camelCase, as "tidyUp"`));
    steps[name] = {
      inputs: schemaOf(step.inputs, `The step "${name}", its input`, problems),
      answer: step.answer === null ? null : fieldOf(step.answer, 'Answer', `The step "${name}", its answer`, problems),
      memory: schemaOf(step.memory, `The step "${name}", what it remembers,`, problems),
    };
  }
  for (const [name, fn] of Object.entries(said.functions)) {
    if (!NAME.test(name)) problems.push(problem(`The function "${name}": a name is a word in camelCase, as "feelsLike"`));
    const args = (Array.isArray(fn.args) ? fn.args : []).map((arg, at) => fieldOf(arg, `Argument ${at + 1}`, `The function "${name}", its argument ${at + 1}`, problems));
    const returns = fieldOf(fn.returns, 'Answer', `The function "${name}", what it returns`, problems);
    if (returns && args.every((arg) => arg !== null)) functions[name] = { args: args as ConfigField[], returns };
  }
  if (!Object.keys(steps).length && !Object.keys(functions).length && !said.problems.length) problems.push(problem('It declares nothing: export a step(...) or a fn(...)'));
  return { steps, functions };
}

/**
 * A script read on `engine`: compiled, its imports looked at, and its shape
 * read by running its top level once, with nothing of the home in reach.
 */
export function readScript(source: string, engine: ScriptEngine): ReadScript {
  if (new TextEncoder().encode(source).length > SCRIPT_LIMITS.sourceBytes) return { compiled: null, shape: null, problems: [problem(`A script is at most ${SCRIPT_LIMITS.sourceBytes / 1024} KB`)] };
  const compiledOr = compileScript(source);
  if ('problem' in compiledOr) return { compiled: null, shape: null, problems: [compiledOr.problem] };
  const { compiled } = compiledOr;
  const problems: ScriptProblem[] = compiled.imports.filter((name) => !IMPORTS.includes(name)).map((name) => problem(`A script imports only "kraftverk", not "${name}"`));
  if (problems.length) return { compiled, shape: null, problems };

  const sandbox = engine.open({ memoryBytes: SCRIPT_LIMITS.functionMemoryBytes, stackBytes: 256 * 1024, sliceMs: SCRIPT_LIMITS.describeMs }, { sync: {}, async: {} });
  try {
    loadScript(sandbox, compiled);
    const shape = shapeOf(sandbox.call('__describe', ''), problems);
    return { compiled, shape: problems.length ? null : shape, problems };
  } catch (error) {
    if (!(error instanceof ScriptFault)) throw error;
    return { compiled, shape: null, problems: [problem(error.kind === 'time' ? `Its top level ran for more than ${SCRIPT_LIMITS.describeMs} ms: keep the work inside its steps and functions` : error.message, error)] };
  } finally {
    sandbox.dispose();
  }
}
