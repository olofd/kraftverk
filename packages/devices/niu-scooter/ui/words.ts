import type { Value } from '@kraftverk/device-sdk';

/**
 * What the scooter is doing, in words a person reads at a glance — never
 * NIU's field names. Pure, so every sentence is tested.
 */

type Read = (key: string) => Value;

const num = (value: Value): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** How long a report is trusted while the scooter charges or is switched on — its readings' `currentFor` (src/type.ts). */
export const REPORT_TRUSTED_MS = 30 * 60_000;

export type Doing = {
  /** "Charging", "Parked"… */
  title: string;
  /** What follows from it: "Full in about 2 h 40 min", "About 30 km of range". Null when nothing does. */
  detail: string | null;
  tone: 'success' | 'muted';
  /** Its charge is moving: a report goes out of date. Parked, it does not. */
  moving: boolean;
};

/** 158 → "2 h 38 min", 45 → "45 min", 120 → "2 h". */
export function span(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** What it is doing, from its last report. */
export function doingOf(read: Read): Doing {
  const charging = read('charging') === true;
  const on = read('poweredOn') === true;
  const range = num(read('range'));
  const toFull = num(read('minutesToFull'));
  const soc = num(read('soc'));
  const rangeLine = range === null ? null : `About ${Math.round(range)} km of range`;

  if (charging) {
    return {
      title: 'Charging',
      detail: soc !== null && soc >= 100 ? 'Full' : toFull !== null && toFull > 0 ? `Full in about ${span(toFull)}` : rangeLine,
      tone: 'success',
      moving: true,
    };
  }
  if (on) return { title: 'Switched on', detail: rangeLine, tone: 'success', moving: true };
  // NIU says nothing of a charger that is plugged in but not charging (README.md): parked, then.
  if (soc === null && range === null && read('charging') === null) return { title: 'Nothing reported yet', detail: null, tone: 'muted', moving: false };
  return { title: 'Parked', detail: rangeLine, tone: 'muted', moving: false };
}

/** A charge's colour: low is a warning, very low a danger. */
export const levelTone = (soc: number | null): 'danger' | 'warning' | 'normal' => (soc === null ? 'normal' : soc < 15 ? 'danger' : soc < 30 ? 'warning' : 'normal');

/** How long ago, in words: "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * When it last reported, and whether that still holds: parked, its charge
 * does not move, so an old report does; charging or switched on, one older
 * than NIU's usual rhythm may have moved on.
 */
export function reportLine(reportedAt: string | null, doing: Doing, now = Date.now()): { text: string; stale: boolean } {
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt))) return { text: 'It has not reported to NIU yet', stale: false };
  const when = `Reported to NIU ${ago(reportedAt, now)}`;
  if (!doing.moving) return { text: now - Date.parse(reportedAt) > 60 * 60_000 ? `${when} · parked, so its charge still holds` : when, stale: false };
  const stale = now - Date.parse(reportedAt) > REPORT_TRUSTED_MS;
  return { text: stale ? `${when} · NIU has heard nothing since, so it may have moved on` : when, stale };
}
