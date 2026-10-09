import type { ConditionState } from '@kraftverk/api-contract';
import {
  bindingsOf,
  capitalise,
  describeTriggers,
  edgeOf,
  isGroupRole,
  isPeopleRole,
  isPersonRole,
  isPlaceRole,
  memberRole,
  OWN_HOME,
  sunTimes,
  type HistoryPoint,
  groupRoles,
  listed,
  memoryOf,
  settingOf,
  checkBinding,
  describeExpr,
  describeSteps,
  evaluateNow,
  measure,
  numberIn,
  secondsNow,
  isAutomationRole,
  partRoles,
  secondsText,
  triggerKey,
  triggerOf,
  writtenAttribute,
  type BoundPart,
  type Command,
  type Expr,
  type RoleBinding,
  type Rule,
  type RuleScope,
  type RuleTrigger,
  type RuleVocabulary,
  type RuleSteps,
  type Step,
  type Write,
} from '@kraftverk/automation';
import { attributeMeaning, capabilityIn, clockTime, isUnit, localTime, MAIN_PART, isCurrent, isPosition, isScalar, readingOf, REAL_CLOCK, standardMeaning, unitIn, type CapabilityName, type Clock, type Value } from '@kraftverk/device-sdk';

import type { AutomationEngineDeps, AutomationRecord, EngineDevice, EnginePlace } from './model.ts';
import { quoted } from './words.ts';

/*
  An automation's rule seen against the parts filling its roles, as every
  part of the engine reads it: what it is evaluated against, its words with
  their names, how each condition stands, why it cannot run as it is bound,
  and what a rule of commands and settings alone would change.
*/

/** One action a run would take: the command, its arguments evaluated, and how it reads. */
export type PlannedAction = { binding: RoleBinding; role: string; name: string; capability: CapabilityName; command: string; args: Record<string, Value>; what: string };

/** A setting a run would change, its value evaluated. */
export type PlannedWrite = { binding: RoleBinding; key: string; value: Value };

/** What a rule of commands and settings alone would change: a command, or a setting. */
export type Planned = { command: PlannedAction } | { write: PlannedWrite };

/** What the context reads: the automations, the installed functions, the parts, and the clock. */
export type ContextDeps = Pick<AutomationEngineDeps, 'store' | 'library' | 'device' | 'clock' | 'history' | 'location' | 'world' | 'scripts'>;

/**
 * What happened that started a run: the event a device raised — its id, and
 * what it carried — or someone arriving or leaving, by their id (`who`).
 */
/**
 * What started a run, beyond its trigger: an event a device raised and what
 * it carried; who arrived or left; and, a mode set by automations, which —
 * what keeps two from setting it back and forth for ever.
 */
export type StartingEvent = {
  id: string;
  data: Readonly<Record<string, Value>> | null;
  who?: string;
  cause?: readonly string[];
  /** What a change started it from, and to, in its unit (`changes`). */
  from?: { value: Value; unit: string | null };
  to?: { value: Value; unit: string | null };
};

export class RuleContext {
  constructor(private deps: ContextDeps) {}

  /**
   * What a run started by hand counts as started by, by its key: the first
   * of its conditions that holds now, holds aside — "do what you would do
   * now", its steps the ones that trigger has. Null when none does.
   */
  startedByNow(automation: AutomationRecord, rule: Rule): string | null {
    const scope = this.scope(automation, rule);
    const index = rule.when.findIndex((trigger) => {
      const edge = edgeOf(trigger);
      return edge !== null && evaluateNow(edge.condition, scope) === true;
    });
    return index < 0 ? null : triggerKey(rule.when[index]!, index);
  }

