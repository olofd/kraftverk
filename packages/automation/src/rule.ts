import {
  capabilitySpec,
  isCapability,
  meetsNeed,
  type CapabilityId,
  type CapabilityName,
  type CapabilityNeed,
  type QueryAnswer,
  type QueryName,
} from '@kraftverk/device-sdk';
import { attributeMeaning, MAIN_PART, partsOf, type AttributeSpec, type DeviceDescription, type Reading } from '@kraftverk/device-sdk';
import type { QueryRequest } from '@kraftverk/device-sdk';
import type { SessionHealth } from '@kraftverk/device-sdk';
import { standardMeaning } from '@kraftverk/device-sdk';
import { valueTypeOf, type ConfigSchema } from '@kraftverk/device-sdk';
import { checkValue, enumLabel, isScalar, type ScalarValue, type Value, type ValueType } from '@kraftverk/device-sdk';

/**
 * Automations as data: the rule (docs/AUTOMATIONS.md).
 *
 * One small, typed language that a package's recipe, a person's editor, a DSL
 * and an AI all write, and one evaluator that runs it wherever it is held.
 * Its words are the device model's — capabilities, meanings, events,
 * commands — plus the functions packages contribute; it adds none of its own.
 * It can read, compare, and ask the gateway for commands: nothing else. So
 * whatever wrote a rule wrote data, and a rule can do no more than a person
 * could from a screen, after it has been seen watching and let act on purpose.
 *
 * Pure: no platform built-in, so a holder in the app can run it too.
 */

// --- the language -------------------------------------------------------------

export type CompareOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';

/** Something that has a value when a rule runs, or is unknown (null). */
export type Expr =
  | { value: Value }
  /** One of the rule's settings. */
  | { param: string }
  /** What the part filling a role reports now, by meaning: `battery.soc`, or a type's own `acme.minutesToFull`. */
  | { read: { role: string; means: string } }
  /** A function a package contributes, over the part filling a role. */
  | { call: string; role: string; args?: Readonly<Record<string, Expr>> }
  | { compare: CompareOp; left: Expr; right: Expr }
  /**
   * A number from two: their sum or difference, or the lower or higher of
   * them — in one unit, as a comparison is: "the charge limit, less 5 %",
   * "the lower of the forecast's hours and 4". Unknown when either is.
   */
  | { math: MathOp; left: Expr; right: Expr }
  | { all: readonly Expr[] }
  | { any: readonly Expr[] }
  | { not: Expr }
  /**
   * Whether the part filling a role can be reached now: its holder says it is
   * connected. Never unknown — not being reachable is the answer.
   */
  | { reachable: string }
  /**
   * Whether the owner's clock is between two times of day, "HH:MM": from
   * `from`, up to but not at `to` — across midnight when `to` comes first
   * ("22:00" to "06:00" is the night). Unknown where there is no clock: a
   * rule's settings alone cannot say what time it is.
   */
  | { within: { from: Expr; to: Expr } };

/** What `math` does with its two numbers. */
export type MathOp = 'add' | 'subtract' | 'min' | 'max';

export const MATH_OPS: readonly MathOp[] = ['add', 'subtract', 'min', 'max'];

/** Two numbers made one; unknown unless both are numbers. */
export const calculate = (op: MathOp, left: Value, right: Value): Value => {
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return op === 'add' ? left + right : op === 'subtract' ? left - right : op === 'min' ? Math.min(left, right) : Math.max(left, right);
};

/** How often an `every` trigger may run, in minutes: not more often than a look to keep things so, at least twice a day. */
export const EVERY_MINUTES = { min: 5, max: 720 } as const;

/** The start of the slot an `every` trigger is in at a minute of the day: every 15, at 07:40, is 07:30. */
export const slotOf = (minuteOfDay: number, every: number): number => Math.floor(minuteOfDay / every) * every;

