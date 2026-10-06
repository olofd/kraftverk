import { convert, UNITS, type ConfigField, type ConfigSchema, type Unit } from '@kraftverk/device-sdk';

import { parseExpr } from './expr.ts';

/*
  A rule's settings as a configuration file writes them, under `settings:`
  (docs/CONFIG.md): each by its name, the value the rule runs with — the
  one an owner sets, or a recipe's copies start from — read in the rule as
  `setting.low`. Short when it is only a value:

    settings:
      low: 20 %
      lowFor: 2 min

  long when it says more — what the app calls it, its range, how it is set:

    settings:
      low:
        title: Start charging below
        value: 20 %
        min: 5 %
        max: 90 %
        step: 5 %
        slider: true

  A number keeps its unit (units.ts): a length of time is kept in seconds,
  whatever it is written in; anything else in the unit its value is written
  in, its range converted to it. One of some options lists them, each with
  its words: `options: { eco: Eco, boost: Boost }`.
*/

type Path = readonly (string | number)[];
type Fail = (message: string, path: Path) => never;

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data);

/** "lowFor" is "Low for", as the app calls a setting the file gives no title. */
const titleOf = (key: string): string => {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const SETTING_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LONG_KEYS = ['title', 'description', 'value', 'min', 'max', 'step', 'integer', 'slider', 'options'] as const;

/**
 * A number as written — "20 %", "2 min", 40 — with its unit, or null when it
 * is not one. A text that starts as a number is one: "20 parsecs" is a unit
 * kraftverk does not know, said where it is, never taken for a text.
 */
function numberOf(data: unknown, at: Path, fail: Fail): { value: number; unit: Unit | null } | null {
  if (typeof data === 'number') return { value: data, unit: null };
  if (typeof data !== 'string' || !/^\s*-?\d/.test(data)) return null;
  const parsed = parseExpr(data);
  if (!parsed.ok) return fail(parsed.error.message, at);
  const expr = parsed.expr;
  return 'value' in expr && typeof expr.value === 'number' ? { value: expr.value, unit: expr.unit ?? null } : fail('Expected a number with its unit: "20 %", "2 min"', at);
}

/** The settings of a rule, from a file's `settings:`. */
export function settingsFromConfig(data: unknown, path: Path, fail: Fail): ConfigSchema {
  if (data === undefined || data === null) return { fields: {} };
  if (!isRecord(data)) return fail('Expected each setting by its name: "low: 20 %"', path);
  const fields: Record<string, ConfigField> = {};
  for (const [key, given] of Object.entries(data)) {
    const at = [...path, key];
    if (!SETTING_KEY.test(key)) fail(`"${key}" is not a setting's name: letters, digits, _ and -`, at);
    fields[key] = isRecord(given) ? longSetting(key, given, at, fail) : shortSetting(key, given, at, fail);
  }
  return { fields };
}

/** "low: 20 %": a value alone, its title made from its name. */
function shortSetting(key: string, given: unknown, at: Path, fail: Fail): ConfigField {
  const title = titleOf(key);
  if (typeof given === 'boolean') return { type: 'boolean', title, default: given };
  const number = numberOf(given, at, fail);
  if (number) return numberField({ title, value: number }, at, fail);
  if (typeof given === 'string') return { type: 'string', title, default: given };
  return fail('Expected its value: a number with its unit, on or off, or a text', at);
}

function longSetting(key: string, given: Record<string, unknown>, at: Path, fail: Fail): ConfigField {
  for (const name of Object.keys(given)) if (!(LONG_KEYS as readonly string[]).includes(name)) fail(`"${name}" is not part of a setting: it takes ${LONG_KEYS.map((each) => `"${each}"`).join(', ')}`, [...at, name]);
  if (!('value' in given)) fail('Expected its value: "value: 20 %"', at);
  const title = typeof given.title === 'string' && given.title.trim() ? given.title.trim() : titleOf(key);
  const described = typeof given.description === 'string' && given.description.trim() ? { description: given.description.trim() } : {};
  if (isRecord(given.options)) {
    const options = Object.entries(given.options).map(([value, label]) => ({ value, label: typeof label === 'string' ? label : value }));
    if (typeof given.value !== 'string' || !options.some((option) => option.value === given.value)) fail(`Its value is one of its options: ${options.map((option) => option.value).join(', ')}`, [...at, 'value']);
    return { type: 'enum', title, ...described, options, default: given.value as string };
  }
  if (typeof given.value === 'boolean') return { type: 'boolean', title, ...described, default: given.value };
  const value = numberOf(given.value, [...at, 'value'], fail);
  if (!value) {
    if (typeof given.value === 'string') return { type: 'string', title, ...described, default: given.value };
    return fail('Expected its value: a number with its unit, on or off, or a text', [...at, 'value']);
  }
  const bound = (name: 'min' | 'max' | 'step') => {
    if (given[name] === undefined) return undefined;
    const number = numberOf(given[name], [...at, name], fail);
    if (!number) return fail(`Expected a number for "${name}"`, [...at, name]);
    return number;
  };
  return numberField(
    {
      title,
      ...described,
      value,
      min: bound('min'),
      max: bound('max'),
      step: bound('step'),
      integer: given.integer === true,
      slider: given.slider === true,
    },
    at,
    fail
  );
}

type Written = { value: number; unit: Unit | null };

/** A number setting in the unit it is kept in — seconds for a length of time, else its value's — its range converted to it. */
function numberField(
  given: { title: string; description?: string; value: Written; min?: Written; max?: Written; step?: Written; integer?: boolean; slider?: boolean },
  at: Path,
  fail: Fail
): ConfigField {
  const written = given.value.unit;
  const unit: Unit | null = written && UNITS[written].dimension === 'time' ? 's' : written;
  const inUnit = (number: Written | undefined, name: string): number | undefined => {
    if (!number) return undefined;
    if (!unit) return number.unit ? fail(`"${name}" says ${number.unit}, but its value says no unit`, [...at, name]) : number.value;
    const converted = convert(number.value, number.unit ?? unit, unit);
    return converted === null ? fail(`"${name}" is in ${number.unit}, not a unit of ${unit}`, [...at, name]) : converted;
  };
  const value = inUnit(given.value, 'value')!;
  const [min, max, step] = [inUnit(given.min, 'min'), inUnit(given.max, 'max'), inUnit(given.step, 'step')];
  return {
    type: 'number',
    title: given.title,
    ...(given.description ? { description: given.description } : {}),
    ...(unit ? { unit } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(given.integer ? { integer: true } : {}),
    ...(given.slider ? { presentation: 'slider' as const } : {}),
    default: value,
  };
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

/** A rule's settings as a file writes them: short where a value is all there is to say. */
export function settingsToConfig(schema: ConfigSchema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.fields).map(([key, field]) => {
      const value = field.type === 'number' && typeof field.default === 'number' ? numberText(field.default, field.unit) : field.default;
      const plain = field.title === titleOf(key) && !field.description && field.type !== 'enum' && field.type !== 'timestamp';
      if (field.type === 'number') {
        const more = { min: field.min, max: field.max, step: field.step, integer: field.integer, slider: field.presentation === 'slider' };
        if (plain && Object.values(more).every((each) => each === undefined || each === false)) return [key, value];
        return [
          key,
          {
            title: field.title,
            ...(field.description ? { description: field.description } : {}),
            value,
            ...(field.min !== undefined ? { min: numberText(field.min, field.unit) } : {}),
            ...(field.max !== undefined ? { max: numberText(field.max, field.unit) } : {}),
            ...(field.step !== undefined ? { step: numberText(field.step, field.unit) } : {}),
            ...(field.integer ? { integer: true } : {}),
            ...(field.presentation === 'slider' ? { slider: true } : {}),
          },
        ];
      }
      if (plain && value !== undefined) return [key, value];
      return [
        key,
        {
          title: field.title,
          ...(field.description ? { description: field.description } : {}),
          value,
          ...(field.type === 'enum' ? { options: Object.fromEntries(field.options.map((option) => [option.value, option.label])) } : {}),
        },
      ];
    })
  );
}
