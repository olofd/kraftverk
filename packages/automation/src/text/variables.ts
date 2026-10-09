import { convert, UNITS, isUnit, type ConfigField, type Unit } from '@kraftverk/device-sdk';

import { VARIABLE_KINDS, variableProblems, type VariableKind, type VariableSpec } from '../variables.ts';
import { parseExpr } from './expr.ts';

/*
  A home's variables as a configuration file writes them, under the home's
  `variables:` (docs/CONFIG.md): each by its key, its kind, and — when it
  says more — its title, what it starts as, a number's unit and range, a
  choice's options. What each holds now is the home's, not the file's.

    variables:
      guests: { kind: toggle, title: Guests staying }
      dryerRuns: { kind: counter, title: Dryer runs, max: 99 }
      target: { kind: number, title: Target, starts: 21 °C, min: 16 °C, max: 25 °C }
      laundry: { kind: choice, options: { washing: Washing, drying: Drying, done: Done } }
      wake: { kind: time, title: Wake at, starts: "06:45" }
      note: { kind: text }
*/

type Path = readonly (string | number)[];
type Fail = (message: string, path: Path) => never;

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data);

const KEYS = ['kind', 'title', 'description', 'starts', 'unit', 'min', 'max', 'step', 'options'] as const;

/** "dryerRuns" is "Dryer runs", as the app calls a variable the file gives no title. */
const titleOf = (key: string): string => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A number as written — "21 °C", "2 min", 40 — with its unit; a length of time in seconds. */
function numberOf(data: unknown, at: Path, fail: Fail): { value: number; unit: Unit | null } {
  if (typeof data === 'number' && Number.isFinite(data)) return { value: data, unit: null };
  if (typeof data !== 'string' || !/^\s*-?\d/.test(data)) return fail('Expected a number, with its unit if it has one: "21 °C"', at);
  const parsed = parseExpr(data);
  if (!parsed.ok) return fail(parsed.error.message, at);
  const expr = parsed.expr;
  return 'value' in expr && typeof expr.value === 'number' ? { value: expr.value, unit: expr.unit ?? null } : fail('Expected a number, with its unit if it has one: "21 °C"', at);
}