/** A time of day as a rule writes it: "07:00", "22:30". */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes since midnight of a time of day, "HH:MM"; null for anything else. */
export const minutesOf = (time: Value): number | null => {
  if (typeof time !== 'string' || !CLOCK_TIME.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return hour! * 60 + minute!;
};

/** Whether a minute of the day is within a window of the day: from it, up to but not at its end — across midnight when the end comes first. */
export const inWindow = (minute: number, from: number, to: number): boolean => (from <= to ? minute >= from && minute < to : minute >= from || minute < to);

/** A day of the week, on the automation's own clock. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Monday first, as the owner's calendar has it. */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** The day of the week a date on the owner's calendar falls on. */
export const weekdayOf = (date: { year: number; month: number; day: number }): Weekday =>
  (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;

/** Whether a time-of-day trigger runs on this date: every day, or it is one of its days. */
export const runsOn = (trigger: Extract<Trigger, { at: unknown }>, date: { year: number; month: number; day: number }): boolean =>
  !trigger.days || trigger.days.includes(weekdayOf(date));

export type Trigger =
  /** At this time — "07:00" — on the automation's own clock: every day, or only on `days`. */
  | { at: Expr; days?: readonly Weekday[] }
  /**
   * Every so many minutes, on the owner's clock from midnight: every 15 is
   * :00, :15, :30 and :45. Once a slot; a server that was down runs once, at
   * the latest, and does not catch up. `if` narrows it: "every 15 minutes,
   * between 22:00 and 06:00".
   */
  | { every: Expr }
  /** When the part filling a role raises an event its description declares. */
  | { event: { role: string; event: string } }
  /**
   * When a condition turns true — and, with `heldForMinutes`, has stayed true
   * that long. Reads and comparisons only: it is evaluated on every reading.
   */
  | { becomes: Expr; heldForMinutes?: Expr };
// Any automation can be played by a person, or started by another: that is no trigger of its own (docs/AUTOMATION-EDITOR.md).

/** A capability command to the part filling a role. Only ever sent through the gateway. */
export type Command = { role: string; capability: CapabilityName; command: string; args: Readonly<Record<string, Expr>> };

/**
 * One step of what a rule does, in order (docs/SEQUENCES.md). A rule whose
 * steps are only commands does everything at once; one that waits takes as
 * long as its steps allow, and never longer: every wait has a limit, every
 * retry a count. Steps nest — a choice holds steps — to a few levels, so a
 * sequence still reads as a list a person can follow.
 */
export type Step =
  /** Through the gateway, as any command. */
  | { command: Command }
  /** A pause. */
  | { wait: { seconds: Expr } }
  /** Until a condition is true — or the run stops, not having succeeded, once it has waited that long. */
  | { waitUntil: { condition: Expr; atMostSeconds: Expr } }
  /**
   * Make sure a condition comes true within a time; if it does not, take the
   * `retry` steps and look again, at most `tries` times — then, still not, the
   * run stops, not having succeeded.
   */
  | { ensure: { condition: Expr; withinSeconds: Expr; tries: Expr; retry: readonly Step[] } }
  /** One way or the other, as a condition is now. Unknown is not true: `else`. */
  | { choose: { if: Expr; then: readonly Step[]; else?: readonly Step[] } }
  /**
   * Watch a condition for a while: `then` if it stays true all that time,
   * `else` the moment it is not — or cannot be told. "Watch whether the
   * station's AC output stays below 10 W for 5 s: then switch it off."
   */
  | { watch: { condition: Expr; seconds: Expr; then?: readonly Step[]; else?: readonly Step[] } }
  /**
   * Change a setting the part filling a role offers — "switch the plug's live
   * readings on" — through the gateway, read back as any setting. Never one
   * its device declares dangerous.
   */
  | { write: Write }
  /**
   * Start the automation filling a role, as a person's play would — and, with
   * `waitSeconds`, wait until its run ends: done if it acted, not if it did
   * not, or not within that time.
   */
  | { start: { role: string; waitSeconds?: Expr } };

/** The kinds of step: what a run records each as. */
export type StepKind = 'command' | 'wait' | 'waitUntil' | 'ensure' | 'choose' | 'watch' | 'write' | 'start';

export const stepKind = (step: Step): StepKind =>
  'command' in step
    ? 'command'
    : 'write' in step
      ? 'write'
      : 'start' in step
        ? 'start'
        : 'wait' in step
          ? 'wait'
          : 'waitUntil' in step
            ? 'waitUntil'
            : 'ensure' in step
              ? 'ensure'
              : 'choose' in step
                ? 'choose'
                : 'watch';

/** A role a part of a device fills: what it must offer, and what it is for. */
export type PartRole = CapabilityNeed & { label: string; description: string };

/** A role another automation fills: one a `start` step starts. */
export type AutomationRole = { automation: true; label: string; description: string };

/** What fills a role — a part, or an automation — and what it is for. */
export type RoleSpec = PartRole | AutomationRole;

export const isAutomationRole = (spec: RoleSpec): spec is AutomationRole => 'automation' in spec && spec.automation === true;

/** The roles parts of devices fill: what binding checks, and what a device's page lists. */
export const partRoles = (rule: Pick<Rule, 'roles'>): [string, PartRole][] =>
  Object.entries(rule.roles).filter((entry): entry is [string, PartRole] => !isAutomationRole(entry[1]));

export type Rule = {
  roles: Readonly<Record<string, RoleSpec>>;
  params: ConfigSchema;
  /** Any one of these starts a run. */
  when: readonly Trigger[];
  /** Must be true for it to act. Unknown is not true: nothing is done, and the run says why. */
  if?: Expr;
  /** What it does, step by step. */
  then: readonly Step[];
  /**
   * If a step does not succeed — or a person stops it — these, each tried
   * whatever the others do: switching back off what it switched on. No step
   * here waits for a condition to come true: it cannot fail in turn.
   */
  otherwise?: readonly Step[];
};

/** The limits every sequence is held to, whatever a rule asks: checked before it runs, and again as it does. */
export const SEQUENCE_LIMITS = {
  /** The longest pause, watch, or wait for a condition: an hour. */
  waitSeconds: 3_600,
  /** The longest one try of `ensure` is given: ten minutes. */
  trySeconds: 600,
  /** At most this many tries. */
  tries: 10,
  /** Steps within steps, at most this deep: a sequence stays a list a person can follow. */
  depth: 4,
} as const;

/**
 * A rule with its roles and settings left open, shipped by a package: filling
 * it in makes an automation. Namespaced by the type: `acme.weather.forecast-switch`.
 */
export type Recipe = Rule & {
  id: string;
  label: string;
  description: string;
  /**
   * How an automation made from it reads, with `{role}` and `{param}` filled
   * in: "At {at}, if {day} looks {condition} by {forecast}, turn {switch} {action}."
   * Without one, a sentence is made from the rule.
   */
  sentence?: string;
};

/** A value, and in words why it is what it is. */
export type Evaluation = { value: Value; detail: string | null };

/**
 * A device as a function may see it: what it reports, how it is doing, and
 * its queries answered — each answer checked against the type its capability
 * declares. Nothing that acts: a function answers, it never commands, writes
 * or runs a tool, and it is not handed anything that could.
 */
export type DeviceReader = {
  readings(): readonly Reading[];
  health(): SessionHealth;
  query(request: QueryRequest): Promise<Value>;
};

/** The part filling a role, as a function sees it. */
export type RulePart = {
  /** "Heater plug", or "Garage station — AC outlets". */
  name: string;
  part: string;
  /** Null when there is nothing to ask: it is offline, or held by an app. */
  device: DeviceReader | null;
  /** Why it cannot answer, when it cannot. */
  offline: string;
};

/**
 * Asks the part filling a role one of a library capability's queries, and
 * answers in the type the capability declares — checked by the reader, so a function reads
 * a forecast as a forecast, with no cast. Throws, saying why, when the part
 * cannot answer or answers something else.
 */
export async function ask<Name extends CapabilityName, Query extends QueryName<Name>>(
  part: RulePart,
  capability: Name,
  query: Query,
  args: Readonly<Record<string, Value>>
): Promise<QueryAnswer<Name, Query>> {
  if (!part.device) throw new Error(`${part.name} is not answering: ${part.offline}`);
  // The reader checks the answer against the declaration the type is derived from: once, there.
  return (await part.device.query({ part: part.part, capability, query, args })) as QueryAnswer<Name, Query>;
}

export type FunctionContext = {
  part: RulePart;
  args: Readonly<Record<string, Value>>;
  now: Date;
  /** The automation's clock: "Europe/Stockholm". */
  timeZone: string;
};

/**
 * A computation a package contributes, for what comparing readings cannot
 * say: whether tomorrow looks sunny. Generic over the capability it needs, not
 * over the package's own device — any part that offers it will do. The only
 * place an automation runs a package's code; it answers, it never acts.
 */
export type AutomationFunction = {
  /** Namespaced by the type: `acme.weather.skyLooks`. */
  id: string;
  label: string;
  description: string;
  /** What the part it is asked about must offer. */
  needs: CapabilityNeed;
  args: Readonly<Record<string, ValueType>>;
  returns: ValueType;
  /** Its answer, or null when it cannot tell — with why, either way. */
  evaluate(ctx: FunctionContext): Promise<Evaluation>;
};

export const defineRecipe = (recipe: Recipe): Recipe => recipe;
export const defineFunction = (fn: AutomationFunction): AutomationFunction => fn;

// --- checking a rule --------------------------------------------------------------

/**
 * What an expression is, as far as can be known before it runs. A list or an
 * object is `structure`: a rule can hand one to a function, never compare it —
 * reading into structure is what functions are for.
 */
type Shape = { type: 'number'; unit: string | null } | { type: 'boolean' } | { type: 'string'; options: readonly string[] | null } | { type: 'structure' } | { type: 'unknown' };

const shapeOf = (type: ValueType): Shape => {
  switch (type.type) {
    case 'number':
      return { type: 'number', unit: type.unit ?? null };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', options: type.options.map((option) => option.value) };
    case 'string':
    case 'timestamp':
      return { type: 'string', options: null };
    case 'list':
    case 'object':
      return { type: 'structure' };
  }
};

const shapeOfValue = (value: Value): Shape =>
  value === null
    ? { type: 'unknown' }
    : typeof value === 'number'
      ? { type: 'number', unit: null }
      : typeof value === 'boolean'
        ? { type: 'boolean' }
        : typeof value === 'string'
          ? { type: 'string', options: null }
          : { type: 'structure' };

const said = (shape: Shape): string =>
  shape.type === 'number' && shape.unit ? `a number in ${shape.unit}` : shape.type === 'number' ? 'a number' : shape.type === 'structure' ? 'a list or an object' : `a ${shape.type}`;

/** Whether a value of shape `given` may stand where `wanted` is expected. */
function fits(wanted: Shape, given: Shape): boolean {
  if (wanted.type === 'unknown' || given.type === 'unknown') return true;
  if (wanted.type !== given.type) return false;
  if (wanted.type === 'number' && given.type === 'number') return !wanted.unit || !given.unit || wanted.unit === given.unit;
  return true;
}

/**
 * Which setting a `write` changes: by its key, for a rule its owner built on
 * their own devices — or by a standard meaning ("battery.chargeLimit"), which
 * a recipe can name without knowing any product.
 */
export type WriteTarget = { key: string; means?: never } | { means: string; key?: never };

/** A `write` step: the part's setting, and its value. */
export type Write = { role: string; value: Expr } & WriteTarget;

export type RuleVocabulary = {
  /** The installed function with this id, or null. */
  fn(id: string): AutomationFunction | null;
  /**
   * The setting a `write` changes on the part filling a role, once the role
   * is filled: what its words say ("Live readings") and how its value reads.
   * Absent, or not known, and the setting is named by its key.
   */
  attribute?(role: string, target: WriteTarget): AttributeSpec | null;
};

/** The standard meanings a part offering these capabilities reports. */
const meaningsOfNeed = (need: CapabilityNeed): Set<string> =>
  new Set([...need.capabilities, ...(need.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.values(capabilitySpec(name).attributes).map((attribute) => attribute.means) : [])));

/**
 * Everything wrong with a rule, each with where it is: "then[0].command.args.on:
 * expected a boolean, got a number". Empty when it can run. Checks it against
 * the capability library and the installed functions — not against devices:
 * `checkBinding` does that once its roles are filled.
 */
export function checkRule(rule: Rule, vocabulary: RuleVocabulary): string[] {
  const problems: string[] = [];
  const roles = rule.roles ?? {};
  const params = rule.params?.fields ?? {};

  for (const [role, spec] of Object.entries(roles)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(role)) problems.push(`roles.${role}: a role is named in camelCase`);
    if (!spec.label?.trim()) problems.push(`roles.${role}: it has no label`);
    if (isAutomationRole(spec)) continue;
    const named = [...(spec.capabilities ?? []), ...(spec.oneOf ?? [])];
    if (!named.length) problems.push(`roles.${role}: it asks for no capability, so any device would do`);
    for (const capability of named) if (!isCapability(capability)) problems.push(`roles.${role}: there is no capability "${capability}"`);
  }

  /** A role a part fills: what is read, asked, switched or written. */
  const role = (name: string, where: string): PartRole | null => {
    const spec = roles[name];
    // A block whose part is still to choose, as an editor makes one: said as that.
    if (!name) problems.push(`${where}: choose a part`);
    else if (!spec) problems.push(`${where}: there is no role "${name}"`);
    else if (isAutomationRole(spec)) problems.push(`${where}: ${name} is an automation, not a part of a device`);
    return spec && !isAutomationRole(spec) ? spec : null;
  };

  const shape = (expr: Expr, where: string, options: { calls: boolean }): Shape => {
    if ('value' in expr) return shapeOfValue(expr.value);
    if ('param' in expr) {
      const field = params[expr.param];
      if (!field) {
        problems.push(`${where}: there is no setting "${expr.param}"`);
        return { type: 'unknown' };
      }
      return shapeOf(valueTypeOf(field));
    }
    if ('read' in expr) {
      const spec = role(expr.read.role, where);
      if (!expr.read.means) {
        if (expr.read.role) problems.push(`${where}: choose what it reports`);
        return { type: 'unknown' };
      }
      const standard = standardMeaning(expr.read.means);
      if (!standard) return { type: 'unknown' }; // a type's own meaning: checked when bound
      if (spec && !meaningsOfNeed(spec).has(expr.read.means)) {
        problems.push(`${where}: ${expr.read.role} asks for nothing that reports ${expr.read.means}`);
      }
      // One in any of several units — a price, in its provider's currency — is compared in its own, known once bound.
      return standard.type === 'boolean' ? { type: 'boolean' } : { type: 'number', unit: standard.units ? null : standard.unit || null };
    }
    if ('call' in expr) {
      if (!options.calls) problems.push(`${where}: "becomes" is evaluated on every reading, so it cannot call ${expr.call}`);
      const fn = vocabulary.fn(expr.call);
      const spec = role(expr.role, where);
      if (!fn) {
        problems.push(`${where}: there is no function "${expr.call}" installed`);
        return { type: 'unknown' };
      }
      if (spec && !meetsNeed(fn.needs, [...spec.capabilities, ...(spec.oneOf ?? [])].filter(isCapability))) {
        problems.push(`${where}: ${fn.label} needs a part that offers ${[...fn.needs.capabilities, ...(fn.needs.oneOf ?? [])].join(', ')}, and ${expr.role} does not ask for that`);
      }
      const given = expr.args ?? {};
      for (const [name, type] of Object.entries(fn.args)) {
        const arg = given[name];
        if (!arg) problems.push(`${where}.args.${name}: ${fn.label} needs it`);
        else {
          const got = shape(arg, `${where}.args.${name}`, options);
          if (!fits(shapeOf(type), got)) problems.push(`${where}.args.${name}: expected ${said(shapeOf(type))}, got ${said(got)}`);
          else literalFits(arg, type, `${where}.args.${name}`);
        }
      }
      for (const name of Object.keys(given)) if (!(name in fn.args)) problems.push(`${where}.args.${name}: ${fn.label} takes no "${name}"`);
      return shapeOf(fn.returns);
    }
    if ('reachable' in expr) {
      role(expr.reachable, where);
      return { type: 'boolean' };
    }
    if ('math' in expr) {
      if (!MATH_OPS.includes(expr.math)) problems.push(`${where}: "${expr.math}" is not add, subtract, min or max`);
      const left = shape(expr.left, `${where}.left`, options);
      const right = shape(expr.right, `${where}.right`, options);
      for (const [side, got] of [['left', left], ['right', right]] as const) {
        if (!fits({ type: 'number', unit: null }, got)) problems.push(`${where}.${side}: expected a number, got ${said(got)}`);
      }
      const units = [left, right].flatMap((side) => (side.type === 'number' && side.unit ? [side.unit] : []));
      if (new Set(units).size > 1) problems.push(`${where}: ${units[0]} and ${units[1]} are not one unit`);
      return { type: 'number', unit: units[0] ?? null };
    }
    if ('within' in expr) {
      const ends = [
        ['from', expr.within?.from],
        ['to', expr.within?.to],
      ] as const;
      for (const [end, given] of ends) {
        if (!given) {
          problems.push(`${where}.within.${end}: a time of day is "HH:MM"`);
          continue;
        }
        const got = shape(given, `${where}.within.${end}`, options);
        if (!fits({ type: 'string', options: null }, got)) problems.push(`${where}.within.${end}: expected a time of day, got ${said(got)}`);
        else if ('value' in given && minutesOf(given.value) === null) problems.push(`${where}.within.${end}: a time of day is "HH:MM"`);
      }
      const [from, to] = [expr.within?.from, expr.within?.to];
      if (from && to && 'value' in from && 'value' in to && minutesOf(from.value) !== null && from.value === to.value) problems.push(`${where}.within: from ${String(from.value)} to the same time is no window`);
      return { type: 'boolean' };
    }
    if ('compare' in expr) {
      if (!['lt', 'le', 'gt', 'ge', 'eq', 'ne'].includes(expr.compare)) problems.push(`${where}: "${expr.compare}" is not a comparison`);
      const left = shape(expr.left, `${where}.left`, options);
      const right = shape(expr.right, `${where}.right`, options);
      if (!fits(left, right)) problems.push(`${where}: compares ${said(left)} with ${said(right)}`);
      const ordered = ['lt', 'le', 'gt', 'ge'].includes(expr.compare);
      if (ordered && [left, right].some((side) => side.type === 'boolean' || side.type === 'string')) problems.push(`${where}: only numbers are above or below each other`);
      if ([left, right].some((side) => side.type === 'structure')) problems.push(`${where}: a list or an object is read by a function, not compared`);
      // An option the other side can never be is a mistake, not a condition.
      for (const [side, other] of [[left, expr.right], [right, expr.left]] as const) {
        if (side.type === 'string' && side.options && 'value' in other && typeof other.value === 'string' && !side.options.includes(other.value)) {
          problems.push(`${where}: "${other.value}" is not one of ${side.options.join(', ')}`);
        }
      }
      return { type: 'boolean' };
    }
    const parts = 'all' in expr ? expr.all : 'any' in expr ? expr.any : 'not' in expr ? [expr.not] : null;
    if (!parts) {
      problems.push(`${where}: not an expression`);
      return { type: 'unknown' };
    }
    parts.forEach((part, index) => {
      const got = shape(part, 'not' in expr ? `${where}.not` : `${where}.${'all' in expr ? 'all' : 'any'}[${index}]`, options);
      if (!fits({ type: 'boolean' }, got)) problems.push(`${where}: expected conditions, got ${said(got)}`);
    });
    return { type: 'boolean' };
  };

  /** A literal where a typed value is expected is held to its range and options too. */
  const literalFits = (expr: Expr, type: ValueType, where: string) => {
    if (!('value' in expr) || expr.value === null) return;
    if (type.type === 'enum' && !type.options.some((option) => option.value === expr.value)) problems.push(`${where}: "${String(expr.value)}" is not one of ${type.options.map((option) => option.value).join(', ')}`);
    if (type.type === 'number' && typeof expr.value === 'number' && ((type.min !== undefined && expr.value < type.min) || (type.max !== undefined && expr.value > type.max))) {
      problems.push(`${where}: ${expr.value} is out of range`);
    }
  };

  // No trigger is allowed: it runs when played, or started by another automation.
  (rule.when ?? []).forEach((trigger, index) => {
    const where = `when[${index}]`;
    if ('at' in trigger) {
      const got = shape(trigger.at, `${where}.at`, { calls: false });
      if (!fits({ type: 'string', options: null }, got)) problems.push(`${where}.at: expected a time of day, got ${said(got)}`);
      if ('value' in trigger.at && (typeof trigger.at.value !== 'string' || !CLOCK_TIME.test(trigger.at.value))) problems.push(`${where}.at: a time of day is "HH:MM"`);
      if (trigger.days !== undefined) {
        if (!trigger.days.length) problems.push(`${where}.days: on no day, it never runs`);
        for (const day of trigger.days) if (!WEEKDAYS.includes(day)) problems.push(`${where}.days: "${String(day)}" is not a day of the week`);
        if (new Set(trigger.days).size !== trigger.days.length) problems.push(`${where}.days: a day is named twice`);
      }
    } else if ('every' in trigger) {
      const got = shape(trigger.every, `${where}.every`, { calls: false });
      if (!fits({ type: 'number', unit: 'min' }, got)) problems.push(`${where}.every: expected a number of minutes, got ${said(got)}`);
      const minutes = 'value' in trigger.every ? trigger.every.value : null;
      if (typeof minutes === 'number' && (!Number.isInteger(minutes) || minutes < EVERY_MINUTES.min || minutes > EVERY_MINUTES.max)) {
        problems.push(`${where}.every: whole minutes, from ${EVERY_MINUTES.min} to ${EVERY_MINUTES.max}`);
      }
    } else if ('event' in trigger) {
      role(trigger.event.role, `${where}.event`);
      if (!trigger.event.event?.trim()) problems.push(`${where}.event: which event?`);
    } else if ('becomes' in trigger) {
      const got = shape(trigger.becomes, `${where}.becomes`, { calls: false });
      if (!fits({ type: 'boolean' }, got)) problems.push(`${where}.becomes: expected a condition, got ${said(got)}`);
      if (trigger.heldForMinutes) {
        const held = shape(trigger.heldForMinutes, `${where}.heldForMinutes`, { calls: false });
        if (!fits({ type: 'number', unit: null }, held)) problems.push(`${where}.heldForMinutes: expected a number of minutes, got ${said(held)}`);
      }
    } else problems.push(`${where}: not a trigger`);
  });

  if (rule.if) {
    const got = shape(rule.if, 'if', { calls: true });
    if (!fits({ type: 'boolean' }, got)) problems.push(`if: expected a condition, got ${said(got)}`);
  }

  /** A condition a step waits for: looked at on every reading while it waits, so reads and comparisons only. */
  const condition = (expr: Expr, where: string, calls: boolean) => {
    const got = shape(expr, where, { calls });
    if (!fits({ type: 'boolean' }, got)) problems.push(`${where}: expected a condition, got ${said(got)}`);
  };

  /**
   * A number a step counts by — seconds, tries — held to its limit: a literal
   * at once; a setting by its own range, so no value its form accepts can
   * exceed it.
   */
  const bounded = (expr: Expr, where: string, unit: 's' | null, max: number, what: string) => {
    const got = shape(expr, where, { calls: false });
    if (!fits({ type: 'number', unit }, got)) {
      problems.push(`${where}: expected ${unit ? 'a number of seconds' : 'a number'}, got ${said(got)}`);
      return;
    }
    if ('value' in expr && typeof expr.value === 'number' && !(expr.value >= 1 && expr.value <= max)) problems.push(`${where}: ${what} between 1 and ${max}`);
    if ('param' in expr) {
      const field = params[expr.param];
      if (field?.type === 'number' && (field.max === undefined || field.max > max || field.min === undefined || field.min < 1)) {
        problems.push(`${where}: the setting "${expr.param}" must be held to ${what} between 1 and ${max}`);
      }
    }
    if (!('value' in expr) && !('param' in expr)) problems.push(`${where}: ${what} is a number or a setting`);
  };

  /**
   * Steps, in order. `sure`: where a step may fail the run — waiting for a
   * condition that never comes. Not in a retry, which is itself being tried,
   * nor in `otherwise`, which runs because something already did not succeed.
   */
  const steps = (list: readonly Step[], where: string, sure: boolean, depth: number) => {
    if (list.length && depth > SEQUENCE_LIMITS.depth) problems.push(`${where}: steps within steps, more than ${SEQUENCE_LIMITS.depth} deep`);
    list.forEach((step, index) => {
      const at = `${where}[${index}]`;
      if ('command' in step) command(step.command, `${at}.command`);
      else if ('write' in step) {
        // Which setting, and whether the value fits it, is the bound part's to say (`checkBinding`).
        role(step.write.role, `${at}.write`);
        const { key, means } = step.write as { key?: unknown; means?: unknown };
        if (key !== undefined && means !== undefined) problems.push(`${at}.write: a setting by its key or by its meaning, not both`);
        else if (means !== undefined) {
          if (typeof means !== 'string' || !standardMeaning(means)) problems.push(`${at}.write.means: "${String(means)}" is not a standard meaning`);
        } else if (typeof key !== 'string' || !key.trim()) problems.push(`${at}.write.key: which setting?`);
        const got = shape(step.write.value, `${at}.write.value`, { calls: true });
        if (got.type === 'structure') problems.push(`${at}.write.value: a setting is set to a value, not a list or an object`);
      } else if ('start' in step) {
        const spec = roles[step.start.role];
        if (!step.start.role) problems.push(`${at}.start: choose an automation`);
        else if (!spec) problems.push(`${at}.start: there is no role "${step.start.role}"`);
        else if (!isAutomationRole(spec)) problems.push(`${at}.start: ${step.start.role} is a part of a device, not an automation`);
        if (step.start.waitSeconds !== undefined) {
          if (!sure) problems.push(`${at}.start: nothing here may wait for what might not come: it is started, not waited for`);
          bounded(step.start.waitSeconds, `${at}.start.waitSeconds`, 's', SEQUENCE_LIMITS.waitSeconds, 'a wait of');
        }
      } else if ('wait' in step) bounded(step.wait.seconds, `${at}.wait.seconds`, 's', SEQUENCE_LIMITS.waitSeconds, 'a pause of');
      else if ('choose' in step) {
        condition(step.choose.if, `${at}.choose.if`, true);
        if (!step.choose.then?.length && !step.choose.else?.length) problems.push(`${at}.choose: it does nothing either way`);
        steps(step.choose.then ?? [], `${at}.choose.then`, sure, depth + 1);
        steps(step.choose.else ?? [], `${at}.choose.else`, sure, depth + 1);
      } else if ('watch' in step) {
        condition(step.watch.condition, `${at}.watch.condition`, false);
        bounded(step.watch.seconds, `${at}.watch.seconds`, 's', SEQUENCE_LIMITS.waitSeconds, 'a watch of');
        if (!step.watch.then?.length && !step.watch.else?.length) problems.push(`${at}.watch: it does nothing either way`);
        steps(step.watch.then ?? [], `${at}.watch.then`, sure, depth + 1);
        steps(step.watch.else ?? [], `${at}.watch.else`, sure, depth + 1);
      } else if ('waitUntil' in step || 'ensure' in step) {
        if (!sure) problems.push(`${at}: nothing here may wait for a condition that might not come: it would fail again`);
        if ('waitUntil' in step) {
          condition(step.waitUntil.condition, `${at}.waitUntil.condition`, false);
          bounded(step.waitUntil.atMostSeconds, `${at}.waitUntil.atMostSeconds`, 's', SEQUENCE_LIMITS.waitSeconds, 'a wait of');
        } else {
          condition(step.ensure.condition, `${at}.ensure.condition`, false);
          bounded(step.ensure.withinSeconds, `${at}.ensure.withinSeconds`, 's', SEQUENCE_LIMITS.trySeconds, 'a try of');
          bounded(step.ensure.tries, `${at}.ensure.tries`, null, SEQUENCE_LIMITS.tries, 'tries');
          if (!step.ensure.retry?.length) problems.push(`${at}.ensure.retry: how is it tried again?`);
          steps(step.ensure.retry ?? [], `${at}.ensure.retry`, false, depth + 1);
        }
      } else problems.push(`${at}: not a step`);
    });
  };

  if (!rule.then?.length) problems.push('then: it does nothing');
  steps(rule.then ?? [], 'then', true, 1);
  steps(rule.otherwise ?? [], 'otherwise', false, 1);

  return problems;

  function command(command: Command, where: string): void {
    const spec = role(command.role, where);
    if (!isCapability(command.capability)) {
      problems.push(`${where}: there is no capability "${command.capability}"`);
      return;
    }
    if (spec && ![...spec.capabilities, ...(spec.oneOf ?? [])].includes(command.capability)) problems.push(`${where}: ${command.role} does not ask for ${command.capability}`);
    const declared = capabilitySpec(command.capability).commands[command.command];
    if (!declared) {
      problems.push(`${where}: ${command.capability} takes no command "${command.command}"`);
      return;
    }
    for (const [name, type] of Object.entries(declared.args)) {
      const arg = command.args?.[name];
      if (!arg) problems.push(`${where}.args.${name}: ${command.capability}.${command.command} needs it`);
      else {
        const got = shape(arg, `${where}.args.${name}`, { calls: true });
        if (!fits(shapeOf(type), got)) problems.push(`${where}.args.${name}: expected ${said(shapeOf(type))}, got ${said(got)}`);
        else literalFits(arg, type, `${where}.args.${name}`);
      }
    }
    for (const name of Object.keys(command.args ?? {})) if (!(name in declared.args)) problems.push(`${where}.args.${name}: ${command.capability}.${command.command} takes no "${name}"`);
  }
}

/**
 * A problem `checkRule` found, said where a person finds it: "then[3].ensure.retry[1].wait.seconds: …"
 * becomes "Step 4, each time, step 2: …"; "when[0].days: …" "Trigger 1: …"; "if: …" "Only if: …"; a role by
 * its label. What follows the step is the problem's own words, and stays.
 */
export function problemPlace(problem: string, rule: Pick<Rule, 'roles'>): string {
  const colon = problem.indexOf(': ');
  if (colon < 0) return problem;
  const path = problem.slice(0, colon);
  const said = problem.slice(colon + 2);
  const role = /^roles\.([A-Za-z0-9]+)/.exec(path);
  if (role) return `${rule.roles[role[1]!]?.label ?? role[1]}: ${said}`;
  const trigger = /^when\[(\d+)\]/.exec(path);
  if (trigger) return `Trigger ${Number(trigger[1]) + 1}: ${said}`;
  if (/^if\b/.test(path)) return `Only if: ${said}`;
  const root = /^(then|otherwise)(?:\[(\d+)\])?/.exec(path);
  if (!root) return problem;
  if (root[2] === undefined) return root[1] === 'then' ? `What it does: ${said}` : `If a step does not succeed: ${said}`;
  const places = [`${root[1] === 'then' ? 'Step' : 'If a step does not succeed, step'} ${Number(root[2]) + 1}`];
  const WITHIN: Readonly<Record<string, string>> = { 'ensure.retry': 'each time', 'choose.then': 'then', 'choose.else': 'otherwise', 'watch.then': 'if it stays so', 'watch.else': 'if not' };
  for (const step of path.slice(root[0].length).matchAll(/\.(ensure\.retry|choose\.then|choose\.else|watch\.then|watch\.else)\[(\d+)\]/g)) {
    places.push(`${WITHIN[step[1]!]}, step ${Number(step[2]) + 1}`);
  }
  return `${places.join(', ')}: ${said}`;
}

/** The events a role's capabilities declare: what a trigger on it can wait for before it is bound. */
export const roleEvents = (spec: CapabilityNeed): string[] =>
  [...new Set([...spec.capabilities, ...(spec.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.keys(capabilitySpec(name).events ?? {}) : [])))];

/**
 * What a rule reads, the events it waits for, the functions it calls, the
 * settings it writes and the automations it starts: what running it,
 * rehearsing it on history, or binding it, needs.
 */
export function ruleUses(rule: Rule): {
  reads: { role: string; means: string }[];
  events: { role: string; event: string }[];
  calls: { fn: string; role: string }[];
  /** The roles whose reachability it asks about: what a device's health moving can change. */
  reaches: string[];
  /** The settings it changes: each checked against the part that fills its role. */
  writes: Write[];
  /** The roles of the automations it starts. */
  starts: string[];
  /** The windows of the day it looks at: when each opens and closes, something may turn true. */
  windows: { from: Expr; to: Expr }[];
} {
  const reads: { role: string; means: string }[] = [];
  const calls: { fn: string; role: string }[] = [];
  const reaches: string[] = [];
  const writes: Write[] = [];
  const windows: { from: Expr; to: Expr }[] = [];
  const starts: string[] = [];
  const walk = (expr: Expr | undefined): void => {
    if (!expr) return;
    if ('read' in expr) reads.push(expr.read);
    else if ('reachable' in expr) reaches.push(expr.reachable);
    else if ('within' in expr) (windows.push(expr.within), walk(expr.within.from), walk(expr.within.to));
    else if ('call' in expr) (calls.push({ fn: expr.call, role: expr.role }), Object.values(expr.args ?? {}).forEach(walk));
    else if ('compare' in expr || 'math' in expr) (walk(expr.left), walk(expr.right));
    else if ('all' in expr) expr.all.forEach(walk);
    else if ('any' in expr) expr.any.forEach(walk);
    else if ('not' in expr) walk(expr.not);
  };
  const walkSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('command' in step) Object.values(step.command.args).forEach(walk);
      else if ('write' in step) (writes.push(step.write), walk(step.write.value));
      else if ('start' in step) (starts.push(step.start.role), walk(step.start.waitSeconds));
      else if ('wait' in step) walk(step.wait.seconds);
      else if ('waitUntil' in step) (walk(step.waitUntil.condition), walk(step.waitUntil.atMostSeconds));
      else if ('ensure' in step) (walk(step.ensure.condition), walk(step.ensure.withinSeconds), walk(step.ensure.tries), walkSteps(step.ensure.retry));
      else if ('choose' in step) (walk(step.choose.if), walkSteps(step.choose.then), walkSteps(step.choose.else ?? []));
      else (walk(step.watch.condition), walk(step.watch.seconds), walkSteps(step.watch.then ?? []), walkSteps(step.watch.else ?? []));
    }
  };
  const events: { role: string; event: string }[] = [];
  for (const trigger of rule.when) {
    if ('at' in trigger) walk(trigger.at);
    if ('every' in trigger) walk(trigger.every);
    else if ('event' in trigger) events.push(trigger.event);
    else if ('becomes' in trigger) (walk(trigger.becomes), walk(trigger.heldForMinutes));
  }
  walk(rule.if);
  walkSteps(rule.then);
  walkSteps(rule.otherwise ?? []);
  return { reads, events, calls, reaches: [...new Set(reaches)], writes, starts: [...new Set(starts)], windows };
}