  /**
   * What a rule is evaluated against: its settings, the parts filling its
   * roles as they are now, and the trigger that started the run, by its
   * key, if one did.
   */
  scope(automation: AutomationRecord, rule: Rule, now = this.now(), trigger: string | null = null, event: StartingEvent | null = null, inputs: Readonly<Record<string, Value>> = {}): RuleScope {
    const part = (role: string): EngineDevice | null => {
      const binding = automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      return device && !device.removed ? device : null;
    };
    const world = this.deps.world;
    /** The place a name is: the automation's own home, or what fills a role a place fills. */
    const placeOf = (name: string): EnginePlace | null => {
      if (name === OWN_HOME) {
        const id = world?.home(automation.homeId) ?? null;
        return id ? { id, kind: 'home' } : null;
      }
      const fill = automation.world[name];
      return fill && 'place' in fill ? { id: fill.place, kind: fill.kind } : null;
    };
    /** The people a role is, by id: one, some, or everyone now. */
    const peopleOf = (name: string): readonly string[] | null => {
      const fill = automation.world[name];
      if (!fill) return null;
      if ('person' in fill) return [fill.person];
      if ('people' in fill) return fill.people;
      if ('everyone' in fill) return world?.members() ?? null;
      return null;
    };
    /** What is so of a place now, as a reading says it. */
    const placeFact = (name: string, fact: string): { value: string | number | boolean; label: string; unit: null } | null => {
      const place = placeOf(name);
      if (!place || !world) return null;
      if (fact === 'people') {
        // Someone who shares too little to say might be there: how many cannot be told.
        const there = world.whoAt(place);
        return there && !there.unknown.length ? { value: there.at.length, label: 'People there', unit: null } : null;
      }
      if (fact === 'occupied') {
        const occupied = world.occupied(place);
        return occupied === null ? null : { value: occupied, label: 'Someone there', unit: null };
      }
      if (fact === 'presence' || fact === 'day') {
        const home = world.homeOf(place);
        const mode = home ? world.mode(home, fact) : null;
        return mode === null ? null : { value: mode, label: fact === 'day' ? 'Time of day' : 'Mode', unit: null };
      }
      return null;
    };
    /** One of a home's variables now: of its own home, or the one a role names — with its unit and title. */
    const variableNow = (at: string, key: string) => {
      const place = placeOf(at);
      const homeId = place && world ? world.homeOf(place) : null;
      const spec = homeId && world ? world.variables(homeId).find((each) => each.key === key) : undefined;
      if (!homeId || !world || !spec) return null;
      const value = world.variable(homeId, key);
      return { value: value as string | number | boolean | null, unit: spec.field.type === 'number' && spec.field.unit && isUnit(spec.field.unit) ? spec.field.unit : null, label: spec.field.title };
    };
    return {
      variable: variableNow,
      clock: () => clockTime(now, automation.timeZone),
      // No trigger with an id started it: that is known, and said as no id at all.
      run: (fact, field) => {
        if (fact === 'trigger') return { value: triggerOf(rule, trigger)?.id ?? '', unit: null };
        // What a change was from, and became, in its unit: unknown when no change started it.
        if (fact === 'from' || fact === 'to') {
          const end = event?.[fact];
          return end ? { value: end.value as string | number | boolean | null, unit: end.unit && isUnit(end.unit) ? end.unit : null } : { value: null, unit: null };
        }
        // Who arriving or leaving started it, by name; "" when nobody did.
        if (fact === 'who') return { value: event?.who ? (world?.personName(event.who) ?? 'someone') : '', unit: null };
        // The event that started it, and what it carried; unknown when none did.
        if (!event || !event.id) return { value: null, unit: null };
        if (field === undefined) return { value: event.id, unit: null };
        // What it carried, in the unit its device declares for it: a voltage in V is never taken for kV.
        const started = triggerOf(rule, trigger);
        const from = started && 'event' in started ? part(started.event.role) : null;
        const declared = from?.description.events?.find((each) => each.id === event.id && (each.part ?? MAIN_PART) === from.part)?.data?.[field];
        return { value: event.data?.[field] ?? null, unit: declared?.type === 'number' ? (declared.unit ?? null) : null };
      },
      // Its settings, as it runs with them: each its value, in its unit.
      param: (name) => settingOf(rule.params, name),
      // What it was given — or, not given, its default — in its unit.
      input: (name) => settingOf(rule.inputs ?? { fields: {} }, name, inputs[name]),
      // What it remembers: as a run last left it, or as it starts.
      memory: (name) => memoryOf(rule.memory ?? { fields: {} }, name, this.deps.store.memory(automation.id)[name]),
      read: (role, means) => {
        // A place: how many of the family are there, whether anyone is, its modes.
        const spec = rule.roles[role];
        if (role === OWN_HOME || (spec && isPlaceRole(spec))) return placeFact(role, means);
        const device = part(role);
        const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
        const reading = device?.device && attribute ? readingOf(device.device.readings(), attribute.key) : null;
        // What it reports now: a reading past how long it stays current is not known, and neither is structure.
        if (!attribute || !reading || !isCurrent(attribute, reading, now.getTime()) || !isScalar(reading.value)) return null;
        return { value: reading.value, label: standardMeaning(means)?.label ?? attribute.label, unit: unitIn(attribute) };
      },
      // Where it is now: a position it reports and still current, as its meaning's shape says.
      position: (role, means) => {
        const device = part(role);
        const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
        const reading = device?.device && attribute ? readingOf(device.device.readings(), attribute.key) : null;
        if (!attribute || !reading || !isCurrent(attribute, reading, now.getTime()) || !isPosition(reading.value)) return null;
        return { position: reading.value, label: standardMeaning(means)?.label ?? attribute.label };
      },
      // Where the home is, when it has said.
      home: () => this.deps.location?.(automation.homeId) ?? null,
      // What the home kept of a reading: the value holding as the time began, each kept since, and the reading now — each a number.
      history: (role, means, seconds) => {
        const binding = automation.roles[role];
        const device = part(role);
        const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
        if (!binding || !device || !attribute || !this.deps.history) return null;
        const to = now.getTime();
        const from = to - seconds * 1000;
        const iso = (ms: number) => new Date(ms).toISOString();
        const before = this.deps.history.at(binding.device, attribute.key, iso(from));
        const points: HistoryPoint[] = [
          ...(before ? [{ at: from, value: before.value }] : []),
          ...this.deps.history.samples(binding.device, attribute.key, iso(from), iso(to)).map((sample) => ({ at: Date.parse(sample.at), value: sample.value })),
        ].filter((point): point is HistoryPoint => typeof point.value === 'number' && Number.isFinite(point.value));
        const reading = device.device ? readingOf(device.device.readings(), attribute.key) : null;
        if (reading && typeof reading.value === 'number' && isCurrent(attribute, reading, to)) points.push({ at: Math.max(Date.parse(reading.at), points.at(-1)?.at ?? from), value: reading.value });
        return points.length ? { points, from, to, unit: unitIn(attribute), label: standardMeaning(means)?.label ?? attribute.label } : null;
      },
      // Whether a person is at a place now, as far as they share.
      presentAt: (who, place) => {
        const fill = automation.world[who];
        const at = placeOf(place);
        const there = at && world ? world.whoAt(at) : null;
        if (!fill || !('person' in fill) || !there) return null;
        return there.at.includes(fill.person) ? true : there.unknown.includes(fill.person) ? null : false;
      },
      // Each part of a group — or each of several people: what an expression is evaluated against for it, it called as its name says.
      members: (group, as) => {
        const spec = rule.roles[group];
        if (spec && isPeopleRole(spec)) {
          const people = peopleOf(group);
          if (!people) return null;
          return people.map((person) => this.scope({ ...automation, world: { ...automation.world, [as]: { person } } }, { ...rule, roles: { ...rule.roles, [as]: { person: true, label: as } } }, now, trigger, event, inputs));
        }
        const parts = automation.groups[group];
        if (!spec || !isGroupRole(spec) || !parts) return null;
        const one = memberRole(spec);
        return parts.map((binding) => this.scope({ ...automation, roles: { ...automation.roles, [as]: binding } }, { ...rule, roles: { ...rule.roles, [as]: one } }, now, trigger, event));
      },
      // Today's, on the automation's clock, where the home is — moved as it says.
      sun: (event, offset) => {
        const location = this.deps.location?.(automation.homeId) ?? null;
        if (!location) return null;
        const today = localTime(now, automation.timeZone);
        const at = sunTimes({ year: today.year, month: today.month, day: today.day }, location)[event];
        return at === null ? null : clockTime(new Date(at + offset * 1000), automation.timeZone);
      },
      reachable: (role) => {
        const device = part(role);
        return device ? device.reachable() : { reachable: false, detail: `${rule.roles[role]?.label ?? role}: no device` };
      },
      script: (role, fn, args) => {
        const id = automation.scripts[role];
        if (!this.deps.scripts) return { value: null, detail: 'no engine runs scripts here' };
        if (!id) return { value: null, detail: 'no script fills it' };
        return this.deps.scripts.fn(id, fn, args);
      },
      call: async (id, role, args) => {
        const fn = this.deps.library.fn(id);
        const device = part(role);
        if (!fn) return { value: null, detail: `No installed package offers ${id}` };
        if (!device) return { value: null, detail: `${rule.roles[role]?.label ?? role}: no device` };
        return fn.evaluate({ part: device, args, now, timeZone: automation.timeZone });
      },
      name: (role) => {
        // A place, a person, people: as the family calls them.
        if (role === OWN_HOME) {
          const home = placeOf(OWN_HOME);
          return (home && world?.placeName(home)) ?? 'home';
        }
        const fill = automation.world[role];
        if (fill) {
          if ('place' in fill) return world?.placeName({ id: fill.place, kind: fill.kind }) ?? 'a place no longer there';
          if ('everyone' in fill) return 'everyone';
          return listed((peopleOf(role) ?? []).map((id) => world?.personName(id) ?? 'someone')) || 'nobody';
        }
        const started = automation.starts[role];
        if (started) return quoted(this.deps.store.get(started)?.name ?? null);
        // A script: by its name, in quotes, as an automation it starts is.
        const script = automation.scripts[role];
        if (script) return quoted(this.deps.scripts?.name(script) ?? null);
        // A group: its parts, each by name.
        const members = automation.groups[role];
        if (members) return listed(members.map((member) => this.deps.device(member)?.name ?? 'a device you no longer have')) || 'no parts';
        return part(role)?.name ?? 'a device you no longer have';
      },
    };
  }

