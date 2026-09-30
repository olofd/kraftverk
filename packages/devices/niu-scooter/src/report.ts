/**
 * How old a scooter's report is, and how long it is trusted — what the
 * session says in its health and its readings' `currentFor`, and what the
 * page says beside them. Here, in `src`, because the server needs it; the
 * page (`ui/`) takes it from here, never the other way round.
 */

/** How long a report is trusted while the scooter charges or is switched on: its readings' `currentFor` (type.ts). */
export const REPORT_TRUSTED_MS = 30 * 60_000;

/** How long ago, in words: "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
