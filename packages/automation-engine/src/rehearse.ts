import type { Rehearsal } from '@kraftverk/api-contract';
import {
  attributeMeaning,
  clockTime,
  currentForOf,
  dayAfter,
  localTime,
  standardMeaning,
  unitIn,
  zonedInstant,
  zonedInstants,
  type AttributeSpec,
  type DeviceDescription,
  type ScalarValue,
  type Value,
} from '@kraftverk/device-sdk';
import { evaluate, evaluateNow, settingOf, EVERY_SECONDS, minutesOf, ruleUses, runsOn, secondsNow, secondsText, stepsOf, triggerKey, triggerOf, type RoleBinding, type Rule, type RuleScope } from '@kraftverk/automation';

/**
 * A rule, rehearsed on what happened (PROPOSITION.md §5.3): walked through a
 * window of history minute by minute, with the triggers the engine uses —
 * a condition turning true and held, a time of day, an event — and at each
 * run, what it would have decided and done. Nothing is sent, and nothing is
 * kept.
 *
 * History is what happened without it: a charger it would have switched on
 * would have raised the charge, and that is not in the samples. And what
 * history does not keep — a forecast a function asks for — is unknown here,
 * as it would be at run time with the service away; the rehearsal says so.
 */

export type RehearseSource = {
  /** The part filling a role: its name and description. */
  device(binding: RoleBinding): { name: string; description: DeviceDescription } | null;
  /** Its samples of one attribute in a window, oldest first. */
  samples(deviceId: string, key: string, from: string, to: string): readonly { at: string; value: number | null; text: string | null }[];
  /** When it raised one event in a window, oldest first. */
  events(deviceId: string, part: string, event: string, from: string, to: string): readonly string[];
};

export type Rehearsed = { roles: Readonly<Record<string, RoleBinding>>; timeZone: string };

/** At most this many runs are reported: a rule that runs that often is said to, not listed. */
const MAX_RUNS = 200;
/** Samples are a minute apart: a value stays current that much past its attribute's window. */
const SAMPLE_SLACK_MS = 60_000;

type Series = { attribute: AttributeSpec; points: { at: number; value: ScalarValue }[] };

const valueOf = (attribute: AttributeSpec, row: { value: number | null; text: string | null }): ScalarValue | null =>
  row.text !== null ? row.text : row.value === null ? null : attribute.value.type === 'boolean' ? row.value !== 0 : row.value;

/**
 * Where `t` goes in times sorted oldest first: the index of the first one
 * after it. Fourteen days of minute samples are twenty thousand points,
 * looked up at every moment: halving, not walking.
 */
function after(times: readonly { at: number }[] | readonly number[], t: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = times[middle]!;
    if ((typeof item === 'number' ? item : item.at) <= t) low = middle + 1;
    else high = middle;
  }
  return low;
}