  /**
   * What its words need: the installed functions, and — its roles filled —
   * each setting a step changes as its device names it ("Live readings").
   */
  vocabulary(automation: AutomationRecord): RuleVocabulary {
    return {
      fn: (id) => this.deps.library.fn(id),
      ...(this.deps.world ? { modes: () => this.deps.world!.modes() } : {}),
      variables: (at) => {
        const world = this.deps.world;
        const fill = automation.world[at];
        const home = !world ? null : at === OWN_HOME ? world.home(automation.homeId) : fill && 'place' in fill ? world.homeOf({ id: fill.place, kind: fill.kind }) : null;
        return home && world ? world.variables(home) : null;
      },
      script: (role) => {
        const id = automation.scripts[role];
        return id && this.deps.scripts ? this.deps.scripts.shape(id) : null;
      },
      attribute: (role, target) => {
        const binding = automation.roles[role];
        const device = binding ? this.deps.device(binding) : null;
        return device ? writtenAttribute(device.description, binding!.part, target) : null;
      },
    };
  }

  /** Its settings as a sentence reads them: each one's value, or its default. */
  settled(automation: AutomationRecord, rule: Rule): Record<string, Value> {
    const scope = this.scope(automation, rule);
    // Each its value alone: the words say it in its setting's unit, a choice decides by it.
    return Object.fromEntries(Object.keys(rule.params.fields).map((key) => [key, scope.param(key).value]));
  }

