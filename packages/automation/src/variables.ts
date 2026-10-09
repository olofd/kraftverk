import { CAMEL_NAME, checkValue, convert, isUnit, UNITS, valueTypeOf, type ConfigField, type Unit, type ValueType } from '@kraftverk/device-sdk';

import type { Expr } from './rule.ts';

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
  if (spec.key.length > 40) problems.push(`"${spec.key}": a variable's key is at most 40 characters`);
  // Only what a configuration file can say of one (text/variables.ts): a home carried in it comes back as it was.
  const extra = Object.keys(field).filter((name) => !['type', 'title', 'description', 'default', 'unit', 'min', 'max', 'step', 'integer', 'options'].includes(name));
  if (extra.length) problems.push(`A variable does not say ${extra.map((name) => `"${name}"`).join(', ')}`);
  if (field.type === 'number') {
    const range = [field.min, field.max, field.step, field.default].filter((each): each is number => typeof each === 'number');
    if (range.some((each) => !Number.isFinite(each) || Math.abs(each) >= 1e12)) problems.push('Its numbers are below a million million');
    if (kind === 'counter') {
      if (!field.integer) problems.push('A counter counts in whole numbers');
      if (field.unit) problems.push('A counter counts: it has no unit');
      if (range.some((each) => !Number.isInteger(each))) problems.push('A counter’s least, most and start are whole numbers');
    } else if (field.integer) problems.push('Only a counter is whole numbers alone');
    if (field.unit && UNITS[field.unit]?.dimension === 'time' && field.unit !== 's') problems.push('A length of time is kept in seconds');
    if (field.step !== undefined && !(field.step > 0)) problems.push('Its step is more than nought');
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) problems.push(`Its least, ${field.min}, is more than its most, ${field.max}`);
  }
  if (field.type === 'enum' && !field.options?.length) problems.push('A choice has at least one option');
  if (field.type === 'enum' && new Set(field.options.map((option) => option.value)).size !== field.options.length) problems.push('A choice has each option once');
  if (field.type === 'enum' && field.options.some((option) => !option.value || option.value.length > 40)) problems.push('Each option’s value is 1 to 40 characters');
  if (field.default !== undefined) {
    const fits = checkValue(valueTypeOf(field), field.default);
    if (!fits.ok) problems.push(`What it starts as ${fits.problem}`);
    else if (kind === 'time' && (typeof field.default !== 'string' || !CLOCK_TIME.test(field.default))) problems.push(`"${String(field.default)}" is not a time of day: 07:00`);
  }
  return problems;
}

/** What a variable starts as, before anyone sets it: its default — or nothing, none, its first option; nought, or the nearest its range allows. */
export function variableStart(spec: VariableSpec): string | number | boolean | null {
  const { field } = spec;
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number') return Math.min(Math.max(0, field.min ?? Number.NEGATIVE_INFINITY), field.max ?? Number.POSITIVE_INFINITY);
  if (field.type === 'enum') return field.options[0]?.value ?? null;
  return spec.kind === 'time' ? null : '';
}

/**
 * Whether what a variable holds still means the same once it is declared
 * anew: of the same kind, in the same unit, and fitting it — one that does
 * not goes back to what it starts as.
 */
export function stillHolds(before: Pick<VariableSpec, 'kind' | 'field'>, after: Pick<VariableSpec, 'kind' | 'field'>, value: unknown): boolean {
  if (before.kind !== after.kind || before.field.type !== after.field.type) return false;
  if (before.field.type === 'number' && after.field.type === 'number' && before.field.unit !== after.field.unit) return false;
  if (after.kind === 'time' && (typeof value !== 'string' || !CLOCK_TIME.test(value))) return false;
  return checkValue(valueTypeOf(after.field), value).ok;
}