export async function rehearse(recipe: Rule, automation: Rehearsed, source: RehearseSource, window: { from: Date; to: Date }): Promise<Rehearsal> {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const caveats: string[] = [];
  // Played or started, and by nothing of its own: history holds no moment it would have started by itself.
  if (!recipe.when.length) {
    return { from, to, runs: [], caveats: ['It runs when you play it, or another automation starts it — never on its own: there is no moment in history it would have started'] };
  }
  const uses = ruleUses(recipe);
  const name = (role: string) => {
    const binding = automation.roles[role];
    return (binding && source.device(binding)?.name) ?? 'a device you no longer have';
  };
  for (const role of uses.reaches) caveats.push(`Whether ${name(role)} could be reached is not kept in history: taken as unknown`);

  // Every reading the rule makes, as a series from history.
  const series = new Map<string, Series | null>();
  for (const { role, means } of uses.reads) {
    const key = `${role}:${means}`;
    if (series.has(key)) continue;
    const binding = automation.roles[role];
    const device = binding ? source.device(binding) : null;
    const attribute = device && binding ? attributeMeaning(device.description, binding.part, means) : null;
    if (!binding || !device || !attribute) {
      series.set(key, null);
      caveats.push(`${recipe.roles[role]?.label ?? role}: nothing reports ${standardMeaning(means)?.label.toLowerCase() ?? means} there`);
      continue;
    }
    const points = source
      .samples(binding.device, attribute.key, new Date(window.from.getTime() - 60 * 60_000).toISOString(), to)
      .flatMap((row) => {
        const value = valueOf(attribute, row);
        return value === null ? [] : [{ at: Date.parse(row.at), value }];
      });
    if (!points.length) caveats.push(`${name(role)} kept no ${attribute.label.toLowerCase()} in that time`);
    series.set(key, { attribute, points });
  }
  for (const call of uses.calls) caveats.push(`It asks ${call.fn} of ${name(call.role)}, which history does not keep: taken as unknown`);

  const scopeAt = (t: number, trigger: string | null = null): RuleScope => ({
    clock: () => clockTime(new Date(t), automation.timeZone),
    reachable: () => ({ reachable: null, detail: 'history does not keep whether it could be reached' }),
    // Its settings, as it runs with them: each its value, in its unit.
    param: (param) => settingOf(recipe.params, param),
    read: (role, means) => {
      const found = series.get(`${role}:${means}`);
      if (!found) return null;
      const latest = found.points[after(found.points, t) - 1];
      // A sample older than its attribute stays current was not known then.
      if (!latest || t - latest.at > currentForOf(found.attribute) + SAMPLE_SLACK_MS) return null;
      return { value: latest.value, label: standardMeaning(means)?.label ?? found.attribute.label, unit: unitIn(found.attribute) };
    },
    name,
    // The trigger that started the run it rehearses, by its key: its id, or "" for none with one.
    run: (fact) => (fact === 'trigger' ? (triggerOf(recipe, trigger)?.id ?? '') : null),
  });

  // The moments anything could have changed: every sample, every time of day, every event.
  const start = window.from.getTime();
  const end = window.to.getTime();
  const moments = new Set<number>();
  for (const found of series.values()) for (const point of found?.points ?? []) if (point.at >= start && point.at <= end) moments.add(point.at);
  // Every day of the owner's calendar the span touches, and one either side: each a date, never 24 hours — a night the clocks change is still one day.
  const days: { year: number; month: number; day: number }[] = [];
  for (let offset = -1, last = localTime(new Date(end), automation.timeZone); ; offset += 1) {
    const date = dayAfter(new Date(start), automation.timeZone, offset);
    days.push(date);
    if (date.year > last.year || (date.year === last.year && (date.month > last.month || (date.month === last.month && date.day > last.day)))) break;
  }

  // And each window of the day it looks at, as it opens and closes, on the owner's clock.
  for (const window of uses.windows) {
    for (const edge of [window.from, window.to]) {
      const minutes = minutesOf(evaluateNow(edge, scopeAt(start)));
      if (minutes === null) continue;
      for (const date of days) {
        const instant = zonedInstant({ ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 }, automation.timeZone).getTime();
        if (instant >= start && instant <= end) moments.add(instant);
      }
    }
  }

  type Fired = { at: number; because: string; trigger: string };
  const fired: Fired[] = [];
  for (const [index, trigger] of recipe.when.entries()) {
    const key = triggerKey(trigger, index);
    if ('at' in trigger) {
      const at = evaluateNow(trigger.at, scopeAt(start));
      const [hour, minute] = typeof at === 'string' ? at.split(':').map(Number) : [];
      if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) continue;
      for (const date of days) {
        // Only on its days, on the owner's calendar.
        if (!runsOn(trigger, date)) continue;
        const instant = zonedInstant({ ...date, hour, minute }, automation.timeZone).getTime();
        if (instant >= start && instant <= end && !fired.some((run) => run.at === instant)) fired.push({ at: instant, because: `It is ${at}`, trigger: key });
      }
    } else if ('every' in trigger) {
      const seconds = secondsNow(trigger.every, scopeAt(start));
      if (typeof seconds !== 'number' || seconds < EVERY_SECONDS.min || seconds > EVERY_SECONDS.max || seconds % EVERY_SECONDS.step !== 0) continue;
      const every = seconds / 60;
      for (const date of days) {
        for (let slot = 0; slot < 24 * 60; slot += every) {
          // Each time the clock shows it: twice in the hour repeated as clocks go back, not at all in the one skipped.
          for (const each of zonedInstants({ ...date, hour: Math.floor(slot / 60), minute: slot % 60 }, automation.timeZone)) {
            const instant = each.getTime();
            if (instant >= start && instant <= end && !fired.some((run) => run.at === instant)) fired.push({ at: instant, because: `Every ${secondsText(seconds)}`, trigger: key });
          }
        }
      }
    } else if ('event' in trigger) {
      const binding = automation.roles[trigger.event.role];
      if (!binding) continue;
      for (const at of source.events(binding.device, binding.part, trigger.event.event, from, to)) fired.push({ at: Date.parse(at), because: `${name(trigger.event.role)} said ${trigger.event.event}`, trigger: key });
    }
  }
  // A condition turning true, and held: the engine's own rules, with nothing kept at the start.
  const becomes = recipe.when.flatMap((trigger, index) => ('becomes' in trigger ? [{ trigger, key: triggerKey(trigger, index), last: false, heldSince: null as number | null, fired: false }] : []));
  // A hold is looked at again when it has run its time, as the engine's timer does, sample or not.
  const queue = [...moments].sort((a, b) => a - b);
  const lookAgainAt = (t: number) => {
    const index = after(queue, t);
    if (t > end || queue[index - 1] === t) return;
    queue.splice(index, 0, t);
  };
  for (let index = 0; index < queue.length; index++) {
    const t = queue[index]!;
    const scope = scopeAt(t);
    for (const state of becomes) {
      const now = evaluateNow(state.trigger.becomes, scope);
      if (typeof now !== 'boolean') continue;
      if (!now) {
        Object.assign(state, { last: false, heldSince: null, fired: false });
        continue;
      }
      const seconds = state.trigger.heldFor ? (secondsNow(state.trigger.heldFor, scope) ?? 0) : 0;
      if (!state.last) {
        Object.assign(state, { last: true, heldSince: t, fired: false });
        if (seconds > 0) lookAgainAt(t + seconds * 1000);
      }
      if (state.fired) continue;
      if (t - (state.heldSince ?? t) < seconds * 1000) continue;
      state.fired = true;
      const trace: string[] = [];
      evaluateNow(state.trigger.becomes, scope, trace);
      fired.push({ at: t, because: `${trace.join('; ')}${seconds > 0 ? `, for ${secondsText(seconds)}` : ''}`, trigger: state.key });
    }
  }

  const runs: Rehearsal['runs'] = [];
  for (const run of fired.sort((a, b) => a.at - b.at).slice(0, MAX_RUNS)) {
    const scope = scopeAt(run.at, run.trigger);
    const trace = [run.because];
    const at = new Date(run.at).toISOString();
    if (recipe.if) {
      const holds = await evaluate(recipe.if, scope, trace);
      if (holds !== true) {
        runs.push({ at, outcome: holds === null ? 'unknown' : 'idle', summary: `${holds === null ? 'Could not tell' : 'Would do nothing'}: ${trace.join('; ')}` });
        continue;
      }
    }
    const done: string[] = [];
    let unknown = false;
    for (const step of stepsOf(recipe, run.trigger)) {
      // What a step that waits or chooses would have done depends on what the commands before it changed, which
      // history cannot show: said, not guessed — and nothing after it, which depends on it.
      if (!('command' in step)) {
        done.push('then take its steps, which history cannot show');
        break;
      }
      const { command } = step;
      const args: Record<string, Value> = {};
      for (const [arg, expr] of Object.entries(command.args)) args[arg] = await evaluate(expr, scope, []);
      if (Object.values(args).some((value) => value === null)) unknown = true;
      const setting = Object.values(args).map((value) => (value === true ? 'on' : value === false ? 'off' : String(value))).join(', ');
      done.push(command.capability === 'switch' && command.command === 'set' ? `turn ${name(command.role)} ${setting}` : `${command.capability}.${command.command} ${name(command.role)} (${setting})`);
    }
    runs.push(unknown ? { at, outcome: 'unknown', summary: `Could not tell what to send: ${trace.join('; ')}` } : { at, outcome: 'would-act', summary: `Would ${done.join(', then ')}. ${trace.join('; ')}` });
  }
  if (fired.length > MAX_RUNS) caveats.push(`It would have run ${fired.length} times; the first ${MAX_RUNS} are listed`);
  if (runs.some((run) => run.outcome === 'would-act')) caveats.push('History is what happened without it: what it would have changed is not in it');
  return { from, to, runs, caveats };
}