/** One of a home's variables, from a file: its kind and field, checked as the app checks one made there. */
export function variableFromConfig(key: string, data: unknown, path: Path, fail: Fail): VariableSpec {
  if (typeof data === 'string' && (VARIABLE_KINDS as readonly string[]).includes(data)) return variableFromConfig(key, { kind: data }, path, fail);
  if (!isRecord(data)) return fail(`Expected a variable: its kind — ${VARIABLE_KINDS.join(', ')} — and what more it says`, path);
  for (const name of Object.keys(data)) if (!(KEYS as readonly string[]).includes(name)) fail(`"${name}" is not part of a variable: it takes ${KEYS.join(', ')}`, [...path, name]);
  const kind = (VARIABLE_KINDS as readonly string[]).includes(data.kind as string) ? (data.kind as VariableKind) : fail(`"kind" is one of ${VARIABLE_KINDS.join(', ')}`, [...path, 'kind']);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : titleOf(key);
  const described = typeof data.description === 'string' && data.description.trim() ? { description: data.description.trim() } : {};
  const starts = data.starts;
  const only = (names: readonly string[]) => {
    for (const name of ['unit', 'min', 'max', 'step', 'options'] as const) if (data[name] !== undefined && !names.includes(name)) fail(`A ${kind} has no "${name}"`, [...path, name]);
  };
  let field: ConfigField;
  switch (kind) {
    case 'toggle':
      only([]);
      if (starts !== undefined && typeof starts !== 'boolean') fail('A toggle starts as true or false', [...path, 'starts']);
      field = { type: 'boolean', title, ...described, ...(typeof starts === 'boolean' ? { default: starts } : {}) };
      break;
    case 'text':
    case 'time':
      only([]);
      if (starts !== undefined && typeof starts !== 'string') fail(kind === 'time' ? 'A time starts as a time of day: "06:45"' : 'Words start as words', [...path, 'starts']);
      field = { type: 'string', title, ...described, ...(typeof starts === 'string' ? { default: starts } : {}) };
      break;
    case 'choice': {
      only(['options']);
      if (!isRecord(data.options) || !Object.keys(data.options).length) return fail('A choice has its options, each by its value with its words: "options: { washing: Washing, done: Done }"', [...path, 'options']);
      const options = Object.entries(data.options).map(([value, label]) => ({ value, label: typeof label === 'string' && label.trim() ? label.trim() : value }));
      if (starts !== undefined && !options.some((option) => option.value === starts)) fail(`It starts as one of its options: ${options.map((option) => option.value).join(', ')}`, [...path, 'starts']);
      field = { type: 'enum', title, ...described, options, ...(typeof starts === 'string' ? { default: starts } : {}) };
      break;
    }
    case 'number':
    case 'counter': {
      only(kind === 'counter' ? ['min', 'max'] : ['unit', 'min', 'max', 'step']);
      const named = data.unit === undefined ? null : typeof data.unit === 'string' && isUnit(data.unit) ? data.unit : fail(`"${String(data.unit)}" is not a unit kraftverk knows: °C, kWh, %, W`, [...path, 'unit']);
      const written = (['starts', 'min', 'max', 'step'] as const).flatMap((name) => (data[name] === undefined ? [] : [{ name, ...numberOf(data[name], [...path, name], fail) }]));
      // Its unit: said, or as its numbers are written — a length of time kept in seconds.
      const said = named ?? written.find((each) => each.unit)?.unit ?? null;
      if (kind === 'counter' && said) fail('A counter counts: it has no unit', path);
      const unit: Unit | null = said && UNITS[said].dimension === 'time' ? 's' : said;
      const inUnit = (name: string): number | undefined => {
        const number = written.find((each) => each.name === name);
        if (!number) return undefined;
        if (!unit) return number.unit ? fail(`"${name}" says ${number.unit}, but the variable has no unit`, [...path, name]) : number.value;
        const converted = convert(number.value, number.unit ?? unit, unit);
        return converted === null ? fail(`"${name}" is in ${number.unit}, not a unit of ${unit}`, [...path, name]) : converted;
      };
      const [value, min, max, step] = [inUnit('starts'), inUnit('min'), inUnit('max'), inUnit('step')];
      field = {
        type: 'number',
        title,
        ...described,
        ...(unit ? { unit } : {}),
        ...(kind === 'counter' ? { integer: true, min: min ?? 0 } : min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(value !== undefined ? { default: value } : {}),
      };
      break;
    }
  }
  const spec: VariableSpec = { key, kind, field };
  const problems = variableProblems(spec);
  if (problems.length) fail(problems[0]!, path);
  return spec;
}

/** A number as a file writes it: with its unit — a length of time in the largest unit that says it whole. */
function numberText(value: number, unit: Unit | undefined): string | number {
  if (!unit) return value;
  if (unit === 's') {
    if (value !== 0 && value % 3_600 === 0) return `${value / 3_600} h`;
    if (value !== 0 && value % 60 === 0) return `${value / 60} min`;
  }
  return `${value} ${unit}`;
}

/** One of a home's variables as a file writes it: its kind, and only what more it says. */
export function variableToConfig(spec: VariableSpec): Record<string, unknown> {
  const { kind, field } = spec;
  const number = field.type === 'number' ? field : null;
  return {
    kind,
    ...(field.title !== titleOf(spec.key) ? { title: field.title } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.default !== undefined ? { starts: number ? numberText(field.default as number, number.unit) : field.default } : {}),
    // A number's unit, said outright where none of its numbers says it.
    ...(number?.unit && kind === 'number' && field.default === undefined && number.min === undefined && number.max === undefined && number.step === undefined ? { unit: number.unit } : {}),
    ...(number && number.min !== undefined && !(kind === 'counter' && number.min === 0) ? { min: numberText(number.min, number.unit) } : {}),
    ...(number?.max !== undefined ? { max: numberText(number.max, number.unit) } : {}),
    ...(number?.step !== undefined ? { step: numberText(number.step, number.unit) } : {}),
    ...(field.type === 'enum' ? { options: Object.fromEntries(field.options.map((option) => [option.value, option.label])) } : {}),
  };
}
