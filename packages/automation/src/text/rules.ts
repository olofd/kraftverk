import { CAPABILITIES, MAIN_PART, standardMeaning, type CapabilityName } from '@kraftverk/device-sdk';

import { WEEKDAYS, type Weekday } from '../clock.ts';
import { ruleUses } from '../reads.ts';
import { isAutomationRole, type Expr, type RoleSpec, type Rule, type Step, type Trigger } from '../rule.ts';
import { parseExpr, printExpr, type PrintContext, type WrittenUnit } from './expr.ts';

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

// --- units ----------------------------------------------------------------------------------

/** Units of one quantity, each by how many of the first it is. */
const UNIT_FAMILIES: readonly Readonly<Record<string, number>>[] = [
  { W: 1, kW: 1000, MW: 1_000_000 },
  { Wh: 1, kWh: 1000, MWh: 1_000_000 },
  { A: 1, mA: 0.001 },
  { V: 1, mV: 0.001, kV: 1000 },
  { Hz: 1, kHz: 1000 },
  { s: 1, min: 60, h: 3600 },
];

/** What a number written in one unit is multiplied by to be in another: 1 when the same, null when they are not one quantity's. */
function conversion(written: string, into: string): number | null {
  if (written === into) return 1;
  const family = UNIT_FAMILIES.find((units) => written in units && into in units);
  return family ? family[written]! / family[into]! : null;
}

/** A converted number without the float's dust: 2.2 kW is 2200 W, not 2200.0000000000005. */
const round = (value: number) => Math.round(value * 1e9) / 1e9;

/** The unit a standard meaning's readings are in — none for one that may be in several (a price's currency). */
function standardUnit(means: string): string | null {
  const meaning = standardMeaning(means);
  return meaning && meaning.type === 'number' && !meaning.units?.length ? meaning.unit : null;
}

// --- reading ------------------------------------------------------------------------------

class Reader {
  issues: Issue[] = [];
  constructor(private context: PrintContext = {}) {}

  fail(message: string, path: Path, offset?: number): never {
    this.issues.push(offset === undefined ? { message, path } : { message, path, offset });
    throw new Stop();
  }

  /** A condition or value: an expression's text, a plain value, or the rule's own data for it. */
  expr(data: Data, path: Path): Expr {
    if (typeof data === 'string') {
      const parsed = parseExpr(data);
      if (!parsed.ok) this.fail(parsed.error.message, path, parsed.error.offset);
      return this.inUnits(parsed.expr, parsed.units, path);
    }
    if (typeof data === 'number' || typeof data === 'boolean' || data === null) return { value: data };
    if (isRecord(data)) return data as Expr;
    return this.fail('Expected an expression', path);
  }

  /**
   * Each number written with a unit, in the unit of what it is beside: "2 kW"
   * beside a reading in W is 2000; "50 °C" beside one is a problem, where it
   * is. What a reading is in is the part's own word (the context), or its
   * standard meaning's; beside nothing that says one, a number is kept as
   * written.
   */
  private inUnits(expr: Expr, units: WeakMap<Expr, WrittenUnit>, path: Path): Expr {
    const unitOfReading = (each: Expr): string | null =>
      'read' in each ? (this.context.unitOf?.(each.read.role, each.read.means) ?? standardUnit(each.read.means)) : 'math' in each ? (unitOfReading(each.left) ?? unitOfReading(each.right)) : null;
    const visit = (each: Expr, beside: string | null): Expr => {
      if ('value' in each) {
        const written = units.get(each);
        if (!written || beside === null || typeof each.value !== 'number') return each;
        const factor = conversion(written.unit, beside);
        if (factor === null) return this.fail(`That is read in ${beside || 'no unit'}: "${written.unit}" is not ${beside ? `a unit of it` : 'one'}`, path, written.at);
        return { value: round(each.value * factor) };
      }
      if ('compare' in each) {
        const unit = unitOfReading(each.left) ?? unitOfReading(each.right);
        return { ...each, left: visit(each.left, unit), right: visit(each.right, unit) };
      }
      if ('math' in each) {
        const unit = beside ?? unitOfReading(each);
        return { ...each, left: visit(each.left, unit), right: visit(each.right, unit) };
      }
      if ('all' in each) return { all: each.all.map((one) => visit(one, null)) };
      if ('any' in each) return { any: each.any.map((one) => visit(one, null)) };
      if ('not' in each) return { not: visit(each.not, null) };
      return each;
    };
    return visit(expr, null);
  }

