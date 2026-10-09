import type { Value } from '@kraftverk/device-sdk';

import type { Trigger } from './rule.ts';

/*
  A rule's clock (docs/AUTOMATIONS.md): times of day, the slots an `every`
  trigger runs in, windows that cross midnight, and the days a trigger runs
  on — on its owner's calendar, read where the rule runs.
*/

/**
 * How often an `every` trigger may run, in seconds — whole minutes, as the
 * engine looks on the minute: every minute at most, at least twice a day.
 */
export const EVERY_SECONDS = { min: 60, max: 12 * 3600, step: 60 } as const;

/**
 * How long a condition may be asked to have held, in seconds: more than
 * nothing, and at most a week — a wait a server keeps as one timer, which
 * past some 24 days would not wait at all.
 */
export const HOLD_SECONDS = { min: 1, max: 7 * 24 * 3600 } as const;

/** How long after kraftverk starts an `on start` trigger waits, in seconds: devices reconnect first — at most an hour. */
export const START_SECONDS = { min: 0, max: 3600 } as const;

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

/** A month, on the owner's calendar. */
export type Month = 'jan' | 'feb' | 'mar' | 'apr' | 'may' | 'jun' | 'jul' | 'aug' | 'sep' | 'oct' | 'nov' | 'dec';

/** January first. */
export const MONTHS: readonly Month[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const MONTH_WORDS: Readonly<Record<Month, string>> = { jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };

/** Days in each month — February's 29: a date said for every year is one some years have. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * A date, or dates, of every year: "12-24", or "12-01..12-24" — month and
 * day, a span across the year's end when it ends before it begins
 * ("12-20..01-06"). Its two ends as month × 100 + day; null for anything
 * else, or a day the month never has.
 */
export function dateSpanOf(text: unknown): { from: number; to: number } | null {
  if (typeof text !== 'string') return null;
  const match = /^(\d\d)-(\d\d)(?:\.\.(\d\d)-(\d\d))?$/.exec(text.trim());
  if (!match) return null;
  const end = (month: string, day: string): number | null => {
    const [m, d] = [Number(month), Number(day)];
    return m >= 1 && m <= 12 && d >= 1 && d <= MONTH_DAYS[m - 1]! ? m * 100 + d : null;
  };
  const from = end(match[1]!, match[2]!);
  const to = match[3] ? end(match[3], match[4]!) : from;
  return from !== null && to !== null ? { from, to } : null;
}

/** Whether a date on the owner's calendar is within one of these spans. */
export const onDates = (dates: readonly string[], date: { month: number; day: number }): boolean => {
  const at = date.month * 100 + date.day;
  return dates.some((text) => {
    const span = dateSpanOf(text);
    return span !== null && (span.from <= span.to ? at >= span.from && at <= span.to : at >= span.from || at <= span.to);
  });
};

/** Months, as a person says them: "in Dec, Jan and Feb". */
export function monthsText(months: readonly Month[]): string {
  const words = MONTHS.filter((month) => months.includes(month)).map((month) => MONTH_WORDS[month]);
  return `in ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}`;
}

/** Dates, as a person says them: "on 24 Dec", "from 1 Dec to 24 Dec". */
export function datesText(dates: readonly string[]): string {
  const said = (at: number) => `${at % 100} ${MONTH_WORDS[MONTHS[Math.floor(at / 100) - 1]!]}`;
  const words = dates.flatMap((text) => {
    const span = dateSpanOf(text);
    if (!span) return [];
    return [span.from === span.to ? `on ${said(span.from)}` : `from ${said(span.from)} to ${said(span.to)}`];
  });
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? '');
}

/** Whether a time-of-day trigger runs on this date: its days, its months and its dates — each every one, unless it says. */
export const runsOn = (trigger: Extract<Trigger, { at: unknown }>, date: { year: number; month: number; day: number }): boolean =>
  (!trigger.days || trigger.days.includes(weekdayOf(date))) && (!trigger.months || trigger.months.includes(MONTHS[date.month - 1]!)) && (!trigger.dates || onDates(trigger.dates, date));