/** What a variable holds, in words — its option's label, yes or no, a number in its unit — as a run's line and the timeline say it. */
export function variableValueText(spec: Pick<VariableSpec, 'field'>, value: unknown): string {
  const { field } = spec;
  if (value === null || value === undefined || value === '') return 'nothing';
  if (typeof value === 'boolean') return field.type === 'boolean' && field.words ? field.words[value ? 'true' : 'false'].toLowerCase() : value ? 'yes' : 'no';
  if (field.type === 'enum' && typeof value === 'string') return `“${field.options.find((option) => option.value === value)?.label ?? value}”`;
  if (typeof value === 'number' && field.type === 'number' && field.unit) return `${value} ${field.unit}`;
  return typeof value === 'string' && field.type === 'string' && !CLOCK_TIME.test(value) ? `“${value}”` : String(value);
}

/** What a variable is first given or compared with, as a value an editor starts from: what it starts as, in its unit — a time with none, seven in the morning. */
export function variableStartExpr(spec: VariableSpec): Expr {
  const start = variableStart(spec);
  if (spec.kind === 'time') return { value: typeof start === 'string' ? start : '07:00' };
  return spec.field.type === 'number' && spec.field.unit && isUnit(spec.field.unit) ? { value: start, unit: spec.field.unit } : { value: start };
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

/** What a person typed for a variable they made: what the form starts from when they change it. */
export function variableTypedOf(spec: VariableSpec): VariableTyped {
  const { field } = spec;
  return {
    title: field.title,
    kind: spec.kind,
    ...(field.type === 'number' ? { unit: field.unit ?? null, min: spec.kind === 'counter' && field.min === 0 ? null : (field.min ?? null), max: field.max ?? null } : {}),
    ...(field.type === 'enum' ? { options: field.options.map((option) => option.label) } : {}),
  };
}

/**
 * The field a variable is declared with, from what a person typed: a
 * counter whole from nought, a number in its unit and range, a choice of
 * its options — each new option's value its label in camelCase. Changing
 * one (`was`), what the form does not say is kept: its description, its
 * step, an option's value by its label — what automations name it by —
 * and what it starts as, while that still fits.
 */
export function variableFieldOf(typed: VariableTyped, was?: ConfigField): ConfigField {
  const title = typed.title.trim();
  // A length of time is kept in seconds, whatever it is said in: its range converted to them.
  const unit: Unit | null = typed.unit && typed.kind === 'number' ? (UNITS[typed.unit].dimension === 'time' ? 's' : typed.unit) : null;
  const inUnit = (value: number | null | undefined) => (value === undefined || value === null ? null : typed.unit && unit && typed.unit !== unit ? (convert(value, typed.unit, unit) ?? value) : value);
  const [min, max] = [inUnit(typed.min), inUnit(typed.max)];
  const range = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
  const described = was?.description ? { description: was.description } : {};
  const made = ((): ConfigField => {
    switch (typed.kind) {
      case 'toggle':
        return { type: 'boolean', title, ...described };
      case 'number':
        return { type: 'number', title, ...described, ...(unit ? { unit } : {}), ...range, ...(was?.type === 'number' && was.step !== undefined && was.unit === (unit ?? undefined) ? { step: was.step } : {}) };
      case 'counter':
        return { type: 'number', title, ...described, integer: true, min: 0, ...range };
      case 'choice': {
        const labels = [...new Set((typed.options ?? []).map((option) => option.trim()).filter(Boolean))];
        const kept = was?.type === 'enum' ? was.options : [];
        const values = new Set<string>(kept.filter((option) => labels.includes(option.label)).map((option) => option.value));
        const options = labels.map((label) => {
          const before = kept.find((option) => option.label === label);
          if (before) return before;
          const value = variableKeyFrom(label, (key) => values.has(key));
          values.add(value);
          return { value, label };
        });
        return { type: 'enum', title, ...described, options };
      }
      case 'text':
      case 'time':
        return { type: 'string', title, ...described };
    }
  })();
  // What it started as, kept where it still fits what it is now.
  const start = was?.default;
  const sameUnit = was?.type !== 'number' || made.type !== 'number' || was.unit === made.unit;
  return start !== undefined && was?.type === made.type && sameUnit && checkValue(valueTypeOf(made), start).ok ? ({ ...made, default: start } as ConfigField) : made;
}
