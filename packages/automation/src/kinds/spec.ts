import type { Weekday } from '../clock.ts';
import type { Expr } from '../rule.ts';

/*
  The language's constructs as data (docs/PLAN-AUTOMATION-LANGUAGE.md, phase
  A): each kind of trigger — and, after it, each step and expression — is one
  description: its fields, where each is kept and how a file writes it, what
  it holds, what the editor calls it, how it reads in a sentence, and its
  page in the reference. The checker, the file's reader and writer, the
  JSON Schema, the editor's blocks and the reference are made from these, so
  a new kind is one description, and a kind with a piece missing does not
  compile.
*/

/**
 * What one field holds — one vocabulary the checker, the file, the schema and
 * the editor share. Lengths of time are kept in seconds, whatever a file
 * writes ("2 min"); `min`, `max` and `step` are in seconds too.
 */
export type FieldType =
  /**
   * A condition: true or false, on what the parts filling its roles report.
   * `calls`: whether it may ask a package's function — not where it is looked
   * at on every reading, or every second.
   */
  | { type: 'condition'; calls?: boolean }
  /** A value of any kind a setting or a command takes: an expression. */
  | { type: 'value' }
  /** A time of day, "HH:MM", on the automation's clock. */
  | { type: 'timeOfDay' }
  /**
   * A length of time, in seconds. `fixed`: a number or a setting held to the
   * range — never a reading, so how long a run may take is known before it
   * runs.
   */
  | { type: 'duration'; min: number; max: number; step?: number; fixed?: boolean }
  /** How many times: a whole number from 1, a number or a setting held to the range — never a reading. */
  | { type: 'count'; max: number }
  /** Days of the week. */
  | { type: 'days' }
  /** A role a part of a device fills. */
  | { type: 'role' }
  /** A role another automation fills. */
  | { type: 'automation' }
  /** An event the part filling a role declares; `role`: the key of the field naming that role. */
  | { type: 'event'; role: string }
  /** A name the construct's own words check: a capability, a command, a setting's key or meaning. */
  | { type: 'name' }
  /** A name of its own, unique among its kind in the rule — letters and digits, from a lowercase letter: a trigger's, that `run.trigger` reads back. */
  | { type: 'id' }
  /** One of what the rule remembers, by its name: what a `remember` step sets. */
  | { type: 'memory' }
  /** A command's arguments: each its name and an expression. */
  | { type: 'args' }
  /**
   * Steps within the step: its branch. `sure`: whether they may wait for
   * what might not come — not in a retry, which would only fail again; else
   * as the list the step is in.
   */
  | { type: 'steps'; sure: 'inherit' | false; nonEmpty?: string };

export type FieldTypeName = FieldType['type'];

/** The kinds of field that hold one expression: what is settled, walked and read as one. */
export const EXPRESSION_FIELDS: ReadonlySet<FieldTypeName> = new Set(['condition', 'value', 'timeOfDay', 'duration', 'count']);

/** One field of a construct: where it is kept, how a file writes it, and what it holds. */
export type FieldSpec = {
  /** Where it is in the data, within the construct's own object: `['heldFor']`, `['event', 'role']`. */
  data: readonly string[];
  /** Its key in a file: `for`, `from`. */
  key: string;
  type: FieldType;
  /** Whether it must be there. */
  required: boolean;
  /** What the editor calls it, and the line under it. */
  label: string;
  help?: string;
};

/** A kind's page in the reference: what it is for, and how a file writes it. */
export type KindDocs = { summary: string; examples: readonly string[] };

/** The marks the editor draws a kind with: names in the app's icon set. */
export type KindIcon = 'clock' | 'repeat' | 'activity' | 'bell' | 'power' | 'sliders' | 'pause' | 'git-branch' | 'eye' | 'play-circle' | 'save';

/**
 * How a sentence says the parts of a construct — what the describer hands a
 * kind's `words`, so a kind says itself without knowing the devices.
 */
export type Say = {
  /** An expression, its settings filled in: "Garage station's charge is below 15 %". */
  expr(expr: Expr): string;
  /** A length of time: "2 min", "1 h 30 min" — or, when it is not written out, its expression. */
  duration(expr: Expr): string;
  /** A length of time in seconds, as its settings make it — null when a reading decides it: "for 0 s" is no hold, and unsaid. */
  seconds(expr: Expr): number | null;
  /** Days: "every day", "on weekdays", "on Mon and Fri". */
  days(days: readonly Weekday[] | undefined): string;
  /** What fills a role: "Garage station". */
  name(role: string): string;
  /** An event a role's part raises, in its own words: "mains lost". */
  event(role: string, event: string): string;
};

/** Reads a field of a construct's data by its path. */
export const fieldValue = (data: object, field: FieldSpec): unknown => field.data.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), data);

/** A construct's data with a field set — or, `undefined`, gone. A new object; the old one is untouched. */
export function withField<T extends object>(data: T, field: FieldSpec, value: unknown): T {
  const set = (at: Record<string, unknown>, path: readonly string[]): Record<string, unknown> => {
    const [key, ...rest] = path as [string, ...string[]];
    const next = { ...at };
    if (rest.length) next[key] = set((at[key] as Record<string, unknown> | undefined) ?? {}, rest);
    else if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  };
  return set(data as Record<string, unknown>, field.data) as T;
}
