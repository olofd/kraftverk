import type { Value } from '@kraftverk/device-sdk';

import type { Trigger } from './rule.ts';

/*
  A rule's clock (docs/AUTOMATIONS.md): times of day, the slots an `every`
  trigger runs in, windows that cross midnight, and the days a trigger runs
  on — on its owner's calendar, read where the rule runs.
*/

/**
 * How often an `every` trigger may run, in seconds — whole minutes: not more
 * often than a look to keep things so, at least twice a day.
 */
export const EVERY_SECONDS = { min: 5 * 60, max: 12 * 3600, step: 60 } as const;

/**
 * How long a condition may be asked to have held, in seconds: more than
 * nothing, and at most a week — a wait a server keeps as one timer, which
 * past some 24 days would not wait at all.
 */
export const HOLD_SECONDS = { min: 1, max: 7 * 24 * 3600 } as const;

/** The start of the slot an `every` trigger is in at a minute of the day, both in minutes: every 15, at 07:40, is 07:30. */
export const slotOf = (minuteOfDay: number, everyMinutes: number): number => Math.floor(minuteOfDay / everyMinutes) * everyMinutes;

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