  /** A condition in words, its settings filled in: "Garage station's charge is at least 50 %". */
  said(automation: AutomationRecord, rule: Rule, expr: Expr): string {
    const scope = this.scope(automation, rule);
    return describeExpr(rule, expr, this.settled(automation, rule), (role) => scope.name(role), this.vocabulary(automation));
  }

  /**
   * A condition a trigger waits to turn true, in words: a `becomes` its
   * condition — "Garage station's charge is below 15 %" — one of people and
   * places as the trigger says itself: "The last of the family leaves home".
   */
  edgeSaid(automation: AutomationRecord, rule: Rule, trigger: RuleTrigger): string {
    const edge = edgeOf(trigger);
    if (edge && 'becomes' in trigger) return this.said(automation, rule, edge.condition);
    const scope = this.scope(automation, rule);
    const said = describeTriggers({ ...rule, when: [trigger] }, this.settled(automation, rule), (role) => scope.name(role), this.vocabulary(automation))[0]!;
    return said.replace(/^When /, '');
  }

  /** Its steps in words, numbered and nested, as its card shows them. */
  steps(automation: AutomationRecord): RuleSteps {
    const rule = automation.rule;
    const scope = this.scope(automation, rule);
    return describeSteps(rule, this.settled(automation, rule), (role) => scope.name(role), this.vocabulary(automation));
  }

