/**
 * Wall-clock time in a named time zone.
 *
 * The server may run in UTC — a container usually does — while "07:00" and
 * "tomorrow" mean the owner's own clock. So an automation keeps the time zone
 * of the app it was made in, and every time it is judged by is read in that
 * zone, never the server's.
 */

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** Whether a string names a time zone this runtime knows: "Europe/Stockholm". */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `timeZone` shows at `date`. */
export function localTime(date: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The time of day a clock in `timeZone` shows at `date`, as a rule writes one: "07:05". */
export function clockTime(date: Date, timeZone: string): string {
  const { hour, minute } = localTime(date, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;

/** What a clock in `timeZone` shows at `instant`, written as if it were UTC: to the minute. */
const shownAsUtc = (instant: number, timeZone: string): number => {
  const shown = localTime(new Date(instant), timeZone);
  return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
};

/** How far ahead of UTC a clock in `timeZone` is at `instant`, in milliseconds. */
const offsetAt = (instant: number, timeZone: string): number => shownAsUtc(instant, timeZone) - (instant - (((instant % 60_000) + 60_000) % 60_000));

/**
 * Every instant a clock in `timeZone` shows this time, earliest first: one —
 * two in the hour repeated as clocks go back, none in the hour skipped as
 * they go forward. Tried with the offsets the zone has the day before, the
 * day itself and the day after: a change between is the one that night.
 */
export function zonedInstants(local: LocalTime, timeZone: string): Date[] {
  const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set([offsetAt(wanted - DAY_MS, timeZone), offsetAt(wanted, timeZone), offsetAt(wanted + DAY_MS, timeZone)]);
  const instants = [...offsets].map((offset) => wanted - offset).filter((instant) => shownAsUtc(instant, timeZone) === wanted);
  return [...new Set(instants)].sort((a, b) => a - b).map((instant) => new Date(instant));
}

/**
 * The instant a clock in `timeZone` shows this time: in the hour repeated
 * as clocks go back, the first time it shows it; a time that does not exist
 * that night (02:30 in spring; 00:00 where the change is at midnight) comes
 * out as much later as the clock moved, on that same day — as a clock would
 * show it.
 */
export function zonedInstant(local: LocalTime, timeZone: string): Date {
  const [first] = zonedInstants(local, timeZone);
  if (first) return first;
  const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // Skipped: read with the offset from before the change, it lands past the gap by as much as it was into it.
  return new Date(wanted - offsetAt(wanted - DAY_MS, timeZone));
}

/** The calendar day `days` after the one a clock in `timeZone` shows at `date`. */
export function dayAfter(date: Date, timeZone: string, days: number): { year: number; month: number; day: number } {
  const today = localTime(date, timeZone);
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
