import { convertible, isUnit, type ConfigField, type ConfigSchema, type Value, type ValueType } from '@kraftverk/device-sdk';

import type { Expr } from './rule.ts';

/*
  Scripts, as the language sees them (docs/PLAN-SCRIPTS.md §8.4, §8.5): what
  a script declares it holds — its steps, with their inputs, answer and
  memory, and its functions, with their arguments and result — in the same
  fields the language's own `inputs:`, `memory:` and `result:` are written
  in; and how far a script may go. The language owns both: it checks the
  automations that use a script against its shape, and says its limits in
  words.
*/

/** One of a script's steps: what it is given, what it answers, what it keeps between runs. */
export type ScriptStepShape = {
  /** What it does, in its doc comment's words; null when it has none. */
  about: string | null;
  inputs: ConfigSchema;
  answer: ConfigField | null;
  memory: ConfigSchema;
};

/** One of a script's functions: pure, its arguments in order, and what it gives back. */
export type ScriptFunctionShape = {
  /** What it works out, in its doc comment's words; null when it has none. */
  about: string | null;
  args: readonly ConfigField[];
  returns: ConfigField;
};

/** What a script declares, by its exports' names: read from it, never written beside it. */
export type ScriptShape = {
  steps: Record<string, ScriptStepShape>;
  functions: Record<string, ScriptFunctionShape>;
};

/**
 * The role a script fills when it is named by its key alone — a step's
 * `run script: tidy-up` — as the file's reader makes it, the form makes it,
 * and the writer knows it: `tidyUp`, labelled "Tidy up".
 */
export function scriptRoleOf(key: string): { role: string; label: string } {
  const words = key.split('-').filter(Boolean);
  const joined = words.map((word, at) => (at ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join('');
  // A role begins with a letter: "1-minute-tidy" is `script1MinuteTidy`.
  const role = /^[a-z]/.test(joined) ? joined : `script${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  const label = words.join(' ');
  return { role, label: label.charAt(0).toUpperCase() + label.slice(1) };
}

/** A name in code as a person says it: "tidyUp" is "Tidy up", "feelsLike" "Feels like". */
export function wordsOfName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A number as a person reads it beside its unit: a length of time in the largest units that say it, "1 h 30 min"; anything else as it is, "20 %". */
export function amountText(value: number, unit: string | undefined): string {
  if (unit !== 's') return `${value}${unit ? ` ${unit}` : ''}`;
  const [hours, minutes, seconds] = [Math.floor(value / 3_600), Math.floor((value % 3_600) / 60), value % 60];
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', seconds || !value ? `${seconds} s` : ''].filter(Boolean).join(' ');
}

/** What a field holds, in words: "a length of time, from 1 min, by default 10 min", "a number in °C", "yes or no". */
export function fieldWords(field: ConfigField): string {
  switch (field.type) {
    case 'number':
      return [
        field.unit === 's' ? 'a length of time' : field.unit ? `a number in ${field.unit}` : 'a number',
        field.integer ? 'whole' : null,
        field.min !== undefined ? `from ${amountText(field.min, field.unit)}` : null,
        field.max !== undefined ? `to ${amountText(field.max, field.unit)}` : null,
        field.default !== undefined ? `by default ${amountText(field.default, field.unit)}` : null,
      ]
        .filter(Boolean)
        .join(', ');
    case 'boolean':
      return field.default === undefined ? 'yes or no' : `yes or no, by default ${field.default ? 'yes' : 'no'}`;
    case 'enum':
      return `one of ${field.options.map((option) => option.label).join(', ')}${field.default !== undefined ? `, by default ${field.options.find((option) => option.value === field.default)?.label ?? field.default}` : ''}`;
    case 'timestamp':
      return 'a date and time';
    default:
      return field.default ? `text, by default “${field.default}”` : 'text';
  }
}

/** A value a field starts from, as an expression writes it: its default, or nought in its unit, yes, its first option, nothing. */
export function fieldStart(field: ConfigField): Expr {
  if (field.type === 'number') return { value: field.default ?? 0, ...(field.unit && isUnit(field.unit) ? { unit: field.unit } : {}) };
  if (field.type === 'boolean') return { value: field.default ?? true };
  if (field.type === 'enum') return { value: field.default ?? field.options[0]?.value ?? '' };
  return { value: (field.default ?? '') as Value };
}

/** Whether what a part reports may be given to a field: a number in a unit that converts to its own, or a value of its type. */
export function fitsField(field: ConfigField, value: ValueType): boolean {
  if (field.type !== 'number') return value.type === field.type;
  if (value.type !== 'number') return false;
  return !field.unit || (value.unit !== undefined && isUnit(field.unit) && isUnit(value.unit) && convertible(value.unit, field.unit));
}

/** A script's key as a step names it by its key alone (`run script: tidy-up`): what the file's reader takes for a key, and the writer writes so. */
export const SCRIPT_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What is wrong with a script, and where, when it is known: its line and column, counted from 1. */
export type ScriptProblem = { message: string; line: number | null; column: number | null };

/** A script read: what it declares, or what is wrong with it. */
export type ScriptCheck = { shape: ScriptShape | null; problems: ScriptProblem[] };

/** How far a script may go: each said in words where it is reached. */
export const SCRIPT_LIMITS = {
  /** The longest a script's source may be, in bytes. */
  sourceBytes: 65_536,
  /** The longest reading what a script declares may take: the SDK loaded and its top level run — on a busy machine, or a phone, as well. */
  describeMs: 250,
  /** A step's heap and stack. */
  stepMemoryBytes: 32 * 1024 * 1024,
  stepStackBytes: 512 * 1024,
  /** The longest a step runs without waiting on the hub. */
  sliceMs: 100,
  /** The most work one step's run may do, all its slices counted. */
  stepCpuMs: 2_000,
  /** The most calls to the home in one step's run. */
  calls: 500,
  /** Of those, the most that change something. */
  acts: 50,
  /** The most lines of its log a run keeps; the rest are counted. */
  logLines: 100,
  /** The largest answer a step gives, as JSON. */
  answerBytes: 16_384,
  /** A function's heap, and the longest one call may take. */
  functionMemoryBytes: 8 * 1024 * 1024,
  functionMs: 5,
  /** The most sandboxes one hub keeps open at once. */
  sandboxes: 8,
} as const;
