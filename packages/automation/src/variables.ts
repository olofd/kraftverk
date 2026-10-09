import { CAMEL_NAME, checkValue, valueTypeOf, type ConfigField, type Unit, type ValueType } from '@kraftverk/device-sdk';

import { CLOCK_TIME } from './clock.ts';

/*
  A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md §2): typed state
  of the home's own, which its automations read and set, its people see and
  change, and its scripts reach — "guests are staying", "the dryer has run
  3 times", "wake me at 06:45". Each is a field, in the shape settings,
  memory and inputs are written in, and a kind that says how it changes.
  The language owns what a variable is and holds; where its value is kept,
  and who set it, is the hub's.
*/

/** How a variable holds and changes: yes or no, a number in a unit, one of its options, words, a time of day, a count. */
export const VARIABLE_KINDS = ['toggle', 'number', 'choice', 'text', 'time', 'counter'] as const;

export type VariableKind = (typeof VARIABLE_KINDS)[number];

/** Each kind, in words, as the app offers it. */
export const VARIABLE_KIND_WORDS: Readonly<Record<VariableKind, { label: string; says: string }>> = {
  toggle: { label: 'Yes or no', says: 'On or off, true or not: guests are staying, the heating is paused.' },
  number: { label: 'A number', says: 'A number, in a unit and a range: a target temperature, a price ceiling.' },
  choice: { label: 'A choice', says: 'One of its options: the laundry is washing, drying or done.' },
  text: { label: 'Words', says: 'A line of text: a note for the family, a message to show.' },
  time: { label: 'A time of day', says: 'A time on the clock: when to wake, when quiet hours start.' },
  counter: { label: 'A counter', says: 'A whole number counted up and down: the times the dryer ran.' },
};

/** A home's variable, as the language sees it: its key, how it holds, and its field — its title, its type, its range, what it starts as. */
export type VariableSpec = { key: string; kind: VariableKind; field: ConfigField };

/** A variable's key: a word in camelCase, as a setting's or a memory's name — `guests`, `dryerRuns`. */
export const VARIABLE_KEY = CAMEL_NAME;

/** What a variable holds, as an expression types it: a time of day is text on the clock, `07:00`. */
export const variableType = (spec: VariableSpec): ValueType => valueTypeOf(spec.field);

/**
 * What is wrong with a variable as declared — its key, its title, its field
 * not fitting its kind, what it starts as not fitting its field — in words;
 * none, an empty list. A counter is whole; a time is a time of day; a
 * choice has options; a range is from its least to its most.
 */
export function variableProblems(spec: VariableSpec): string[] {
  const { kind, field } = spec;
  const problems: string[] = [];
  if (!VARIABLE_KINDS.includes(kind)) return [`A variable is one of: ${VARIABLE_KINDS.join(', ')}`];
  if (!VARIABLE_KEY.test(spec.key)) problems.push(`"${spec.key}": a variable's key is a word in camelCase, as "dryerRuns"`);
  if (typeof field?.title !== 'string' || !field.title.trim() || field.title.length > 60) problems.push('A variable has a title of 1 to 60 characters');
  const wants: Record<VariableKind, ConfigField['type']> = { toggle: 'boolean', number: 'number', choice: 'enum', text: 'string', time: 'string', counter: 'number' };
  if (field?.type !== wants[kind]) {
    problems.push(`A ${VARIABLE_KIND_WORDS[kind].label.toLowerCase()} holds ${wants[kind] === 'enum' ? 'one of its options' : wants[kind]}, not ${field?.type}`);
    return problems;
  }
  if (field.type === 'number') {
    if (kind === 'counter' && !field.integer) problems.push('A counter counts in whole numbers');
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) problems.push(`Its least, ${field.min}, is more than its most, ${field.max}`);
  }
  if (field.type === 'enum' && !field.options?.length) problems.push('A choice has at least one option');
  if (field.type === 'enum' && new Set(field.options.map((option) => option.value)).size !== field.options.length) problems.push('A choice has each option once');
  if (field.default !== undefined) {
    const fits = checkValue(valueTypeOf(field), field.default);
    if (!fits.ok) problems.push(`What it starts as ${fits.problem}`);
    else if (kind === 'time' && (typeof field.default !== 'string' || !CLOCK_TIME.test(field.default))) problems.push(`"${String(field.default)}" is not a time of day: 07:00`);
  }
  return problems;
}

/** What a variable starts as, before anyone sets it: its default — or nothing, none, nought, its first option. */
export function variableStart(spec: VariableSpec): string | number | boolean | null {
  const { field } = spec;
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number') return spec.kind === 'counter' ? Math.max(0, field.min ?? 0) : (field.min ?? 0);
  if (field.type === 'enum') return field.options[0]?.value ?? null;
  return spec.kind === 'time' ? null : '';
}

/**
 * A counter counted from what it holds now: by one, by so many, or back to
 * its start — held to its range, so one at its most stays there. Null: it
 * counts by a whole number, and this is not one.
 */
export function counted(spec: VariableSpec, now: unknown, count: { by?: unknown; reset?: boolean } = {}): number | null {
  if (count.reset) {
    const start = variableStart(spec);
    return typeof start === 'number' ? start : 0;
  }
  const by = count.by === undefined ? 1 : count.by;
  if (typeof by !== 'number' || !Number.isInteger(by)) return null;
  const field = spec.field.type === 'number' ? spec.field : null;
  return Math.min(Math.max((typeof now === 'number' ? now : 0) + by, field?.min ?? Number.NEGATIVE_INFINITY), field?.max ?? Number.POSITIVE_INFINITY);
}

/**
 * A variable's key from its title, in camelCase: "Guests staying" is
 * `guestsStaying`, "Torktumlarens körningar" `torktumlarensKorningar` —
 * and, when `taken` says one is another's, 2, 3 after it.
 */
export function variableKeyFrom(title: string, taken: (key: string) => boolean): string {
  const words = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words.map((word, index) => (index ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())).join('');
  const base = (/^[a-z]/.test(joined) ? joined : joined ? `v${joined}` : 'variable').slice(0, 36);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
}

/** A variable as a person first says it: its title and kind — and, by its kind, a unit and range, or options. */
export type VariableTyped = { title: string; kind: VariableKind; unit?: Unit | null; min?: number | null; max?: number | null; options?: readonly string[] };

/**
 * The field a variable is declared with, from what a person typed: a
 * counter whole from nought, a number in its unit and range, a choice of
 * its options — each option's value its label in camelCase.
 */
export function variableFieldOf(typed: VariableTyped): ConfigField {
  const title = typed.title.trim();
  const range = { ...(typed.min !== undefined && typed.min !== null ? { min: typed.min } : {}), ...(typed.max !== undefined && typed.max !== null ? { max: typed.max } : {}) };
  switch (typed.kind) {
    case 'toggle':
      return { type: 'boolean', title };
    case 'number':
      return { type: 'number', title, ...(typed.unit ? { unit: typed.unit } : {}), ...range };
    case 'counter':
      return { type: 'number', title, integer: true, min: 0, ...range };
    case 'choice': {
      const labels = [...new Set((typed.options ?? []).map((option) => option.trim()).filter(Boolean))];
      const values = new Set<string>();
      return { type: 'enum', title, options: labels.map((label) => ({ value: variableKeyFrom(label, (key) => values.has(key)), label })).map((option) => (values.add(option.value), option)) };
    }
    case 'text':
      return { type: 'string', title };
    case 'time':
      return { type: 'string', title };
  }
}