  /**
   * Each condition an automation waits for, as it stands at `at`, and what it
   * read to say so: how a run explains itself, and what its card shows now.
   */
  judge(automation: AutomationRecord, at = this.now()): { conditions: ConditionState[]; saw: string[] } {
    const rule = automation.rule;
    const scope = this.scope(automation, rule, at);
    const saw: string[] = [];
    const conditions = rule.when.flatMap((trigger): ConditionState[] => {
      const edge = edgeOf(trigger);
      if (!edge) return [];
      const holds = evaluateNow(edge.condition, scope, saw);
      const seconds = edge.heldFor ? (secondsNow(edge.heldFor, scope) ?? 0) : 0;
      const text = 'becomes' in trigger ? `${capitalise(this.said(automation, rule, edge.condition))}${seconds > 0 ? ` for ${secondsText(seconds)}` : ''}` : capitalise(this.edgeSaid(automation, rule, trigger));
      return [{ text, holds: typeof holds === 'boolean' ? holds : null }];
    });
    return { conditions, saw: [...new Set(saw)] };
  }

  /** When it next looks again to keep things so: null when it does not, or is off. */
  nextLookAt(automation: AutomationRecord): string | null {
    if (!automation.recheckMinutes || automation.mode === 'off') return null;
    const since = Math.max(...[automation.lookedAt, automation.lastRun?.at].map((at) => Date.parse(at ?? '')).filter(Number.isFinite));
    const next = Number.isFinite(since) ? since + automation.recheckMinutes * 60_000 : this.now().getTime();
    return new Date(Math.max(next, this.now().getTime())).toISOString();
  }

  /**
   * Why an automation cannot run as its roles are filled: a removed device, a
   * part that no longer fits, a meaning it does not report, a setting it
   * cannot change — or an automation to start that is gone.
   */
  roleProblems(automation: Pick<AutomationRecord, 'rule' | 'roles' | 'groups' | 'starts' | 'world' | 'homeId'>): string[] {
    const rule = automation.rule;
    const world = this.deps.world;
    // The home it is for, let go: it has nowhere to act.
    if (world && automation.homeId && !world.home(automation.homeId)) return ['The home it is for has been let go'];
    // Who and where: a member, members, a place still there.
    const gone = Object.entries(rule.roles).flatMap(([role, spec]) => {
      const fill = automation.world[role];
      if (!world || !fill || !(isPersonRole(spec) || isPeopleRole(spec) || isPlaceRole(spec))) return [];
      if ('place' in fill) return world.placeName({ id: fill.place, kind: fill.kind }) ? [] : [`${spec.label}: that place has been let go`];
      const people = 'person' in fill ? [fill.person] : 'people' in fill ? fill.people : [];
      const members = new Set(world.members());
      return people.every((person) => members.has(person)) ? [] : [`${spec.label}: someone chosen is no longer in the family`];
    });
    if (gone.length) return gone;
    // Each part filling a role, a group's each.
    const removed = [...partRoles(rule), ...groupRoles(rule)].flatMap(([role, spec]) =>
      bindingsOf(automation, role).flatMap((binding) => {
        const device = this.deps.device(binding);
        return device?.removed ? [`${spec.label}: ${device.name} has been removed`] : [];
      })
    );
    if (removed.length) return removed;
    const nothingToStart = Object.entries(rule.roles)
      .filter(([role, spec]) => isAutomationRole(spec) && !(automation.starts[role] && this.deps.store.get(automation.starts[role]!)))
      .map(([, spec]) => `${spec.label}: nothing to start — the automation it started is gone`);
    return [
      ...nothingToStart,
      ...checkBinding(rule, (role): BoundPart[] =>
        bindingsOf(automation, role).flatMap((binding) => {
          const device = this.deps.device(binding);
          return device ? [{ name: device.name, description: device.description, part: device.part, capabilities: device.hasPart ? device.capabilities : [] }] : [];
        })
      ),
    ];
  }