/** Every command a rule may send, in its steps, retries and `otherwise`: what its roles must be able to take. */
export function ruleCommands(rule: Rule): Command[] {
  const found: Command[] = [];
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      if ('command' in step) found.push(step.command);
      else if ('ensure' in step) walk(step.ensure.retry);
      else if ('choose' in step) (walk(step.choose.then), walk(step.choose.else ?? []));
      else if ('watch' in step) (walk(step.watch.then ?? []), walk(step.watch.else ?? []));
    }
  };
  walk(rule.then);
  walk(rule.otherwise ?? []);
  return found;
}

/**
 * The roles whose parts a rule may change — every part a command or a
 * setting names, whichever way it goes: what a run of it holds while it runs,
 * and what it shares with another automation (docs/SHARED-PARTS-AND-RESERVE.md).
 */
export const changedRoles = (rule: Rule): string[] => [...new Set([...ruleCommands(rule).map((command) => command.role), ...ruleUses(rule).writes.map((write) => write.role)])];

/**
 * Whether a rule takes steps — waits, choices, another automation, a
 * fallback — rather than sending its commands and settings at once.
 */
export const takesSteps = (rule: Rule): boolean => rule.then.some((step) => !('command' in step) && !('write' in step)) || Boolean(rule.otherwise?.length);

