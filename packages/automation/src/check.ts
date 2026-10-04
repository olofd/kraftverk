import { attributeMeaning, CAMEL_NAME, capabilitySpec, checkValue, isCapability, MAIN_PART, meetsNeed, partsOf, standardMeaning, valueTypeOf, type AttributeSpec, type CapabilityId, type CapabilityNeed, type DeviceDescription, type Value, type ValueType } from '@kraftverk/device-sdk';

import { CLOCK_TIME, minutesOf, WEEKDAYS, type Weekday } from './clock.ts';
import { secondsText } from './describe.ts';
import { fieldValue, type FieldSpec } from './kinds/spec.ts';
import { TRIGGER_KIND_ORDER, TRIGGER_KINDS } from './kinds/triggers.ts';
import type { AutomationFunction } from './functions.ts';
import { ruleUses } from './reads.ts';
import { isAutomationRole, MATH_OPS, partRoles, RUN_FACTS, SEQUENCE_LIMITS, TRIGGER_ID, type Command, type Expr, type PartRole, type Rule, type Step, type WriteTarget } from './rule.ts';

/*
  Checking a rule before it runs (docs/AUTOMATIONS.md): every role, setting,
  reading, command and function it names is one there is, of the shape each
  is used as; and a rule bound to parts is checked against what fills its
  roles. Each problem in words, placed where a person finds it.
*/

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
  /** The ids its triggers carry: what `startedBy` may name. */
  const triggerIds = new Set((rule.when ?? []).flatMap((trigger) => (trigger.id ? [trigger.id] : [])));

  for (const [role, spec] of Object.entries(roles)) {
    if (!CAMEL_NAME.test(role)) problems.push(`roles.${role}: a role is named in camelCase`);
    if (role === 'run') problems.push('roles.run: "run" is what the run knows of itself — name the role otherwise');
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

  const shape = (expr: Expr, where: string, options: { calls: boolean; trigger?: boolean }): Shape => {
    if ('value' in expr) return shapeOfValue(expr.value);
    if ('run' in expr) {
      if (!RUN_FACTS.includes(expr.run)) {
        problems.push(`${where}: a run knows its ${RUN_FACTS.join(', ')} — not "${String(expr.run)}"`);
        return { type: 'unknown' };
      }
      // Before a run there is none: what starts it cannot ask what started it.
      if (options.trigger) problems.push(`${where}: run.${expr.run} is known once it runs — in what it does, not in what starts it`);
      // One of its triggers' ids: compared with any other, the comparison says so.
      return { type: 'string', options: [...triggerIds, ''] };
    }
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
          problems.push(`${where}: "${other.value}" is not one of ${side.options.length ? side.options.join(', ') : 'them: there are none'}`);
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
    if (trigger.id !== undefined) {
      if (typeof trigger.id !== 'string' || !TRIGGER_ID.test(trigger.id)) problems.push(`${where}.id: letters and digits, starting with a lowercase letter`);
      else if ((rule.when ?? []).findIndex((other) => other.id === trigger.id) !== index) problems.push(`${where}.id: "${trigger.id}" is another trigger's id too`);
    }
    // Each kind's fields, by what each holds (kinds/triggers.ts).
    const kind = TRIGGER_KIND_ORDER.find((each) => each in trigger);
    if (!kind) {
      problems.push(`${where}: not a trigger`);
      return;
    }
    for (const field of TRIGGER_KINDS[kind].fields) {
      const value = fieldValue(trigger, field);
      const at = `${where}.${field.data.join('.')}`;
      if (value === undefined || value === null) {
        if (field.required) problems.push(`${at}: it needs ${field.label.toLowerCase()}`);
        continue;
      }
      checkField(field, value, at);
    }
  });

  /** One field of a construct, held to what it holds (kinds/spec.ts). */
  function checkField(field: FieldSpec, value: unknown, at: string): void {
    const type = field.type;
    switch (type.type) {
      case 'condition': {
        const got = shape(value as Expr, at, { calls: false, trigger: true });
        if (!fits({ type: 'boolean' }, got)) problems.push(`${at}: expected a condition, got ${said(got)}`);
        return;
      }
      case 'timeOfDay': {
        const expr = value as Expr;
        const got = shape(expr, at, { calls: false, trigger: true });
        if (!fits({ type: 'string', options: null }, got)) problems.push(`${at}: expected a time of day, got ${said(got)}`);
        if ('value' in expr && (typeof expr.value !== 'string' || !CLOCK_TIME.test(expr.value))) problems.push(`${at}: a time of day is "HH:MM"`);
        return;
      }
      case 'duration': {
        const expr = value as Expr;
        const got = shape(expr, at, { calls: false, trigger: true });
        if (!fits({ type: 'number', unit: 's' }, got)) problems.push(`${at}: expected a length of time, got ${said(got)}`);
        const seconds = 'value' in expr ? expr.value : null;
        const whole = type.step ? `, in steps of ${secondsText(type.step)}` : '';
        if (typeof seconds === 'number' && (seconds < type.min || seconds > type.max || (type.step !== undefined && seconds % type.step !== 0))) {
          problems.push(`${at}: from ${secondsText(type.min)} to ${secondsText(type.max)}${whole}`);
        }
        return;
      }
      case 'days': {
        const days = value as readonly string[];
        if (!Array.isArray(days) || !days.length) problems.push(`${at}: on no day, it never runs`);
        else {
          for (const day of days) if (!WEEKDAYS.includes(day as Weekday)) problems.push(`${at}: "${String(day)}" is not a day of the week`);
          if (new Set(days).size !== days.length) problems.push(`${at}: a day is named twice`);
        }
        return;
      }
      case 'role':
        role(String(value), at);
        return;
      case 'event':
        if (!String(value).trim()) problems.push(`${at}: which event?`);
        return;
    }
  }

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

/** Which part of an automation a problem is in, as an editor groups them: what it uses, what starts it, its condition, its steps, its fallback — or the whole. */
export type ProblemArea = 'uses' | 'when' | 'onlyIf' | 'does' | 'fails' | 'other';

/** Which part of a rule a problem `checkRule` found is in, from its path: "when[0].days" a trigger, "then[2]…" a step. */
export function problemArea(problem: string): ProblemArea {
  const path = problem.slice(0, Math.max(0, problem.indexOf(': ')));
  if (/^roles\./.test(path)) return 'uses';
  if (/^when\b/.test(path)) return 'when';
  if (/^if\b/.test(path)) return 'onlyIf';
  if (/^then\b/.test(path)) return 'does';
  if (/^otherwise\b/.test(path)) return 'fails';
  return 'other';
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
