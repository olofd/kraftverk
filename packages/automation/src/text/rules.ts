import { CAPABILITIES, MAIN_PART, type CapabilityName } from '@kraftverk/device-sdk';

import { WEEKDAYS, type Weekday } from '../clock.ts';
import { ruleUses } from '../reads.ts';
import { fieldValue, withField, type FieldSpec } from '../kinds/spec.ts';
import { branchesOf, STEP_KIND_ORDER, STEP_KINDS, stepSpec, type StepKind, type StepReader, type StepSpec } from '../kinds/steps.ts';
import { stepListsOf, TRIGGER_FIELDS, TRIGGER_KIND_ORDER, TRIGGER_KINDS, triggerFields } from '../kinds/triggers.ts';
import { isAutomationRole, TRIGGER_ID, type Expr, type RuleTrigger, type RoleSpec, type Rule, type Step } from '../rule.ts';
import { parseExpr, printExpr } from './expr.ts';
import { settingsFromConfig, settingsToConfig } from './settings.ts';

/*
  An automation's rule as a configuration file writes it (docs/CONFIG.md):
  its triggers under `when`, its condition as `only if`, its steps under `do`
  and `if a step fails` — each step a verb and its words, each condition an
  expression's text. Data in, data out: the YAML around it is the caller's.
  What text cannot say exactly is kept as the rule's own data in its place,
  so every rule comes back as it went: `ruleFromConfig(ruleToConfig(r))` is r.
*/

/** Where in the file something is wrong: the path to it, and how far into its text when it is an expression. */
export type Issue = { message: string; path: readonly (string | number)[]; offset?: number };

/** What fills a role, as a file names it: a device by its key and one of its parts, or another automation by its key. */
export type Use = { device: string; part: string } | { automation: string };


type Data = unknown;

type Path = readonly (string | number)[];

// --- durations ----------------------------------------------------------------------------

const DURATION = /^(-?\d+(?:\.\d+)?)\s*(s|min|h)$/;

const SECONDS = { s: 1, min: 60, h: 3600 } as const;

