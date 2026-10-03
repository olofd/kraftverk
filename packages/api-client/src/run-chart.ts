import type { AutomationRun, RunLog, RunLogKey, RunLogReach, RunLogReading, RunStep } from '@kraftverk/api-contract';

/*
  A run's log, made into what its page draws (docs/SEQUENCES.md): each value
  as the points it went through, held from one reading to the next — a
  device's reading stands until it says another — placed in the run's own
  window; and the steps that changed something, numbered, to mark on every
  chart at once. Pure: the page draws from it, and its tests read it.
*/

/** The spans a device could not be reached for: from each "not" to the next "could", or to the run's end. */
export function awayOf(reach: readonly RunLogReach[], device: string, window: Window): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let since: number | null = null;
  for (const each of reach.filter((entry) => entry.device === device)) {
    const at = Math.max(window.from, Date.parse(each.at));
    if (!each.reachable && since === null) since = at;
    if (each.reachable && since !== null) {
      spans.push({ from: since, to: at });
      since = null;
    }
  }
  if (since !== null) spans.push({ from: since, to: window.to });
  return spans;
}

/** The span a run's log is drawn across, in epoch milliseconds: from its start to its end — or to now, while it runs. */
export type Window = { from: number; to: number };

/** A point of a value: when the device took it, and what it was. */
export type Point = { at: number; value: RunLogReading['value'] };

/** A value of a device, with what it is and every point it went through. */
export type Series = { key: RunLogKey; points: Point[] };

/** A step that changed something — a switch, a setting, another automation started — numbered for the charts. */
export type Mark = { n: number; at: number; step: RunStep };

/** The kinds of step that change something: what the charts mark. */
const MARKED = new Set<RunStep['kind']>(['command', 'write', 'start']);

export function windowOf(log: Pick<RunLog, 'run' | 'readings' | 'reach'>, now = Date.now()): Window {
  const from = Date.parse(log.run.at);
  const ended = log.run.endedAt ? Date.parse(log.run.endedAt) : null;
  const latest = Math.max(from, ...log.readings.map((reading) => Date.parse(reading.at)), ...log.reach.map((reach) => Date.parse(reach.at)));
  return { from, to: Math.max(from + 1_000, ended ?? Math.max(latest, now)) };
}

/**
 * Each value of the log, in the order its device described them: its
 * readings as points in time order, a value said again left out — it was
 * already so. A reading taken before the run began starts it at its start.
 */
export function seriesOf(log: Pick<RunLog, 'keys' | 'readings'>, window: Window): Series[] {
  const byKey = new Map<string, Point[]>();
  for (const reading of log.readings) {
    const id = `${reading.device} ${reading.key}`;
    const points = byKey.get(id) ?? [];
    const at = Math.max(window.from, Date.parse(reading.at));
    // Two readings at one instant — the start of the run, say: the later one is what it was then.
    if (points.at(-1)?.at === at) points.pop();
    const last = points.at(-1);
    byKey.set(id, points);
    if (last && JSON.stringify(last.value) === JSON.stringify(reading.value)) continue;
    points.push({ at, value: reading.value });
  }
  return log.keys.map((key) => ({ key, points: byKey.get(`${key.device} ${key.key}`) ?? [] }));
}

/** Whether a value changed while the run ran: more than one value among its points. */
export const changed = (series: Series): boolean => series.points.length > 1;

/** The steps that changed something — or tried to and could not — in order, numbered from 1. One that found it already so changed nothing. */
export function marksOf(run: Pick<AutomationRun, 'steps'>): Mark[] {
  return run.steps.filter((step) => MARKED.has(step.kind) && step.outcome !== 'already').map((step, index) => ({ n: index + 1, at: Date.parse(step.at), step }));
}

/** Where an instant falls across a width: 0 at the run's start, `width` at its end. */
export const xOf = (at: number, window: Window, width: number): number => ((Math.min(window.to, Math.max(window.from, at)) - window.from) / (window.to - window.from)) * width;

/** The instant a place across a width stands for. */
export const atOf = (x: number, window: Window, width: number): number => window.from + (Math.min(width, Math.max(0, x)) / Math.max(1, width)) * (window.to - window.from);

/** What a value was at an instant: the last point at or before it; undefined before its first. */
export function valueAt(series: Series, at: number): Point | undefined {
  let found: Point | undefined;
  for (const point of series.points) {
    if (point.at > at) break;
    found = point;
  }
  return found;
}

/**
 * A number's path, held from one reading to the next and on to the run's
 * end: across, then up or down to the next. Points that are not numbers —
 * not known — break it.
 */
export function heldPath(points: readonly Point[], window: Window, width: number, y: (value: number) => number): string {
  let path = '';
  let open = false;
  points.forEach((point, index) => {
    if (typeof point.value !== 'number') {
      open = false;
      return;
    }
    const x = xOf(point.at, window, width);
    const next = points[index + 1];
    const until = xOf(next ? next.at : window.to, window, width);
    const height = y(point.value);
    path += `${open ? 'L' : 'M'}${x.toFixed(1)},${height.toFixed(1)}H${until.toFixed(1)}`;
    open = true;
  });
  return path;
}

/** The spans a value held one value for: from each point to the next, or to the run's end. */
export function spansOf(points: readonly Point[], window: Window): { from: number; to: number; value: Point['value'] }[] {
  return points.map((point, index) => ({ from: point.at, to: points[index + 1]?.at ?? window.to, value: point.value }));
}

/** "+1:07", "+0:07.3": how far into the run an instant is — tenths when asked. */
export function sinceStart(at: number, window: Window, tenths = false): string {
  const ms = Math.max(0, at - window.from);
  // Rounded once, to what it shows, then split: 59.96 s is "+1:00.0", never "+0:60.0".
  const perMinute = tenths ? 600 : 60;
  const steps = tenths ? Math.round(ms / 100) : Math.floor(ms / 1000);
  const rest = steps % perMinute;
  const shown = tenths ? (rest / 10).toFixed(1).padStart(4, '0') : String(rest).padStart(2, '0');
  return `+${Math.floor(steps / perMinute)}:${shown}`;
}

/** A value as its key says it: "297 W", "on", "Lit while it is on", "—" when not known. */
export function said(key: Pick<RunLogKey, 'kind' | 'unit' | 'words' | 'options'>, value: RunLogReading['value']): string {
  if (value === null || value === undefined) return '—';
  if (key.kind === 'boolean' && typeof value === 'boolean') return key.words ? key.words[value ? 'true' : 'false'] : value ? 'on' : 'off';
  if (key.kind === 'enum' && typeof value === 'string') return key.options?.find((option) => option.value === value)?.label ?? value;
  if (typeof value === 'number') return key.unit ? `${value} ${key.unit}` : String(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}