/** Whether a rule waits for a condition to come true. */
export const hasConditions = (rule: Rule): boolean => rule.when.some((trigger) => 'becomes' in trigger);

/**
 * Whether an automation can keep things so (`recheckMinutes`): it waits for
 * a condition, and does what it does at once — so looking again and putting
 * back what was switched against it is the same as running it.
 */
export const keepsSo = (rule: Rule): boolean => hasConditions(rule) && !takesSteps(rule);

/** The part filling a role, as a binding check sees it. */
export type BoundPart = {
  name: string;
  description: DeviceDescription;
  part: string;
  capabilities: readonly CapabilityId[];
};

/**
 * Everything wrong with a rule's roles as they are filled: a part that does
 * not offer what its role needs, reports no meaning the rule reads, or never
 * raises an event the rule waits for. Empty when it can run as it is.
 */
export function checkBinding(rule: Rule, bound: (role: string) => BoundPart | null): string[] {
  const problems: string[] = [];
  // An automation's roles are the server's to check: whether the automation is there, and the chain it makes.
  for (const [role, spec] of partRoles(rule)) {
    const part = bound(role);
    if (!part) {
      problems.push(`${spec.label}: no device`);
      continue;
    }
    if (!partsOf(part.description).some((candidate) => candidate.id === part.part)) problems.push(`${spec.label}: ${part.name} no longer has that part`);
    else if (!meetsNeed(spec, part.capabilities)) problems.push(`${spec.label}: ${part.name} cannot do that`);
  }
  const { reads, events, writes } = ruleUses(rule);
  for (const read of reads) {
    const part = bound(read.role);
    if (part && !attributeMeaning(part.description, part.part, read.means)) problems.push(`${rule.roles[read.role]?.label ?? read.role}: ${part.name} does not report ${read.means}`);
  }
  for (const wanted of events) {
    const part = bound(wanted.role);
    const declared = part?.description.events?.find((event) => event.id === wanted.event && (event.part ?? MAIN_PART) === part.part);
    if (part && !declared) problems.push(`${rule.roles[wanted.role]?.label ?? wanted.role}: ${part.name} never says "${wanted.event}"`);
  }
  // A setting changed: the part has it, it can be written, it is not one that can harm the hardware, and the value fits it.
  for (const write of writes) {
    const part = bound(write.role);
    if (!part) continue;
    const attribute = writtenAttribute(part.description, part.part, write);
    const who = rule.roles[write.role]?.label ?? write.role;
    if (!attribute) problems.push(`${who}: ${part.name} has no setting ${write.means !== undefined ? `that is its ${(standardMeaning(write.means)?.label ?? write.means).toLowerCase()}` : `"${write.key}"`}`);
    else if (attribute.access !== 'write') problems.push(`${who}: ${attribute.label} of ${part.name} is read, not set`);
    else if (attribute.dangerous) problems.push(`${who}: ${attribute.label} of ${part.name} can harm it, and is never changed by an automation`);
    else if ('value' in write.value) {
      const checked = checkValue(attribute.value, write.value.value);
      if (!checked.ok) problems.push(`${who}: ${attribute.label} ${checked.problem}`);
    }
  }
  return problems;
}