/** "5 s", "2 min", "1 h": the largest unit that says it whole. */
export function durationText(seconds: number): string {
  if (seconds !== 0 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds !== 0 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** A number of seconds from "5 s", "2 min", "1 h". Null for anything else — a bare number too: it says no unit. */
export function durationSeconds(data: Data): number | null {
  if (typeof data !== 'string') return null;
  const match = DURATION.exec(data.trim());
  return match ? Number(match[1]) * SECONDS[match[2] as keyof typeof SECONDS] : null;
}

// --- reading ------------------------------------------------------------------------------

/** The verbs a kind of step starts with in a file: its own words', or its first field's key. */
const verbsOf = (kind: StepKind): readonly string[] => STEP_KINDS[kind].text?.verbs ?? [STEP_KINDS[kind].fields[0]!.key];

/** Every verb a step starts with, in the editor's order. */
const STEP_VERBS = STEP_KIND_ORDER.flatMap(verbsOf);

class Reader {
  issues: Issue[] = [];

  fail(message: string, path: Path, offset?: number): never {
    this.issues.push(offset === undefined ? { message, path } : { message, path, offset });
    throw new Stop();
  }

  /**
   * A condition or value: an expression's text, a plain value, or the rule's
   * own data for it. Each number keeps the unit it is written in: the checker
   * says whether it fits what it is beside, and a run converts it.
   */
  expr(data: Data, path: Path): Expr {
    if (typeof data === 'string') {
      const parsed = parseExpr(data);
      if (!parsed.ok) return this.fail(parsed.error.message, path, parsed.error.offset);
      return parsed.expr;
    }
    if (typeof data === 'number' || typeof data === 'boolean' || data === null) return { value: data };
    if (isRecord(data)) return data as Expr;
    return this.fail('Expected an expression', path);
  }

  /**
   * A length of time — "5 s", "2 min", kept as written — or an expression for
   * one. A bare number is refused: seconds here, minutes there, it would mean
   * what it does not say.
   */
  seconds(data: Data, path: Path): Expr {
    const bare = typeof data === 'number' || (typeof data === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(data));
    if (bare) return this.fail(`A length of time says its unit: "${String(data).trim()} s", "${String(data).trim()} min" or "${String(data).trim()} h"`, path);
    return this.expr(data, path);
  }

  name(data: Data, path: Path, what: string): string {
    if (typeof data !== 'string' || !data.trim()) return this.fail(`Expected ${what}`, path);
    return data.trim();
  }

  /** Steps, each a verb and its words. */
  steps(data: Data, path: Path): Step[] {
    if (data === undefined || data === null) return [];
    if (!Array.isArray(data)) return this.fail('Expected a list of steps', path);
    // Each step read on its own: one wrong does not hide the next.
    const steps = data.map((each, index) => tryRead(this, () => this.step(each, [...path, index])));
    if (steps.some((each) => each === null)) throw new Stop();
    return steps as Step[];
  }

  step(data: Data, path: Path): Step {
    if (!isRecord(data)) return this.fail('Expected a step: a verb and what it acts on ("turn on: charger")', path);
    const kind = STEP_KIND_ORDER.find((each) => verbsOf(each).some((verb) => verb in data));
    if (!kind) return this.fail(`Not a step: ${Object.keys(data).map((key) => `"${key}"`).join(', ')}. A step starts with ${STEP_VERBS.slice(0, -1).join(', ')} or ${STEP_VERBS.at(-1)}`, path);
    const spec = STEP_KINDS[kind] as unknown as StepSpec;
    if (spec.text) return spec.text.read(data, path, this.stepReader());
    const verb = spec.fields[0]!.key;
    const keys = spec.fields.map((field) => field.key);
    for (const key of Object.keys(data)) if (!keys.includes(key)) this.fail(`"${key}" is not part of this step: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...path, key]);
    return spec.fields.reduce<Step>((step, field) => {
      if (!(field.key in data)) {
        // A list of steps not written is an empty one; anything else it needs is said.
        if (field.type.type === 'steps') return field.required ? withField(step, field, []) : step;
        return field.required ? this.fail(`"${verb}" needs "${field.key}"${field.help ? `: ${field.help.charAt(0).toLowerCase()}${field.help.slice(1).replace(/\.$/, '')}` : ''}`, path) : step;
      }
      return withField(step, field, this.field(field, data[field.key], [...path, field.key]));
    }, {} as Step);
  }

  /** The reader's tools, for a kind with words of its own. */
  private stepReader(): StepReader {
    return {
      expr: (data, path) => this.expr(data, path),
      seconds: (data, path) => this.seconds(data, path),
      name: (data, path, what) => this.name(data, path, what),
      fail: (message, path) => this.fail(message, path),
    };
  }

  triggers(data: Data, path: Path): RuleTrigger[] {
    if (data === undefined || data === null) return [];
    if (!Array.isArray(data)) return this.fail('Expected a list of what starts it', path);
    return data.map((each, index) => this.trigger(each, [...path, index]));
  }

  trigger(data: Data, path: Path): RuleTrigger {
    if (!isRecord(data)) return this.fail('Expected a trigger: at, every, event or becomes', path);
    // Its kind by its verb, and each of its fields — its kind's, and those every trigger has — by what it holds (kinds/triggers.ts).
    const kind = TRIGGER_KIND_ORDER.find((each) => each in data);
    if (!kind) return this.fail(`Not a trigger: ${Object.keys(data).map((key) => `"${key}"`).join(', ')}. A trigger is ${TRIGGER_KIND_ORDER.join(', ')}`, path);
    const fields = [...TRIGGER_KINDS[kind].fields, ...TRIGGER_FIELDS];
    const keys = fields.map((field) => field.key);
    for (const key of Object.keys(data)) if (!keys.includes(key)) this.fail(`"${key}" is not part of this trigger: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...path, key]);
    return fields.reduce<RuleTrigger>((trigger, field) => {
      if (!(field.key in data)) return field.required ? this.fail(`"${kind}" needs "${field.key}": ${field.label.toLowerCase()}`, path) : trigger;
      return withField(trigger, field, this.field(field, data[field.key], [...path, field.key]));
    }, {} as RuleTrigger);
  }

  /** One field of a construct, by what it holds (kinds/spec.ts). */
  field(field: FieldSpec, data: Data, path: Path): unknown {
    switch (field.type.type) {
      case 'condition':
      case 'value':
      case 'timeOfDay':
      case 'count':
        return this.expr(data, path);
      case 'duration':
        return this.seconds(data, path);
      case 'days':
        return this.days(data, path);
      case 'role':
      case 'automation':
      case 'event':
      case 'name':
      case 'memory':
      case 'text':
        return this.name(data, path, field.label.toLowerCase());
      case 'flag':
        if (typeof data !== 'boolean') return this.fail('Expected true or false', path);
        return data;
      case 'id':
        if (typeof data !== 'string' || !TRIGGER_ID.test(data)) return this.fail('A name of its own is letters and digits, starting with a lowercase letter: "low"', path);
        return data;
      case 'steps':
        return this.steps(data, path);
      case 'args':
        if (!isRecord(data)) return this.fail('Expected a map of arguments', path);
        return Object.fromEntries(Object.entries(data).map(([name, value]) => [name, this.expr(value, [...path, name])]));
    }
  }

  days(data: Data, path: Path): Weekday[] {
    if (data === 'weekdays') return ['mon', 'tue', 'wed', 'thu', 'fri'];
    if (data === 'weekends') return ['sat', 'sun'];
    if (!Array.isArray(data)) return this.fail('Expected days: weekdays, weekends, or a list of mon … sun', path);
    return data.map((day, index) => (WEEKDAYS.includes(day as Weekday) ? (day as Weekday) : this.fail(`"${String(day)}" is not a day: mon, tue, wed, thu, fri, sat, sun`, [...path, index])));
  }
}

class Stop extends Error {}

const isRecord = (data: Data): data is Record<string, unknown> => typeof data === 'object' && data !== null && !Array.isArray(data);

/**
 * Reads one piece of a rule — what `fn` reads from the reader — collecting
 * every problem rather than stopping at the first: each piece read on its
 * own, so one bad step does not hide the next.
 */
function tryRead<T>(reader: Reader, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Stop) return null;
    throw error;
  }
}

