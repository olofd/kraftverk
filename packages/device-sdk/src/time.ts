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

/**
 * The instant a clock in `timeZone` shows this time. Found by correcting a
 * guess by the zone's offset, twice, which settles across a daylight-saving
 * change; a time that does not exist that night (02:30 in spring) comes out
 * an hour later, as a clock would show it.
 */
export function zonedInstant(local: LocalTime, timeZone: string): Date {
  const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const shown = localTime(new Date(guess), timeZone);
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    guess += wanted - shownAsUtc;
  }
  return new Date(guess);
}

/** The calendar day `days` after the one a clock in `timeZone` shows at `date`. */
export function dayAfter(date: Date, timeZone: string, days: number): { year: number; month: number; day: number } {
  const today = localTime(date, timeZone);
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