  /**
   * Whether an action would change nothing: every attribute its command sets,
   * as the capability declares, already reads what it would be set to, and
   * currently. Anything not known is not so: it is sent, and the gateway says.
   */
  alreadySo(action: PlannedAction): boolean {
    const device = this.deps.device(action.binding);
    if (!device?.device || device.removed) return false;
    const capability = capabilityIn(device.description, action.capability);
    const sets = Object.entries(capability?.commands[action.command]?.sets ?? {});
    if (!capability || !sets.length) return false;
    const readings = device.device.readings();
    const at = this.now().getTime();
    return sets.every(([arg, name]) => {
      const means = capability.attributes[name]?.means;
      const attribute = means ? attributeMeaning(device.description, action.binding.part, means) : null;
      const reading = attribute ? readingOf(readings, attribute.key) : null;
      return attribute !== null && reading !== null && isCurrent(attribute, reading, at) && String(reading.value) === String(action.args[arg]);
    });
  }

  /** The key of the setting a write names — by its key, or by its meaning — on the part filling its role; null when it has none. */
  settingKey(binding: RoleBinding, write: Write): string | null {
    const device = this.deps.device(binding);
    return device ? (writtenAttribute(device.description, binding.part, write)?.key ?? null) : null;
  }

  /** Whether a setting already reads what it would be set to — as the write step itself decides. */
  settingSo(write: PlannedWrite): boolean {
    const device = this.deps.device(write.binding);
    if (!device?.device || device.removed) return false;
    const reading = readingOf(device.device.readings(), write.key);
    return reading !== null && String(reading.value) === String(write.value);
  }

  /**
   * The value a setting is set to, in the setting's own unit — "2 kW" to one
   * in W is 2000 — evaluated now; null when it cannot be known, or put in it.
   */
  async settingValue(binding: RoleBinding, write: Write, scope: RuleScope): Promise<Value> {
    const measured = await measure(write.value, scope, []).catch(() => null);
    if (!measured) return null;
    const device = this.deps.device(binding);
    const attribute = device ? writtenAttribute(device.description, binding.part, write) : null;
    const unit = attribute?.value.type === 'number' ? attribute.value.unit : undefined;
    return unit && typeof measured.value === 'number' ? numberIn(measured, unit) : measured.value;
  }

  /** One command as it would be sent, its arguments evaluated — each number in the unit its capability takes it in: an unknown one is not guessed. */
  async planCommand(automation: AutomationRecord, command: Command, scope: RuleScope): Promise<PlannedAction | { unknown: string }> {
    const binding = automation.roles[command.role]!;
    const device = binding ? this.deps.device(binding) : null;
    const takes = device ? capabilityIn(device.description, command.capability)?.commands[command.command]?.args : undefined;
    const args: Record<string, Value> = {};
    for (const [name, expr] of Object.entries(command.args)) {
      const measured = await measure(expr, scope, []);
      const type = takes?.[name];
      const unit = type?.type === 'number' ? type.unit : undefined;
      args[name] = unit && typeof measured.value === 'number' ? numberIn(measured, unit) : measured.value;
    }
    if (Object.values(args).some((value) => value === null)) return { unknown: scope.name(command.role) };
    const name = scope.name(command.role);
    const setting = Object.values(args).map((value) => (value === true ? 'on' : value === false ? 'off' : String(value))).join(', ');
    const what = command.capability === 'switch' && command.command === 'set' ? `turn ${name} ${setting}` : `${command.capability}.${command.command} ${name} (${setting})`;
    return { binding, role: command.role, name, capability: command.capability, command: command.command, args, what };
  }

  /** What steps of commands and settings alone would change, each evaluated: an unknown one is not guessed. */
  async plan(automation: AutomationRecord, steps: readonly Step[], scope: RuleScope): Promise<Planned[] | { unknown: string }> {
    const planned: Planned[] = [];
    for (const step of steps) {
      if ('command' in step) {
        const action = await this.planCommand(automation, step.command, scope);
        if ('unknown' in action) return action;
        planned.push({ command: action });
      } else if ('write' in step) {
        const binding = automation.roles[step.write.role];
        const value = binding ? await this.settingValue(binding, step.write, scope) : null;
        const key = binding ? this.settingKey(binding, step.write) : null;
        if (!binding || value === null || !key) return { unknown: scope.name(step.write.role) };
        planned.push({ write: { binding, key, value } });
      }
    }
    return planned;
  }

  /** The engine's clock: the home's, or a test's own. */
  get clock(): Clock {
    return this.deps.clock ?? REAL_CLOCK;
  }

  /** Now, by the engine's clock. */
  now(): Date {
    return new Date(this.clock.now());
  }
}
