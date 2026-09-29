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
  | { not: Expr };

export type Trigger =
  /** Every day at this time — "07:00" — on the automation's own clock. */
  | { at: Expr }
  /** When the part filling a role raises an event its description declares. */
  | { event: { role: string; event: string } }
  /**
   * When a condition turns true — and, with `heldForMinutes`, has stayed true
   * that long. Reads and comparisons only: it is evaluated on every reading.
   */
  | { becomes: Expr; heldForMinutes?: Expr };

/** What a rule does. Only through the gateway. */
export type Action = {
  command: { role: string; capability: CapabilityName; command: string; args: Readonly<Record<string, Expr>> };
};

/** What the part filling a role must offer, and what it is for. */
export type RoleSpec = CapabilityNeed & { label: string; description: string };

export type Rule = {
  roles: Readonly<Record<string, RoleSpec>>;
  params: ConfigSchema;
  /** Any one of these starts a run. */
  when: readonly Trigger[];
  /** Must be true for it to act. Unknown is not true: nothing is done, and the run says why. */
  if?: Expr;
  then: readonly Action[];
};

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
 * answers in the type the capability declares — checked, so a function reads
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
  const declared = capabilitySpec(capability).queries[query];
  if (!declared) throw new Error(`${capability} has no query "${query}"`);
  const answer = await part.device.query({ part: part.part, capability, query, args });
  const checked = checkValue(declared.answer, answer);
  if (!checked.ok) throw new Error(`${part.name} answered ${capability}.${query} with something else: its answer ${checked.problem}`);
  // Checked against the declaration the type is derived from.
  return checked.value as QueryAnswer<Name, Query>;
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
    } else problems.push(`${where}: not a trigger`);
  });

  if (rule.if) {
    const got = shape(rule.if, 'if', { calls: true });
    if (!fits({ type: 'boolean' }, got)) problems.push(`if: expected a condition, got ${said(got)}`);
  }

  if (!rule.then?.length) problems.push('then: it does nothing');
  (rule.then ?? []).forEach((action, index) => {
    const where = `then[${index}].command`;
    if (!('command' in action)) {
      problems.push(`then[${index}]: not an action`);
      return;
    }
    const { command } = action;
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
  });

  return problems;
}

/** The events a role's capabilities declare: what a trigger on it can wait for before it is bound. */
export const roleEvents = (spec: CapabilityNeed): string[] =>
  [...new Set([...spec.capabilities, ...(spec.oneOf ?? [])].flatMap((name) => (isCapability(name) ? Object.keys(capabilitySpec(name).events ?? {}) : [])))];

/** Every role a rule reads, triggers on or acts through, with what it asks of it. */
function uses(rule: Rule): { reads: { role: string; means: string }[]; events: { role: string; event: string }[] } {
  const reads: { role: string; means: string }[] = [];
  const walk = (expr: Expr | undefined): void => {
    if (!expr) return;
    if ('read' in expr) reads.push(expr.read);
    else if ('call' in expr) Object.values(expr.args ?? {}).forEach(walk);
    else if ('compare' in expr) (walk(expr.left), walk(expr.right));
    else if ('all' in expr) expr.all.forEach(walk);
    else if ('any' in expr) expr.any.forEach(walk);
    else if ('not' in expr) walk(expr.not);
  };
  const events: { role: string; event: string }[] = [];
  for (const trigger of rule.when) {
    if ('at' in trigger) walk(trigger.at);
    else if ('event' in trigger) events.push(trigger.event);
    else (walk(trigger.becomes), walk(trigger.heldForMinutes));
  }
  walk(rule.if);
  for (const action of rule.then) Object.values(action.command.args).forEach(walk);
  return { reads, events };
}

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
  const { reads, events } = uses(rule);
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
export const readsRole = (rule: Rule, role: string): boolean => uses(rule).reads.some((read) => read.role === role);

// --- running a rule -----------------------------------------------------------

