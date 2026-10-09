import type { HomeModeView } from '@kraftverk/api-contract';

/*
  A home's modes in words, and a time typed to plan one ahead
  (docs/PLAN-WORLD-MODEL.md §8.10): what the home screen and the modes page
  say alike.
*/

const clock = (at: string) => new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One axis in words: since when, who set it, and what comes next. */
export function modeLine(axis: HomeModeView): string {
  const now = axis.mode ? `${axis.mode.name} since ${time(axis.since!)}${axis.by ? `, set by ${axis.by}` : ''}` : 'Not said yet';
  const next = axis.ahead.find((each) => each.mode.id !== axis.mode?.id);
  return next ? `${now} · ${next.mode.name} from ${clock(next.from)}${next.until ? ` to ${clock(next.until)}` : ''}` : now;
}

/**
 * "2026-10-12 08:00", or "2026-10-12" for its midnight, on this device's
 * clock, as an instant; null when it is not a day and time there is — the
 * 31st of February is not the 3rd of March.
 */
export function typedTime(typed: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(typed.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute);
  const same = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day && at.getHours() === hour && at.getMinutes() === minute;
  return same ? at.toISOString() : null;
}

/** What is wrong with a mode planned from one time until another, as typed — or null when nothing is. */
export function plannedProblem(from: string, until: string): string | null {
  const fromAt = typedTime(from);
  if (!fromAt) return from.trim() ? 'From: a day, 2026-10-12, perhaps with a time, 08:00' : null;
  if (!until.trim()) return null;
  const untilAt = typedTime(until);
  if (!untilAt) return 'Until: a day, 2026-10-19, perhaps with a time, 18:00';
  return untilAt > fromAt ? null : 'It ends before it begins';
}