// --- roles --------------------------------------------------------------------------------

/** "chargerPlug" → "Charger plug", "automation1" → "Automation 1": a role's label when the file gives none. */
export function labelOf(role: string): string {
  const words = role
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a rule does with its roles, as far as inferring them goes: its triggers, its condition and its steps. */
export type RuleBody = Pick<Rule, 'when' | 'then' | 'otherwise' | 'if'>;

/**
 * The capability a standard meaning, or an event, belongs to — when it
 * belongs to one only: reading `charge` asks for a battery, reading
 * `power` for a power meter, `mains.lost` for an AC input.
 */
const CAPABILITY_OF = (() => {
  const of = new Map<string, Set<string>>();
  const add = (key: string, capability: string) => of.set(key, new Set([...(of.get(key) ?? []), capability]));
  for (const [capability, spec] of Object.entries(CAPABILITIES)) {
    for (const attribute of Object.values(spec.attributes as Record<string, { means: string }>)) add(`read:${attribute.means}`, capability);
    for (const event of Object.keys((spec as { events?: Record<string, unknown> }).events ?? {})) add(`event:${event}`, capability);
  }
  return (key: string): string | null => {
    const found = of.get(key);
    return found?.size === 1 ? [...found][0]! : null;
  };
})();

/**
 * What a role is asked for, from what the rule does with it: the commands it
 * is sent, the standard readings read from it, the events it raises.
 */
function usedCapabilities(rule: RuleBody, role: string): string[] {
  const used = new Set<string>();
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      if ('command' in step && step.command.role === role) used.add(step.command.capability);
      for (const branch of branchesOf(step)) walk(branch.steps);
    }
  };
  for (const list of stepListsOf(rule)) walk(list.steps);
  const uses = ruleUses({ roles: {}, params: { fields: {} }, when: rule.when, ...(rule.if !== undefined ? { if: rule.if } : {}), then: rule.then, ...(rule.otherwise !== undefined ? { otherwise: rule.otherwise } : {}) });
  const add = (capability: string | null) => void (capability && used.add(capability));
  for (const read of uses.reads) if (read.role === role) add(CAPABILITY_OF(`read:${read.means}`));
  for (const event of [...uses.events, ...uses.awaits]) if (event.role === role) add(CAPABILITY_OF(`event:${event.event}`));
  return [...used].sort();
}