  /** A length of time, in seconds — "5 s", "2 min" — or an expression for one. A bare number is refused: seconds here, minutes there, it would mean what it does not say. */
  seconds(data: Data, path: Path): Expr {
    const seconds = durationSeconds(data);
    if (seconds !== null) return { value: seconds };
    return this.lengthOfTime(data, path);
  }

  /** A length of time the rule keeps in minutes: "2 min", "90 s". */
  minutes(data: Data, path: Path): Expr {
    const seconds = durationSeconds(data);
    if (seconds !== null) return { value: seconds / 60 };
    return this.lengthOfTime(data, path);
  }

  /** A length of time that is not "5 s": an expression for one — never a bare number, which says no unit. */
  private lengthOfTime(data: Data, path: Path): Expr {
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
    const has = (key: string) => key in data;
    const only = (...keys: string[]) => {
      for (const key of Object.keys(data)) if (!keys.includes(key)) this.fail(`"${key}" is not part of this step: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...path, key]);
    };
    if (has('turn on') || has('turn off')) {
      const on = has('turn on');
      only(on ? 'turn on' : 'turn off');
      const role = this.name(data[on ? 'turn on' : 'turn off'], [...path, on ? 'turn on' : 'turn off'], 'the role it turns');
      return { command: { role, capability: 'switch', command: 'set', args: { on: { value: on } } } };
    }
    if (has('switch')) {
      only('switch', 'on');
      if (!has('on')) this.fail('"switch" needs "on": when it is on', path);
      return { command: { role: this.name(data.switch, [...path, 'switch'], 'the role it switches'), capability: 'switch', command: 'set', args: { on: this.expr(data.on, [...path, 'on']) } } };
    }
    if (has('send')) {
      only('send', 'to', 'capability', 'with');
      const args = data.with === undefined ? {} : isRecord(data.with) ? data.with : this.fail('"with" is a map of arguments', [...path, 'with']);
      return {
        command: {
          role: this.name(data.to, [...path, 'to'], 'the role it is sent to ("to")'),
          capability: this.name(data.capability, [...path, 'capability'], 'the capability ("capability")') as CapabilityName,
          command: this.name(data.send, [...path, 'send'], 'the command'),
          args: Object.fromEntries(Object.entries(args).map(([name, value]) => [name, this.expr(value, [...path, 'with', name])])),
        },
      };
    }
    if (has('set')) {
      only('set', 'setting', 'meaning', 'to');
      const role = this.name(data.set, [...path, 'set'], 'the role whose setting it changes');
      if (!has('to')) this.fail('"set" needs "to": what it is set to', path);
      const value = this.expr(data.to, [...path, 'to']);
      if (has('setting') === has('meaning')) this.fail('"set" names its setting by key ("setting") or by what it means ("meaning"), one of them', path);
      return has('setting')
        ? { write: { role, key: this.name(data.setting, [...path, 'setting'], 'the setting\'s key'), value } }
        : { write: { role, means: this.name(data.meaning, [...path, 'meaning'], 'what the setting means'), value } };
    }
    if (has('wait until')) {
      only('wait until', 'at most');
      if (!has('at most')) this.fail('"wait until" needs "at most": every wait has its limit', path);
      return { waitUntil: { condition: this.expr(data['wait until'], [...path, 'wait until']), atMostSeconds: this.seconds(data['at most'], [...path, 'at most']) } };
    }
    if (has('wait')) {
      only('wait');
      return { wait: { seconds: this.seconds(data.wait, [...path, 'wait']) } };
    }
    if (has('make sure')) {
      only('make sure', 'within', 'tries', 'each time');
      for (const key of ['within', 'tries']) if (!has(key)) this.fail(`"make sure" needs "${key}"`, path);
      return {
        ensure: {
          condition: this.expr(data['make sure'], [...path, 'make sure']),
          withinSeconds: this.seconds(data.within, [...path, 'within']),
          tries: this.expr(data.tries, [...path, 'tries']),
          retry: this.steps(data['each time'], [...path, 'each time']),
        },
      };
    }
    if (has('if')) {
      only('if', 'then', 'else');
      const step: Extract<Step, { choose: unknown }> = { choose: { if: this.expr(data.if, [...path, 'if']), then: this.steps(data.then, [...path, 'then']) } };
      if (has('else')) return { choose: { ...step.choose, else: this.steps(data.else, [...path, 'else']) } };
      return step;
    }
    if (has('watch')) {
      only('watch', 'for', 'if it stays so', 'if not');
      if (!has('for')) this.fail('"watch" needs "for": how long it watches', path);
      return {
        watch: {
          condition: this.expr(data.watch, [...path, 'watch']),
          seconds: this.seconds(data.for, [...path, 'for']),
          ...(has('if it stays so') ? { then: this.steps(data['if it stays so'], [...path, 'if it stays so']) } : {}),
          ...(has('if not') ? { else: this.steps(data['if not'], [...path, 'if not']) } : {}),
        },
      };
    }
    if (has('start')) {
      only('start', 'and wait');
      const role = this.name(data.start, [...path, 'start'], 'the role of the automation it starts');
      return has('and wait') ? { start: { role, waitSeconds: this.seconds(data['and wait'], [...path, 'and wait']) } } : { start: { role } };
    }
    return this.fail(`Not a step: ${Object.keys(data).map((key) => `"${key}"`).join(', ')}. A step starts with turn on, turn off, switch, send, set, wait, wait until, make sure, if, watch or start`, path);
  }

  triggers(data: Data, path: Path): Trigger[] {
    if (data === undefined || data === null) return [];
    if (!Array.isArray(data)) return this.fail('Expected a list of what starts it', path);
    return data.map((each, index) => this.trigger(each, [...path, index]));
  }

  trigger(data: Data, path: Path): Trigger {
    if (!isRecord(data)) return this.fail('Expected a trigger: at, every, event or becomes', path);
    const only = (...keys: string[]) => {
      for (const key of Object.keys(data)) if (!keys.includes(key)) this.fail(`"${key}" is not part of this trigger: it takes ${keys.map((each) => `"${each}"`).join(', ')}`, [...path, key]);
    };
    if ('at' in data) {
      only('at', 'days');
      const at = this.expr(data.at, [...path, 'at']);
      return 'days' in data ? { at, days: this.days(data.days, [...path, 'days']) } : { at };
    }
    if ('every' in data) {
      only('every');
      return { every: this.minutes(data.every, [...path, 'every']) };
    }
    if ('event' in data) {
      only('event', 'from');
      return { event: { role: this.name(data.from, [...path, 'from'], 'the role it comes from ("from")'), event: this.name(data.event, [...path, 'event'], 'the event') } };
    }
    if ('becomes' in data) {
      only('becomes', 'for');
      const becomes = this.expr(data.becomes, [...path, 'becomes']);
      return 'for' in data ? { becomes, heldForMinutes: this.minutes(data.for, [...path, 'for']) } : { becomes };
    }
    return this.fail(`Not a trigger: ${Object.keys(data).map((key) => `"${key}"`).join(', ')}. A trigger is at, every, event or becomes`, path);
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

/** What a rule's own steps ask of a role's part: the capabilities its commands use. */
/** What a rule does with its roles, as far as inferring them goes: its triggers, its condition and its steps. */
export type RuleBody = Pick<Rule, 'when' | 'then' | 'otherwise' | 'if'>;

/**
 * The capability a standard meaning, or an event, belongs to — when it
 * belongs to one only: reading `battery.soc` asks for a battery, reading
 * `power.draw` for a power meter, `mains.lost` for an AC input.
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
      if ('ensure' in step) walk(step.ensure.retry);
      if ('choose' in step) (walk(step.choose.then), walk(step.choose.else ?? []));
      if ('watch' in step) (walk(step.watch.then ?? []), walk(step.watch.else ?? []));
    }
  };
  walk(rule.then);
  walk(rule.otherwise ?? []);
  const uses = ruleUses({ roles: {}, params: { fields: {} }, when: rule.when, ...(rule.if !== undefined ? { if: rule.if } : {}), then: rule.then, ...(rule.otherwise !== undefined ? { otherwise: rule.otherwise } : {}) });
  const add = (capability: string | null) => void (capability && used.add(capability));
  for (const read of uses.reads) if (read.role === role) add(CAPABILITY_OF(`read:${read.means}`));
  for (const event of uses.events) if (event.role === role) add(CAPABILITY_OF(`event:${event.event}`));
  return [...used].sort();
}

/** A role as the file would have it said, when it says only what fills it. */
export function inferredRole(rule: RuleBody, role: string, automation: boolean): RoleSpec {
  const label = labelOf(role);
  return automation ? { automation: true, label, description: label } : { label, description: label, capabilities: usedCapabilities(rule, role) as CapabilityName[] };
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
  params?: unknown;
};

/**
 * A rule and what fills its roles from a file's entry, every problem with its
 * path. `path`: where the entry is in the file.
 */
export function ruleFromConfig(entry: Record<string, unknown>, path: Path, context: PrintContext = {}): { rule: Rule | null; uses: Record<string, Use>; issues: Issue[] } {
  const reader = new Reader(context);
  const when = tryRead(reader, () => reader.triggers(entry.when, [...path, 'when'])) ?? [];
  const condition = 'only if' in entry ? tryRead(reader, () => reader.expr(entry['only if'], [...path, 'only if'])) : undefined;
  const then = tryRead(reader, () => reader.steps(entry.do, [...path, 'do'])) ?? [];
  const otherwise = 'if a step fails' in entry ? tryRead(reader, () => reader.steps(entry['if a step fails'], [...path, 'if a step fails'])) : undefined;
  const params = 'params' in entry && isRecord(entry.params) ? (entry.params as Rule['params']) : { fields: {} };

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
        const description = typeof data.description === 'string' ? data.description : label;
        if (automation) {
          if (data.automation !== null) uses[role] = { automation: reader.name(data.automation, [...at, 'automation'], 'the key of the automation it starts') };
          roles[role] = { automation: true, label, description };
          return;
        }
        if (data.part !== null) {
          const use = useOf(reader.name(data.part, [...at, 'part'], 'the part that fills it ("part")'));
          if (!use) return reader.fail(`"${String(data.part)}" is not a device's part`, [...at, 'part']);
          uses[role] = use;
        }
        const capabilities = Array.isArray(data.needs) ? (data.needs as CapabilityName[]) : isAutomationRole(inferred) ? [] : inferred.capabilities;
        roles[role] = { label, description, capabilities, ...(Array.isArray(data['one of']) ? { oneOf: data['one of'] as CapabilityName[] } : {}) };
      });
    }
  }

  if (reader.issues.length) return { rule: null, uses, issues: reader.issues };
  const rule: Rule = { roles, params, when, ...(condition !== undefined && condition !== null ? { if: condition } : {}), then, ...(otherwise !== undefined && otherwise !== null ? { otherwise } : {}) };
  return { rule, uses, issues: [] };
}