/**
 * The setting a `write` changes, on the part filling its role — by its key,
 * or the one there that has its meaning and can be set: what its words and
 * its value are held to.
 */
export const writtenAttribute = (description: DeviceDescription, part: string, target: WriteTarget): AttributeSpec | null =>
  description.attributes.find(
    (candidate) => (candidate.part ?? MAIN_PART) === part && (target.means !== undefined ? candidate.means === target.means && candidate.access === 'write' : candidate.key === target.key)
  ) ?? null;

/** Whether a rule reads anything of this role: its `becomes` triggers are evaluated when that part's readings move. */
export const readsRole = (rule: Rule, role: string): boolean => ruleUses(rule).reads.some((read) => read.role === role);

// --- running a rule -----------------------------------------------------------

/** What an expression is evaluated against. */
export type RuleScope = {
  param(name: string): Value;
  /** What the part filling a role reports now for a meaning, or null when it cannot be known. */
  read(role: string, means: string): { value: ScalarValue; label: string; unit: string } | null;
  /** A function's answer; not given where calls are not allowed. */
  call?(fn: string, role: string, args: Readonly<Record<string, Value>>): Promise<Evaluation>;
  /** Whether the part filling a role can be reached now — and, when not, why. */
  reachable(role: string): { reachable: boolean | null; detail: string };
  /** How a role's part is named: "Garage station". */
  name(role: string): string;
  /** The time of day on the owner's clock, as "HH:MM"; null where there is none. */
  clock(): string | null;
};