/** A role as the file would have it said, when it says only what fills it. */
export function inferredRole(rule: RuleBody, role: string, automation: boolean): RoleSpec {
  const label = labelOf(role);
  return automation ? { automation: true, label } : { label, capabilities: usedCapabilities(rule, role) as CapabilityName[] };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** How a file names what fills a role: "garage-station.outlet.ac", "smart-plug" for a main part. */
export const useText = (use: Extract<Use, { device: string }>): string => (use.part === MAIN_PART ? use.device : `${use.device}.${use.part}`);

/** A role's filling from its text: the device's key, then its part — the main part when none is named. */
export function useOf(text: string): Extract<Use, { device: string }> | null {
  const match = /^([a-z0-9][a-z0-9-]*)(?:\.(.+))?$/.exec(text.trim());
  return match ? { device: match[1]!, part: match[2] ?? MAIN_PART } : null;
}

// --- the automation's rule, both ways ------------------------------------------------------

/** An automation's rule and what fills its roles, as a file's entry carries them. */
export type RuleEntry = {
  uses: Record<string, unknown>;
  when?: unknown;
  'only if'?: unknown;
  do?: unknown;
  'if a step fails'?: unknown;
  settings?: unknown;
  memory?: unknown;
};

/**
 * A rule and what fills its roles from a file's entry, every problem with its
 * path. `path`: where the entry is in the file.
 */
export function ruleFromConfig(entry: Record<string, unknown>, path: Path): { rule: Rule | null; uses: Record<string, Use>; issues: Issue[] } {
  const reader = new Reader();
  const when = tryRead(reader, () => reader.triggers(entry.when, [...path, 'when'])) ?? [];
  const condition = 'only if' in entry ? tryRead(reader, () => reader.expr(entry['only if'], [...path, 'only if'])) : undefined;
  const then = tryRead(reader, () => reader.steps(entry.do, [...path, 'do'])) ?? [];
  const otherwise = 'if a step fails' in entry ? tryRead(reader, () => reader.steps(entry['if a step fails'], [...path, 'if a step fails'])) : undefined;
  const params = tryRead(reader, () => settingsFromConfig(entry.settings, [...path, 'settings'], (message, at) => reader.fail(message, at))) ?? { fields: {} };
  // What it remembers: written as its settings are, each the value it starts from.
  const memory = 'memory' in entry ? tryRead(reader, () => settingsFromConfig(entry.memory, [...path, 'memory'], (message, at) => reader.fail(message, at), 'memory')) : null;

  const steps: RuleBody = { when, ...(condition !== undefined && condition !== null ? { if: condition } : {}), then, ...(otherwise !== undefined && otherwise !== null ? { otherwise } : {}) };
  const roles: Record<string, RoleSpec> = {};
  const uses: Record<string, Use> = {};
  const usesData = entry.uses ?? {};
  if (!isRecord(usesData)) reader.issues.push({ message: '"uses" is a map: each role, and what fills it', path: [...path, 'uses'] });
  else {
    for (const [role, data] of Object.entries(usesData)) {
      const at = [...path, 'uses', role];
      tryRead(reader, () => {
        // Nothing fills it yet: a rule being built, as the app's editor writes one.
        if (data === null) {
          roles[role] = inferredRole(steps, role, false);
          return;
        }
        if (typeof data === 'string') {
          const use = useOf(data);
          if (!use) return reader.fail(`"${data}" is not a device's part: "device-key" or "device-key.part"`, at);
          uses[role] = use;
          roles[role] = inferredRole(steps, role, false);
          return;
        }
        if (!isRecord(data)) return reader.fail('Expected what fills the role: "device-key.part", or { automation: key }', at);
        const automation = 'automation' in data;
        const inferred = inferredRole(steps, role, automation);
        const label = typeof data.label === 'string' ? data.label : inferred.label;
        const keys = automation ? ROLE_KEYS.automation : ROLE_KEYS.part;
        for (const key of Object.keys(data)) if (!(keys as readonly string[]).includes(key)) reader.fail(`"${key}" is not part of a role: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...at, key]);
        if (automation) {
          if (data.automation !== null) uses[role] = { automation: reader.name(data.automation, [...at, 'automation'], 'the key of the automation it starts') };
          roles[role] = { automation: true, label };
          return;
        }
        if (data.part !== null) {
          const use = useOf(reader.name(data.part, [...at, 'part'], 'the part that fills it ("part")'));
          if (!use) return reader.fail(`"${String(data.part)}" is not a device's part`, [...at, 'part']);
          uses[role] = use;
        }
        const capabilities = Array.isArray(data.needs) ? (data.needs as CapabilityName[]) : isAutomationRole(inferred) ? [] : inferred.capabilities;
        roles[role] = { label, capabilities, ...(Array.isArray(data['one of']) ? { oneOf: data['one of'] as CapabilityName[] } : {}) };
      });
    }
  }

  if (reader.issues.length) return { rule: null, uses, issues: reader.issues };
  const rule: Rule = {
    roles,
    params,
    ...(memory && Object.keys(memory.fields).length ? { memory } : {}),
    when,
    ...(condition !== undefined && condition !== null ? { if: condition } : {}),
    then,
    ...(otherwise !== undefined && otherwise !== null ? { otherwise } : {}),
  };
  return { rule, uses, issues: [] };
}

/** What a role says of itself in a file, beside what fills it. */
const ROLE_KEYS = { part: ['part', 'label', 'needs', 'one of'], automation: ['automation', 'label'] } as const satisfies Record<string, readonly string[]>;

/** Days as a file writes them: "weekdays", "weekends", or the list. (In a sentence they are `daysText`'s.) */
const daysInFile = (days: readonly string[]): string | string[] =>
  days.join() === 'mon,tue,wed,thu,fri' ? 'weekdays' : days.join() === 'sat,sun' ? 'weekends' : [...days];

/** A rule and what fills its roles as a file's entry writes them: the order a person reads in. */
export function ruleToConfig(rule: Rule, uses: Record<string, Use>): RuleEntry {
  const expr = (value: Expr): unknown => {
    if ('value' in value && value.unit === undefined && (typeof value.value === 'number' || typeof value.value === 'boolean')) return value.value;
    return printExpr(value) ?? value;
  };
  const time = (value: Expr): unknown => ('value' in value && typeof value.value === 'string' && /^\d{2}:\d{2}$/.test(value.value) ? value.value : expr(value));

  // A step by its kind's words of its own, or its fields under its verb, in its kind's order (kinds/steps.ts).
  const step = (each: Step): Record<string, unknown> => {
    const spec = stepSpec(each);
    if (spec.text) return spec.text.write(each, { expr });
    const written: Record<string, unknown> = {};
    for (const field of spec.fields) {
      const value = fieldValue(each, field);
      if (value !== undefined) written[field.key] = fieldText(field, value);
    }
    return written;
  };
  // Each of its fields by what it holds: its kind's, in their order, then those every trigger has (kinds/triggers.ts).
  const trigger = (each: RuleTrigger): Record<string, unknown> => {
    const written: Record<string, unknown> = {};
    for (const field of triggerFields(each)) {
      const value = fieldValue(each, field);
      if (value !== undefined) written[field.key] = fieldText(field, value);
    }
    return written;
  };
  const fieldText = (field: FieldSpec, value: unknown): unknown => {
    switch (field.type.type) {
      case 'condition':
      case 'value':
      case 'count':
        return expr(value as Expr);
      case 'timeOfDay':
        return time(value as Expr);
      case 'duration':
        return expr(value as Expr);
      case 'days':
        return daysInFile(value as readonly string[]);
      case 'role':
      case 'automation':
      case 'event':
      case 'name':
      case 'id':
      case 'memory':
      case 'text':
      case 'flag':
        return value;
      case 'steps':
        return (value as readonly Step[]).map(step);
      case 'args':
        return Object.fromEntries(Object.entries(value as Record<string, Expr>).map(([name, arg]) => [name, expr(arg)]));
    }
  };

  const usesOut: Record<string, unknown> = {};
  for (const [role, spec] of Object.entries(rule.roles)) {
    const use = uses[role];
    const automation = isAutomationRole(spec);
    const inferred = inferredRole(rule, role, automation);
    const extra: Record<string, unknown> = {};
    if (spec.label !== inferred.label) extra.label = spec.label;
    if (!automation && !isAutomationRole(inferred)) {
      if (!sameList(spec.capabilities, inferred.capabilities)) extra.needs = [...spec.capabilities];
      if (spec.oneOf !== undefined) extra['one of'] = [...spec.oneOf];
    }
    if (automation) usesOut[role] = { automation: use && 'automation' in use ? use.automation : null, ...extra };
    else {
      const part = use && 'device' in use ? useText(use) : null;
      usesOut[role] = Object.keys(extra).length ? { part, ...extra } : part;
    }
  }

  return {
    uses: usesOut,
    ...(Object.keys(rule.params.fields).length ? { settings: settingsToConfig(rule.params) } : {}),
    ...(rule.memory && Object.keys(rule.memory.fields).length ? { memory: settingsToConfig(rule.memory) } : {}),
    ...(rule.when.length ? { when: rule.when.map(trigger) } : {}),
    ...(rule.if !== undefined ? { 'only if': expr(rule.if) } : {}),
    do: rule.then.map(step),
    ...(rule.otherwise !== undefined ? { 'if a step fails': rule.otherwise.map(step) } : {}),
  };
}