/** A rule and what fills its roles as a file's entry writes them: the order a person reads in. */
/** Days as a person says them: "weekdays", "weekends", or the list. */
const daysText = (days: readonly string[]): string | string[] =>
  days.join() === 'mon,tue,wed,thu,fri' ? 'weekdays' : days.join() === 'sat,sun' ? 'weekends' : [...days];

export function ruleToConfig(rule: Rule, uses: Record<string, Use>, context: PrintContext = {}): RuleEntry {
  const expr = (value: Expr): unknown => {
    if ('value' in value && (typeof value.value === 'number' || typeof value.value === 'boolean')) return value.value;
    return printExpr(value, context) ?? value;
  };
  const seconds = (value: Expr): unknown => ('value' in value && typeof value.value === 'number' ? durationText(value.value) : expr(value));
  const minutes = (value: Expr): unknown => ('value' in value && typeof value.value === 'number' && Number.isInteger(value.value * 60) ? durationText(value.value * 60) : expr(value));
  const time = (value: Expr): unknown => ('value' in value && typeof value.value === 'string' && /^\d{2}:\d{2}$/.test(value.value) ? value.value : expr(value));

  const step = (each: Step): Record<string, unknown> => {
    if ('command' in each) {
      const { role, capability, command, args } = each.command;
      const names = Object.keys(args);
      if (capability === 'switch' && command === 'set' && names.length === 1 && names[0] === 'on') {
        const on = args.on!;
        if ('value' in on && typeof on.value === 'boolean') return on.value ? { 'turn on': role } : { 'turn off': role };
        return { switch: role, on: expr(on) };
      }
      return { send: command, to: role, capability, ...(names.length ? { with: Object.fromEntries(Object.entries(args).map(([name, value]) => [name, expr(value)])) } : {}) };
    }
    if ('write' in each) {
      const { role, value } = each.write;
      return 'key' in each.write && each.write.key !== undefined ? { set: role, setting: each.write.key, to: expr(value) } : { set: role, meaning: each.write.means, to: expr(value) };
    }
    if ('wait' in each) return { wait: seconds(each.wait.seconds) };
    if ('waitUntil' in each) return { 'wait until': expr(each.waitUntil.condition), 'at most': seconds(each.waitUntil.atMostSeconds) };
    if ('ensure' in each) {
      const { condition, withinSeconds, tries, retry } = each.ensure;
      return { 'make sure': expr(condition), within: seconds(withinSeconds), tries: expr(tries), 'each time': retry.map(step) };
    }
    if ('choose' in each) return { if: expr(each.choose.if), then: each.choose.then.map(step), ...(each.choose.else !== undefined ? { else: each.choose.else.map(step) } : {}) };
    if ('watch' in each) {
      const { condition, seconds: forSeconds, then, else: otherwise } = each.watch;
      return { watch: expr(condition), for: seconds(forSeconds), ...(then !== undefined ? { 'if it stays so': then.map(step) } : {}), ...(otherwise !== undefined ? { 'if not': otherwise.map(step) } : {}) };
    }
    return each.start.waitSeconds !== undefined ? { start: each.start.role, 'and wait': seconds(each.start.waitSeconds) } : { start: each.start.role };
  };
  const trigger = (each: Trigger): Record<string, unknown> => {
    if ('at' in each) return each.days ? { at: time(each.at), days: daysText(each.days) } : { at: time(each.at) };
    if ('every' in each) return { every: minutes(each.every) };
    if ('event' in each) return { event: each.event.event, from: each.event.role };
    return each.heldForMinutes !== undefined ? { becomes: expr(each.becomes), for: minutes(each.heldForMinutes) } : { becomes: expr(each.becomes) };
  };

  const usesOut: Record<string, unknown> = {};
  for (const [role, spec] of Object.entries(rule.roles)) {
    const use = uses[role];
    const automation = isAutomationRole(spec);
    const inferred = inferredRole(rule, role, automation);
    const extra: Record<string, unknown> = {};
    if (spec.label !== inferred.label) extra.label = spec.label;
    if (spec.description !== spec.label) extra.description = spec.description;
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
    ...(rule.when.length ? { when: rule.when.map(trigger) } : {}),
    ...(rule.if !== undefined ? { 'only if': expr(rule.if) } : {}),
    do: rule.then.map(step),
    ...(rule.otherwise !== undefined ? { 'if a step fails': rule.otherwise.map(step) } : {}),
    ...(Object.keys(rule.params.fields).length ? { params: rule.params } : {}),
  };
}