const compare = (op: CompareOp, left: Value, right: Value): Value => {
  // Unknown is never an answer; structure is not compared.
  if (left === null || right === null || !isScalar(left) || !isScalar(right)) return null;
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    default:
      if (typeof left !== 'number' || typeof right !== 'number') return null;
      return op === 'lt' ? left < right : op === 'le' ? left <= right : op === 'gt' ? left > right : left >= right;
  }
};

const combine = (kind: 'all' | 'any', values: readonly Value[]): Value => {
  const decisive = kind === 'all' ? false : true;
  if (values.some((value) => value === decisive)) return decisive;
  if (values.some((value) => value === null || typeof value !== 'boolean')) return null;
  return !decisive;
};

const shown = (value: Value, unit = ''): string =>
  value === null
    ? 'unknown'
    : typeof value === 'boolean'
      ? value ? 'yes' : 'no'
      : typeof value === 'number'
        ? `${Math.round(value * 100) / 100}${unit ? (unit === '%' ? ' %' : ` ${unit}`) : ''}`
        : typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? `${value.length} values`
            : 'a set of values';

/**
 * An expression's value, or null when it cannot be known — and, in `trace`,
 * what it read and what each function said, in words.
 */
export async function evaluate(expr: Expr, scope: RuleScope, trace: string[] = []): Promise<Value> {
  if ('call' in expr) {
    if (!scope.call) return null;
    const args: Record<string, Value> = {};
    for (const [name, arg] of Object.entries(expr.args ?? {})) args[name] = await evaluate(arg, scope, trace);
    const answer = await scope.call(expr.call, expr.role, args);
    if (answer.detail) trace.push(answer.detail);
    return answer.value;
  }
  if ('compare' in expr) return compare(expr.compare, await evaluate(expr.left, scope, trace), await evaluate(expr.right, scope, trace));
  if ('math' in expr) return calculate(expr.math, await evaluate(expr.left, scope, trace), await evaluate(expr.right, scope, trace));
  if ('all' in expr || 'any' in expr) {
    const parts = 'all' in expr ? expr.all : expr.any;
    const values: Value[] = [];
    for (const part of parts) values.push(await evaluate(part, scope, trace));
    return combine('all' in expr ? 'all' : 'any', values);
  }
  if ('not' in expr) {
    const value = await evaluate(expr.not, scope, trace);
    return typeof value === 'boolean' ? !value : null;
  }
  return evaluateNow(expr, scope, trace);
}

