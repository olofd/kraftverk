/*
  What a Find My device's screen says of time: how long ago it was located,
  when its account looks for it next, and how often — so nobody wonders when
  it updates. Pure, and tested beside it.
*/

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "4 min ago", "2 h 5 min ago", "3 days ago". */
export function ago(at: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(at));
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < 24 * HOUR) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return `${hours} h${minutes ? ` ${minutes} min` : ''} ago`;
  }
  const days = Math.floor(ms / (24 * HOUR));
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** "any moment", "in about 11 min". */
export function soon(at: string, now: number): string {
  const ms = Date.parse(at) - now;
  if (ms < MINUTE) return 'any moment';
  return `in about ${Math.round(ms / MINUTE)} min`;
}

/** "every minute", "every 2 min", "every 15 min". */
export function every(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'every minute' : `every ${minutes} min`;
}

/**
 * When its account looks for it next, and why that often: "Looks again in
 * about 11 min · every 15 min while it is still". Null when nothing is known yet.
 */
export function cadence(nextLook: string | null, lookEvery: number | null, now: number): string | null {
  if (!nextLook || !lookEvery) return null;
  const why = lookEvery <= 60 ? 'while this page is open' : lookEvery <= 240 ? 'while it moves' : 'while it is still';
  return `Looks again ${soon(nextLook, now)} · ${every(lookEvery)} ${why}`;
}
