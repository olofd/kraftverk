import { capabilitySpec, isCapability, meetsNeed, type CapabilityId, type CapabilityName, type CapabilityNeed, type QueryAnswer, type QueryName } from './capabilities.ts';
import { attributeMeaning, MAIN_PART, partsOf, type DeviceDescription, type Reading } from './description.ts';
import type { QueryRequest } from './device-type.ts';
import type { SessionHealth } from './identity.ts';
import { standardMeaning } from './meanings.ts';
import { valueTypeOf, type ConfigSchema } from './schema.ts';
import { checkValue, enumLabel, isScalar, type ScalarValue, type Value, type ValueType } from './values.ts';

/**
 * Automations as data: the rule (docs/AUTOMATIONS.md).
 *
 * One small, typed language that a package's recipe, a person's editor, a DSL
 * and an AI all write, and one evaluator that runs it wherever it is held.
 * Its words are the device model's — capabilities, meanings, events,
 * commands — plus the functions packages contribute; it adds none of its own.
 * It can read, compare, and ask the gateway for commands: nothing else. So
 * whatever wrote a rule wrote data, and a rule can do no more than a person
 * could from a screen, after it has been seen observing and armed on purpose.
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
  | { all: readonly Expr[] }
  | { any: readonly Expr[] }
  | { not: Expr }
  /**
   * Whether the part filling a role can be reached now: its holder says it is
   * connected. Never unknown — not being reachable is the answer.
   */
  | { reachable: string };

export type Trigger =
  /** Every day at this time — "07:00" — on the automation's own clock. */
  | { at: Expr }
  /** When the part filling a role raises an event its description declares. */
  | { event: { role: string; event: string } }
  /**
   * When a condition turns true — and, with `heldForMinutes`, has stayed true
   * that long. Reads and comparisons only: it is evaluated on every reading.
   */
  | { becomes: Expr; heldForMinutes?: Expr }
  /** When a person — or an assistant for one — starts it (docs/SEQUENCES.md). */
  | { asked: true };

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
  | { watch: { condition: Expr; seconds: Expr; then?: readonly Step[]; else?: readonly Step[] } };

/** The kinds of step: what a run records each as. */
export type StepKind = 'command' | 'wait' | 'waitUntil' | 'ensure' | 'choose' | 'watch';

export const stepKind = (step: Step): StepKind =>
  'command' in step ? 'command' : 'wait' in step ? 'wait' : 'waitUntil' in step ? 'waitUntil' : 'ensure' in step ? 'ensure' : 'choose' in step ? 'choose' : 'watch';

/** What the part filling a role must offer, and what it is for. */
export type RoleSpec = CapabilityNeed & { label: string; description: string };

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