/** The same, for what needs no function: a `becomes` condition, evaluated on every reading. */
export function evaluateNow(expr: Expr, scope: RuleScope, trace: string[] = []): Value {
  if ('value' in expr) return expr.value;
  if ('param' in expr) return scope.param(expr.param);
  if ('read' in expr) {
    const read = scope.read(expr.read.role, expr.read.means);
    trace.push(`${scope.name(expr.read.role)}: ${read ? `${read.label} ${shown(read.value, read.unit)}` : `${expr.read.means} is not known`}`);
    return read?.value ?? null;
  }
  if ('reachable' in expr) {
    const { reachable, detail } = scope.reachable(expr.reachable);
    trace.push(`${scope.name(expr.reachable)}: ${reachable ? 'can be reached' : `cannot be reached (${detail})`}`);
    return reachable;
  }
  if ('within' in expr) {
    const now = scope.clock();
    const [from, to] = [minutesOf(evaluateNow(expr.within.from, scope)), minutesOf(evaluateNow(expr.within.to, scope))];
    if (now === null || from === null || to === null) return null;
    trace.push(`It is ${now}`);
    return inWindow(minutesOf(now)!, from, to);
  }
  if ('compare' in expr) return compare(expr.compare, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
  if ('math' in expr) return calculate(expr.math, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
  if ('all' in expr) return combine('all', expr.all.map((part) => evaluateNow(part, scope, trace)));
  if ('any' in expr) return combine('any', expr.any.map((part) => evaluateNow(part, scope, trace)));
  if ('not' in expr) {
    const value = evaluateNow(expr.not, scope, trace);
    return typeof value === 'boolean' ? !value : null;
  }
  return null; // a call: not here
}

/**
 * What can be known from an automation's settings alone: each setting as it
 * stands (or its default), and nothing read — "turn it on", not "turn it
 * (action is on)".
 */
function settledScope(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string = (role) => role): RuleScope {
  return {
    param: (key) => {
      const field = rule.params.fields[key];
      return (params[key] ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
    },
    read: () => null,
    reachable: () => ({ reachable: null, detail: 'not known until it runs' }),
    name,
    clock: () => null,
  };
}

/**
 * The steps a choice takes when its settings alone decide it — "if you chose
 * to switch them off again" — or null when it turns on what is read as it
 * runs. A choice its owner has already made is not a step to follow: it
 * reads, and runs, as the steps it chose.
 */
export function settledChoice(rule: Rule, step: Extract<Step, { choose: unknown }>, params: Readonly<Record<string, Value>>): readonly Step[] | null {
  const decided = evaluateNow(step.choose.if, settledScope(rule, params));
  if (typeof decided !== 'boolean') return null;
  return decided ? step.choose.then : (step.choose.else ?? []);
}

/** A rule an automation owns has no settings: every value is in its blocks. */
export const NO_SETTINGS: ConfigSchema = { fields: {} };

/**
 * A recipe's settings written into its blocks — each setting its plain value
 * (or its default), a choice they decide the steps it chose — and no
 * settings left: what an automation copied from a recipe owns, and edits as
 * any other (docs/AUTOMATION-EDITOR.md).
 */
export function inlineParams(rule: Rule, values: Readonly<Record<string, Value>>): Rule {
  const scope = settledScope(rule, values);
  const args = (given: Readonly<Record<string, Expr>>): Record<string, Expr> => Object.fromEntries(Object.entries(given).map(([name, arg]) => [name, expr(arg)]));
  /**
   * Every setting its value — and what the settings alone decide, decided:
   * "15 is below 50" is true, and a condition that is part of it goes, so a
   * copy reads as what it watches, never as a check of its own sliders.
   */
  function expr(given: Expr): Expr {
    if ('param' in given) return { value: scope.param(given.param) };
    if ('call' in given) return given.args ? { call: given.call, role: given.role, args: args(given.args) } : given;
    if ('within' in given) return { within: { from: expr(given.within.from), to: expr(given.within.to) } };
    if ('math' in given) {
      const left = expr(given.left);
      const right = expr(given.right);
      // Settings alone: the number they make, written in.
      if ('value' in left && 'value' in right) return { value: calculate(given.math, left.value, right.value) };
      return { math: given.math, left, right };
    }
    if ('compare' in given) {
      const left = expr(given.left);
      const right = expr(given.right);
      if ('value' in left && 'value' in right) return { value: evaluateNow({ compare: given.compare, left, right }, scope) };
      return { compare: given.compare, left, right };
    }
    if ('all' in given || 'any' in given) {
      const every = 'all' in given;
      const parts = (every ? given.all : given.any).map(expr);
      // One part decided against the rest decides it; one decided for it is no part at all.
      if (parts.some((part) => 'value' in part && part.value === !every)) return { value: !every };
      const open = parts.filter((part) => !('value' in part && part.value === every));
      if (!open.length) return { value: every };
      if (open.length === 1) return open[0]!;
      return every ? { all: open } : { any: open };
    }
    if ('not' in given) {
      const inner = expr(given.not);
      return 'value' in inner && typeof inner.value === 'boolean' ? { value: !inner.value } : { not: inner };
    }
    return given;
  }
  const steps = (list: readonly Step[] | undefined): Step[] =>
    (list ?? []).flatMap((step) => {
      const chosen = 'choose' in step ? settledChoice(rule, step, values) : null;
      return chosen ? steps(chosen) : [one(step)];
    });
  const optional = (list: readonly Step[] | undefined): { steps?: Step[] } => {
    const inner = steps(list);
    return inner.length ? { steps: inner } : {};
  };
  function one(step: Step): Step {
    if ('command' in step) return { command: { ...step.command, args: args(step.command.args) } };
    if ('write' in step) return { write: { ...step.write, value: expr(step.write.value) } };
    if ('start' in step) return { start: step.start.waitSeconds ? { role: step.start.role, waitSeconds: expr(step.start.waitSeconds) } : { role: step.start.role } };
    if ('wait' in step) return { wait: { seconds: expr(step.wait.seconds) } };
    if ('waitUntil' in step) return { waitUntil: { condition: expr(step.waitUntil.condition), atMostSeconds: expr(step.waitUntil.atMostSeconds) } };
    if ('ensure' in step) {
      const { condition, withinSeconds, tries, retry } = step.ensure;
      return { ensure: { condition: expr(condition), withinSeconds: expr(withinSeconds), tries: expr(tries), retry: steps(retry) } };
    }
    if ('choose' in step) {
      const otherwise = optional(step.choose.else).steps;
      return { choose: { if: expr(step.choose.if), then: steps(step.choose.then), ...(otherwise ? { else: otherwise } : {}) } };
    }
    const then = optional(step.watch.then).steps;
    const otherwise = optional(step.watch.else).steps;
    return { watch: { condition: expr(step.watch.condition), seconds: expr(step.watch.seconds), ...(then ? { then } : {}), ...(otherwise ? { else: otherwise } : {}) } };
  }
  const when = rule.when.map((trigger): Trigger => {
    if ('at' in trigger) return { ...trigger, at: expr(trigger.at) };
    if ('every' in trigger) return { every: expr(trigger.every) };
    if ('becomes' in trigger) return { becomes: expr(trigger.becomes), ...(trigger.heldForMinutes ? { heldForMinutes: expr(trigger.heldForMinutes) } : {}) };
    return trigger;
  });
  const otherwise = optional(rule.otherwise).steps;
  // An "only if" its settings make always true is no condition at all.
  const only = rule.if ? expr(rule.if) : null;
  const keptIf = only && !('value' in only && only.value === true) ? { if: only } : {};
  return { roles: rule.roles, params: NO_SETTINGS, when, ...keptIf, then: steps(rule.then), ...(otherwise ? { otherwise } : {}) };
}

// --- saying what it does ---------------------------------------------------------

/** A number of seconds as a person says it: "20 s", "2 min", "1 min 30 s", "1 h". */
export function secondsText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3_600) return whole % 60 ? `${Math.floor(whole / 60)} min ${whole % 60} s` : `${whole / 60} min`;
  const minutes = Math.round(whole / 60);
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

/** A setting as it reads in a sentence: an option's label, a number with its unit, seconds as a duration. */
export function paramText(schema: ConfigSchema, name: string, value: Value): string {
  const field = schema.fields[name];
  if (value === null || value === undefined) return '…';
  if (field?.type === 'enum' && typeof value === 'string') {
    const label = enumLabel(field, value);
    // Mid-sentence: "tomorrow", not "Tomorrow" — unless it is a name or a time.
    return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  }
  if (field?.type === 'number' && typeof value === 'number') return field.unit === 's' ? secondsText(value) : shown(value, field.unit ?? '');
  return shown(value);
}

const OP_WORDS: Record<CompareOp, string> = { lt: 'is below', le: 'is at most', gt: 'is above', ge: 'is at least', eq: 'is', ne: 'is not' };

/**
 * Something of a part, as English says it: "Garage station’s charge",
 * "Garage station — AC outlets’ power" — or, when the name is a clause or
 * already whose, "the power of what powers the charger", "the power of the
 * charger’s plug", never "the charger’s plug’s power".
 */
export const whose = (name: string, thing: string): string => {
  if (/^(what|which|whatever|whichever)\b/i.test(name) || /[’']s\b/.test(name)) return `the ${thing} of ${name}`;
  return /s$/i.test(name) ? `${name}’ ${thing}` : `${name}’s ${thing}`;
};

/** One expression of a rule, in words, with its settings filled in: "Garage station's charge is below 15 %". */
export function describeExpr(rule: Rule, expr: Expr, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  /** A setting compared with one of its own options: what its owner chose, in the option's own words. */
  const chosen = (expr: Extract<Expr, { compare: CompareOp }>): string | null => {
    if (expr.compare !== 'eq' && expr.compare !== 'ne') return null;
    const [setting, option] = 'param' in expr.left && 'value' in expr.right ? [expr.left.param, expr.right.value] : 'param' in expr.right && 'value' in expr.left ? [expr.right.param, expr.left.value] : [null, null];
    const field = setting ? rule.params.fields[setting] : undefined;
    if (field?.type !== 'enum' || typeof option !== 'string') return null;
    return `${expr.compare === 'eq' ? 'you chose' : 'you did not choose'} “${enumLabel(field, option)}”`;
  };
  /** The unit a reading is in, when it is one: a plain number beside it is in it too — "above 50 W", not "above 50". */
  const unitOf = (expr: Expr): string => {
    if ('math' in expr) return unitOf(expr.left) || unitOf(expr.right);
    const standard = 'read' in expr ? standardMeaning(expr.read.means) : null;
    return standard?.type === 'number' && !standard.units ? standard.unit : '';
  };
  const text = (expr: Expr, unit = ''): string => {
    if ('value' in expr) return typeof expr.value === 'number' ? shown(expr.value, unit) : shown(expr.value);
    if ('param' in expr) return param(expr.param);
    // What it reports, not chosen yet: "a reading" rather than an empty name.
    if ('read' in expr) return whose(name(expr.read.role), standardMeaning(expr.read.means)?.label.toLowerCase() || expr.read.means || 'reading');
    if ('reachable' in expr) return `${name(expr.reachable)} can be reached`;
    if ('within' in expr) return `it is between ${text(expr.within.from)} and ${text(expr.within.to)}`;
    if ('math' in expr) {
      // A plain number beside a reading is in its unit: "Garage station’s charge plus 10 %".
      const in_ = unit || unitOf(expr);
      const [left, right] = [text(expr.left, in_), text(expr.right, in_)];
      return expr.math === 'add' ? `${left} plus ${right}` : expr.math === 'subtract' ? `${left} minus ${right}` : `the ${expr.math === 'min' ? 'lower' : 'higher'} of ${left} and ${right}`;
    }
    if ('call' in expr) return `${vocabulary?.fn(expr.call)?.label.toLowerCase() ?? expr.call} by ${name(expr.role)}`;
    if ('compare' in expr) return chosen(expr) ?? `${text(expr.left, unitOf(expr.right))} ${OP_WORDS[expr.compare]} ${text(expr.right, unitOf(expr.left))}`;
    if ('all' in expr) return expr.all.map((part) => text(part)).join(' and ');
    if ('any' in expr) return expr.any.map((part) => text(part)).join(' or ');
    return `not (${text(expr.not)})`;
  };
  return text(expr);
}

/** An event as its capability names it — "mains lost" — or, a type's own, its id in words. */
const eventWords = (rule: Rule, role: string, event: string): string => {
  const spec = rule.roles[role];
  const named = spec && !isAutomationRole(spec) ? [...spec.capabilities, ...(spec.oneOf ?? [])] : [];
  const label = named.flatMap((capability) => (isCapability(capability) ? [capabilitySpec(capability).events?.[event]?.label] : [])).find(Boolean);
  return (label ?? event.replace(/[._-]+/g, ' ')).toLowerCase();
};

const DAY_WORDS: Readonly<Record<Weekday, string>> ={ mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** Which days, as a person says it: "every day", "on weekdays", "at weekends", "on Mon, Wed and Fri". */
export function daysText(days: readonly Weekday[] | undefined): string {
  const chosen = WEEKDAYS.filter((day) => !days || days.includes(day));
  if (chosen.length === 7) return 'every day';
  if (chosen.join() === 'mon,tue,wed,thu,fri') return 'on weekdays';
  if (chosen.join() === 'sat,sun') return 'at weekends';
  const words = chosen.map((day) => DAY_WORDS[day]);
  return `on ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}`;
}

/**
 * When a rule runs, one sentence a trigger: "When Station's charge is below
 * 15 % for 2 min", "Every day at 07:00", "At 07:00 on weekdays". What a
 * person reads to know how often it looks, and at what. None: it runs when
 * played, or started by another automation.
 */
export function describeTriggers(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string[] {
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  return rule.when.map((trigger) => {
    if ('at' in trigger) return trigger.days && daysText(trigger.days) !== 'every day' ? `At ${text(trigger.at)} ${daysText(trigger.days)}` : `Every day at ${text(trigger.at)}`;
    if ('every' in trigger) return `Every ${'value' in trigger.every ? `${text(trigger.every)} min` : text(trigger.every)}`;
    if ('event' in trigger) return `When ${name(trigger.event.role)} reports ${eventWords(rule, trigger.event.role, trigger.event.event)}`;
    const held = trigger.heldForMinutes ? ` for ${'value' in trigger.heldForMinutes ? `${text(trigger.heldForMinutes)} min` : text(trigger.heldForMinutes)}` : '';
    return `When ${text(trigger.becomes)}${held}`;
  });
}

/**
 * A trigger's sentence said as what comes next — not as if it had happened:
 * "At 07:00 on weekdays" is "Next at 07:00 on weekdays", "Every 15 min"
 * "Runs every 15 min", "When the charge is below 15 %" "Waiting: the charge
 * is below 15 %".
 */
export function triggerAsNext(trigger: string): string {
  if (/^At /.test(trigger)) return `Next at ${trigger.slice(3)}`;
  if (/^Every day at /.test(trigger)) return `Next at ${trigger.slice(13)}, every day`;
  if (/^Every /.test(trigger)) return `Runs every ${trigger.slice(6)}`;
  if (/^When /.test(trigger)) return `Waiting: ${trigger.slice(5)}`;
  return trigger;
}

/**
 * Whether an automation acts on its own: `off` — it does nothing; `watch`
 * — it decides and says what it would have done; `act` — it does it,
 * through the gateway. The same words in a file, on the API and in the app.
 */
export const AUTOMATION_MODES = ['off', 'watch', 'act'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** One step, in words, and the steps within it — what a sequence is shown as, numbered and nested. */
export type StepLine = {
  kind: StepKind;
  /** "Turn Station's AC outlets on", "Wait until Charger plug can be reached — at most 2 min". */
  text: string;
  /** Steps within it, each group with what it is for: "If it stays so", "Each time". */
  branches: { label: string; steps: StepLine[] }[];
};

/** How a rule's words are put together: its settings as they stand, and its parts by name. */
function wording(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary) {
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  const settled = settledScope(rule, params, name);
  const seconds = (expr: Expr): string => {
    const known = evaluateNow(expr, settled);
    return typeof known === 'number' ? secondsText(known) : text(expr);
  };
  const count = (expr: Expr): string => {
    const known = evaluateNow(expr, settled);
    return typeof known === 'number' ? (known === 1 ? 'once' : known === 2 ? 'twice' : `${known} times`) : text(expr);
  };
  const command = ({ role, capability, command, args }: Command): string => {
    // On or off by a condition: "turn Charger plug on if Garage station’s charge is below 50 %, off if not".
    const on = capability === 'switch' && command === 'set' && args.on ? args.on : null;
    if (on && typeof evaluateNow(on, settled) !== 'boolean' && !('param' in on) && !('value' in on)) return `turn ${name(role)} on if ${text(on)}, off if not`;
    const values = Object.values(args).map((arg) => {
      const known = evaluateNow(arg, settled);
      return typeof known === 'boolean' ? (known ? 'on' : 'off') : known !== null ? shown(known) : text(arg);
    });
    return capability === 'switch' && command === 'set' ? `turn ${name(role)} ${values.join(' ')}` : `${capability}.${command} ${name(role)} (${values.join(', ')})`;
  };
  /** "set Scooter plug’s Live readings to on": the setting as its device names it, the value as it reads. */
  const write = (step: Write): string => {
    const { role, value } = step;
    const attribute = vocabulary?.attribute?.(role, step) ?? null;
    const known = evaluateNow(value, settled);
    const said =
      known === null
        ? text(value)
        : attribute?.value.type === 'boolean' && typeof known === 'boolean'
          ? (attribute.value.words?.[known ? 'true' : 'false'] ?? (known ? 'on' : 'off')).toLowerCase()
          : attribute?.value.type === 'enum' && typeof known === 'string'
            ? enumLabel(attribute.value, known)
            : typeof known === 'boolean'
              ? (known ? 'on' : 'off')
              : shown(known, attribute?.value.type === 'number' ? (attribute.value.unit ?? '') : '');
    // No setting chosen yet: said as what it is about, not as an empty name.
    // By meaning, before a part fills it: as the meaning is called.
    const label = attribute?.label ?? (step.means !== undefined ? (standardMeaning(step.means)?.label ?? step.means) : step.key);
    if (!label.trim()) return `set a setting of ${name(role)}`;
    return `set ${whose(name(role), label)} to ${said}`;
  };
  /** "start “Charge the scooter” and wait until it ends — at most 5 min". */
  const start = ({ role, waitSeconds }: Extract<Step, { start: unknown }>['start']): string =>
    `start ${name(role)}${waitSeconds ? ` and wait until it ends — at most ${seconds(waitSeconds)}` : ''}`;
  /** Steps as they read: a choice its settings decide is the steps it chose, in its place. */
  const steps = <T>(list: readonly Step[] | undefined, each: (step: Step) => T): T[] =>
    (list ?? []).flatMap((step) => {
      const chosen = 'choose' in step ? settledChoice(rule, step, params) : null;
      return chosen ? steps(chosen, each) : [each(step)];
    });
  const lines = (list: readonly Step[] | undefined): StepLine[] => steps(list, line);
  const line = (step: Step): StepLine => {
    const group = (label: string, list: readonly Step[] | undefined) => {
      const inner = lines(list);
      return inner.length ? [{ label, steps: inner }] : [];
    };
    if ('command' in step) return { kind: 'command', text: capitalise(command(step.command)), branches: [] };
    if ('write' in step) return { kind: 'write', text: capitalise(write(step.write)), branches: [] };
    if ('start' in step) return { kind: 'start', text: capitalise(start(step.start)), branches: [] };
    if ('wait' in step) return { kind: 'wait', text: `Wait ${seconds(step.wait.seconds)}`, branches: [] };
    if ('waitUntil' in step) return { kind: 'waitUntil', text: `Wait until ${text(step.waitUntil.condition)} — at most ${seconds(step.waitUntil.atMostSeconds)}`, branches: [] };
    if ('ensure' in step) {
      const { condition, withinSeconds, tries, retry } = step.ensure;
      return {
        kind: 'ensure',
        text: `Make sure ${text(condition)} within ${seconds(withinSeconds)} — if not, try again, at most ${count(tries)}`,
        branches: group('Each time', retry),
      };
    }
    if ('choose' in step) return { kind: 'choose', text: `If ${text(step.choose.if)}`, branches: [...group('Then', step.choose.then), ...group('Otherwise', step.choose.else)] };
    return {
      kind: 'watch',
      text: `Watch for ${seconds(step.watch.seconds)} whether ${text(step.watch.condition)}`,
      branches: [...group('If it stays so', step.watch.then), ...group('If not', step.watch.else)],
    };
  };
  /** A step in a sentence, briefly: what it does, not its branches. */
  const brief = (step: Step): string => {
    if ('command' in step) return command(step.command);
    if ('write' in step) return write(step.write);
    if ('start' in step) return start(step.start);
    if ('wait' in step) return `wait ${seconds(step.wait.seconds)}`;
    if ('waitUntil' in step) return `wait until ${text(step.waitUntil.condition)}`;
    if ('ensure' in step) return `make sure ${text(step.ensure.condition)}`;
    if ('choose' in step) {
      const otherwise = briefs(step.choose.else);
      return `if ${text(step.choose.if)}, ${briefs(step.choose.then).join(' and ') || 'nothing'}${otherwise.length ? `, otherwise ${otherwise.join(' and ')}` : ''}`;
    }
    const then = briefs(step.watch.then);
    return `watch whether ${text(step.watch.condition)}${then.length ? `, and if it stays so ${then.join(' and ')}` : ''}`;
  };
  const briefs = (list: readonly Step[] | undefined): string[] => steps(list, brief);
  return { text, lines, briefs };
}

/**
 * A rule's steps in words, numbered and nested — what the app shows a
 * sequence as — and what it does if a step does not succeed.
 */
export function describeSteps(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): { steps: StepLine[]; otherwise: StepLine[] } {
  const { lines } = wording(rule, params, name, vocabulary);
  return { steps: lines(rule.then), otherwise: lines(rule.otherwise) };
}

/**
 * How an automation reads, in one sentence: its recipe's wording with roles
 * and settings filled in, or one made from the rule itself — its steps said
 * briefly, in order.
 */
export function describeRule(rule: Rule & { sentence?: string }, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  if (rule.sentence) return rule.sentence.replace(/\{(\w+)\}/g, (_, key: string) => (key in rule.roles ? name(key) : param(key)));

  const { text, briefs } = wording(rule, params, name, vocabulary);
  const minutes = (expr: Expr) => ('value' in expr ? `${text(expr)} min` : text(expr));
  const when = rule.when
    .map((trigger) =>
      'at' in trigger
        ? `at ${text(trigger.at)}${trigger.days && daysText(trigger.days) !== 'every day' ? ` ${daysText(trigger.days)}` : ''}`
        : 'every' in trigger
          ? `every ${minutes(trigger.every)}`
          : 'event' in trigger
            ? `when ${name(trigger.event.role)} reports ${eventWords(rule, trigger.event.role, trigger.event.event)}`
            : `when ${text(trigger.becomes)}${trigger.heldForMinutes ? ` for ${minutes(trigger.heldForMinutes)}` : ''}`
    )
    .join(', or ');
  // No trigger: it is played, or started — the sentence is what it does.
  const opening = [when, rule.if ? `if ${text(rule.if)}` : ''].filter(Boolean).join(', ');
  // A rule still being built may have no step yet: said so, not as an empty clause.
  const does = briefs(rule.then);
  const sentence = `${opening ? `${opening}, ` : ''}${does.length ? does.join(', then ') : 'nothing yet'}.`;
  return capitalise(sentence);
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