/** What an expression is evaluated against. */
export type RuleScope = {
  param(name: string): Value;
  /** What the part filling a role reports now for a meaning, or null when it cannot be known. */
  read(role: string, means: string): { value: ScalarValue; label: string; unit: string } | null;
  /** A function's answer; not given where calls are not allowed. */
  call?(fn: string, role: string, args: Readonly<Record<string, Value>>): Promise<Evaluation>;
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
  if ('compare' in expr) return compare(expr.compare, evaluateNow(expr.left, scope, trace), evaluateNow(expr.right, scope, trace));
  if ('all' in expr) return combine('all', expr.all.map((part) => evaluateNow(part, scope, trace)));
  if ('any' in expr) return combine('any', expr.any.map((part) => evaluateNow(part, scope, trace)));
  if ('not' in expr) {
    const value = evaluateNow(expr.not, scope, trace);
    return typeof value === 'boolean' ? !value : null;
  }
  return null; // a call: not here
}

// --- saying what it does ---------------------------------------------------------

/** A setting as it reads in a sentence: an option's label, a number with its unit. */
export function paramText(schema: ConfigSchema, name: string, value: Value): string {
  const field = schema.fields[name];
  if (value === null || value === undefined) return '…';
  if (field?.type === 'enum' && typeof value === 'string') {
    const label = enumLabel(field, value);
    // Mid-sentence: "tomorrow", not "Tomorrow" — unless it is a name or a time.
    return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  }
  if (field?.type === 'number' && typeof value === 'number') return shown(value, field.unit ?? '');
  return shown(value);
}

const OP_WORDS: Record<CompareOp, string> = { lt: 'is below', le: 'is at most', gt: 'is above', ge: 'is at least', eq: 'is', ne: 'is not' };

/**
 * How an automation reads, in one sentence: its recipe's wording with roles
 * and settings filled in, or one made from the rule itself.
 */
/** One expression of a rule, in words, with its settings filled in: "Garage station's charge is below 15 %". */
export function describeExpr(rule: Rule, expr: Expr, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  const text = (expr: Expr): string => {
    if ('value' in expr) return shown(expr.value);
    if ('param' in expr) return param(expr.param);
    if ('read' in expr) return `${name(expr.read.role)}'s ${standardMeaning(expr.read.means)?.label.toLowerCase() ?? expr.read.means}`;
    if ('call' in expr) return `${vocabulary?.fn(expr.call)?.label.toLowerCase() ?? expr.call} by ${name(expr.role)}`;
    if ('compare' in expr) return `${text(expr.left)} ${OP_WORDS[expr.compare]} ${text(expr.right)}`;
    if ('all' in expr) return expr.all.map(text).join(' and ');
    if ('any' in expr) return expr.any.map(text).join(' or ');
    return `not (${text(expr.not)})`;
  };
  return text(expr);
}

export function describeRule(rule: Rule & { sentence?: string }, params: Readonly<Record<string, Value>>, name: (role: string) => string, vocabulary?: RuleVocabulary): string {
  const param = (key: string) => paramText(rule.params, key, params[key] ?? null);
  if (rule.sentence) return rule.sentence.replace(/\{(\w+)\}/g, (_, key: string) => (key in rule.roles ? name(key) : param(key)));

  const text = (expr: Expr): string => describeExpr(rule, expr, params, name, vocabulary);
  // What can be known from the settings alone — "turn it on", not "turn it (action is on)".
  const settled: RuleScope = {
    param: (key) => {
      const field = rule.params.fields[key];
      return (params[key] ?? (field && 'default' in field ? field.default : undefined) ?? null) as Value;
    },
    read: () => null,
    name,
  };
  const minutes = (expr: Expr) => ('value' in expr ? `${text(expr)} min` : text(expr));
  const when = rule.when
    .map((trigger) =>
      'at' in trigger
        ? `at ${text(trigger.at)}`
        : 'event' in trigger
          ? `when ${name(trigger.event.role)} says "${trigger.event.event}"`
          : `when ${text(trigger.becomes)}${trigger.heldForMinutes ? ` for ${minutes(trigger.heldForMinutes)}` : ''}`
    )
    .join(', or ');
  const then = rule.then
    .map(({ command }) => {
      const args = Object.values(command.args).map((arg) => {
        const known = evaluateNow(arg, settled);
        return typeof known === 'boolean' ? (known ? 'on' : 'off') : known !== null ? shown(known) : text(arg);
      });
      return command.capability === 'switch' && command.command === 'set' ? `turn ${name(command.role)} ${args.join(' ')}` : `${command.capability}.${command.command} ${name(command.role)} (${args.join(', ')})`;
    })
    .join(', then ');
  const sentence = `${when}${rule.if ? `, if ${text(rule.if)}` : ''}, ${then}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