export type RuleVocabulary = {
  /** The installed function with this id, or null. */
  fn(id: string): AutomationFunction | null;
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
    const named = [...(spec.capabilities ?? []), ...(spec.oneOf ?? [])];
    if (!named.length) problems.push(`roles.${role}: it asks for no capability, so any device would do`);
    for (const capability of named) if (!isCapability(capability)) problems.push(`roles.${role}: there is no capability "${capability}"`);
  }

  const role = (name: string, where: string): RoleSpec | null => {
    const spec = roles[name];
    if (!spec) problems.push(`${where}: there is no role "${name}"`);
    return spec ?? null;
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
      const standard = standardMeaning(expr.read.means);
      if (!standard) return { type: 'unknown' }; // a type's own meaning: checked when bound
      if (spec && !meaningsOfNeed(spec).has(expr.read.means)) {
        problems.push(`${where}: ${expr.read.role} asks for nothing that reports ${expr.read.means}`);
      }
      return standard.type === 'boolean' ? { type: 'boolean' } : { type: 'number', unit: standard.unit || null };
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

  if (!rule.when?.length) problems.push('when: nothing starts it');
  (rule.when ?? []).forEach((trigger, index) => {
    const where = `when[${index}]`;
    if ('at' in trigger) {
      const got = shape(trigger.at, `${where}.at`, { calls: false });
      if (!fits({ type: 'string', options: null }, got)) problems.push(`${where}.at: expected a time of day, got ${said(got)}`);
      if ('value' in trigger.at && (typeof trigger.at.value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.at.value))) problems.push(`${where}.at: a time of day is "HH:MM"`);
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
    } else if ('asked' in trigger) {
      if (trigger.asked !== true) problems.push(`${where}.asked: it is started when asked, or it is not this trigger`);
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
      else if ('wait' in step) bounded(step.wait.seconds, `${at}.wait.seconds`, 's', SEQUENCE_LIMITS.waitSeconds, 'a pause of');
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

/** The events a role's capabilities declare: what a trigger on it can wait for before it is bound. */
export const roleEvents = (spec: CapabilityNeed): string[] =>
  [...new Set([...spec.capabilities, ...(spec.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.keys(capabilitySpec(name).events ?? {}) : [])))];

/** Every role a rule reads, triggers on or acts through, with what it asks of it. */
/** What a rule reads, the events it waits for and the functions it calls: what running it, or rehearsing it on history, needs. */
export function ruleUses(rule: Rule): {
  reads: { role: string; means: string }[];
  events: { role: string; event: string }[];
  calls: { fn: string; role: string }[];
  /** The roles whose reachability it asks about: what a device's health moving can change. */
  reaches: string[];
} {
  const reads: { role: string; means: string }[] = [];
  const calls: { fn: string; role: string }[] = [];
  const reaches: string[] = [];
  const walk = (expr: Expr | undefined): void => {
    if (!expr) return;
    if ('read' in expr) reads.push(expr.read);
    else if ('reachable' in expr) reaches.push(expr.reachable);
    else if ('call' in expr) (calls.push({ fn: expr.call, role: expr.role }), Object.values(expr.args ?? {}).forEach(walk));
    else if ('compare' in expr) (walk(expr.left), walk(expr.right));
    else if ('all' in expr) expr.all.forEach(walk);
    else if ('any' in expr) expr.any.forEach(walk);
    else if ('not' in expr) walk(expr.not);
  };
  const walkSteps = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if ('command' in step) Object.values(step.command.args).forEach(walk);
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
    else if ('event' in trigger) events.push(trigger.event);
    else if ('becomes' in trigger) (walk(trigger.becomes), walk(trigger.heldForMinutes));
  }
  walk(rule.if);
  walkSteps(rule.then);
  walkSteps(rule.otherwise ?? []);
  return { reads, events, calls, reaches: [...new Set(reaches)] };
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

/** Whether a rule takes steps — waits, choices, a fallback — rather than sending its commands at once. */
export const takesSteps = (rule: Rule): boolean => rule.then.some((step) => !('command' in step)) || Boolean(rule.otherwise?.length);

/** Whether a rule is started when asked. */
export const startsWhenAsked = (rule: Rule): boolean => rule.when.some((trigger) => 'asked' in trigger);

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
  for (const [role, spec] of Object.entries(rule.roles)) {
    const part = bound(role);
    if (!part) {
      problems.push(`${spec.label}: no device`);
      continue;
    }
    if (!partsOf(part.description).some((candidate) => candidate.id === part.part)) problems.push(`${spec.label}: ${part.name} no longer has that part`);
    else if (!meetsNeed(spec, part.capabilities)) problems.push(`${spec.label}: ${part.name} cannot do that`);
  }
  const { reads, events } = ruleUses(rule);
  for (const read of reads) {
    const part = bound(read.role);
    if (part && !attributeMeaning(part.description, part.part, read.means)) problems.push(`${rule.roles[read.role]?.label ?? read.role}: ${part.name} does not report ${read.means}`);
  }
  for (const wanted of events) {
    const part = bound(wanted.role);
    const declared = part?.description.events?.find((event) => event.id === wanted.event && (event.part ?? MAIN_PART) === part.part);
    if (part && !declared) problems.push(`${rule.roles[wanted.role]?.label ?? wanted.role}: ${part.name} never says "${wanted.event}"`);
  }
  return problems;
}

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
  if ('compare' in expr) return compare(expr.compare, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
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
  const text = (expr: Expr): string => {
    if ('value' in expr) return shown(expr.value);
    if ('param' in expr) return param(expr.param);
    if ('read' in expr) return whose(name(expr.read.role), standardMeaning(expr.read.means)?.label.toLowerCase() ?? expr.read.means);
    if ('reachable' in expr) return `${name(expr.reachable)} can be reached`;
    if ('call' in expr) return `${vocabulary?.fn(expr.call)?.label.toLowerCase() ?? expr.call} by ${name(expr.role)}`;
    if ('compare' in expr) return chosen(expr) ?? `${text(expr.left)} ${OP_WORDS[expr.compare]} ${text(expr.right)}`;
    if ('all' in expr) return expr.all.map(text).join(' and ');
    if ('any' in expr) return expr.any.map(text).join(' or ');
    return `not (${text(expr.not)})`;
  };
  return text(expr);
}

/**
 * When a rule runs, one sentence a trigger: "When Station's charge is below
 * 15 % for 2 min", "Every day at 07:00", "When you start it". What a person
 * reads to know how often it looks, and at what.
 */
export function describeTriggers(rule: Rule, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string[] {
  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  return rule.when.map((trigger) => {
    if ('asked' in trigger) return 'When you start it';
    if ('at' in trigger) return `Every day at ${text(trigger.at)}`;
    if ('event' in trigger) return `When ${name(trigger.event.role)} reports ${trigger.event.event.replace(/[._-]+/g, ' ')}`;
    const held = trigger.heldForMinutes ? ` for ${'value' in trigger.heldForMinutes ? `${text(trigger.heldForMinutes)} min` : text(trigger.heldForMinutes)}` : '';
    return `When ${text(trigger.becomes)}${held}`;
  });
}

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
    const values = Object.values(args).map((arg) => {
      const known = evaluateNow(arg, settled);
      return typeof known === 'boolean' ? (known ? 'on' : 'off') : known !== null ? shown(known) : text(arg);
    });
    return capability === 'switch' && command === 'set' ? `turn ${name(role)} ${values.join(' ')}` : `${capability}.${command} ${name(role)} (${values.join(', ')})`;
  };
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
      'asked' in trigger
        ? 'when you start it'
        : 'at' in trigger
          ? `at ${text(trigger.at)}`
          : 'event' in trigger
            ? `when ${name(trigger.event.role)} says "${trigger.event.event}"`
            : `when ${text(trigger.becomes)}${trigger.heldForMinutes ? ` for ${minutes(trigger.heldForMinutes)}` : ''}`
    )
    .join(', or ');
  const sentence = `${when}${rule.if ? `, if ${text(rule.if)}` : ''}, ${briefs(rule.then).join(', then ')}.`;
  return capitalise(sentence);
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
