import type { SavedDeviceId } from '@kraftverk/device-sdk';

import { unref } from '../timers.ts';
import type { Attention } from './attention.ts';

/*
  A device someone is looking at is read more often.

  The same wish an automation waiting on a device makes (`wantFresh`): a
  lease, renewed while someone attends to the device, that lapses by itself
  when nobody does. Each device judges what more often means — a plug behind
  a gateway asked every couple of seconds instead of every fifteen — and one
  that cannot do better is not asked.
*/

/** How long one renewal keeps a device fresh: past the last look, at most this. */
export const FRESH_PAST_LOOK_MS = 30_000;
/** How often the leases are renewed while someone looks. */
export const RENEW_EVERY_MS = 10_000;

/** Keeps every attended device fresh until stopped — saying of each whether its own page is open (`close`). `want` is a device's `wantFresh`. */
export function keepWatchedFresh(attention: Attention, want: (device: SavedDeviceId, until: number, close: boolean) => void): () => void {
  const renew = () => {
    const until = Date.now() + FRESH_PAST_LOOK_MS;
    const close = attention.attendedClose();
    for (const device of attention.attended('device')) want(device, until, close.has(device));
  };
  // At once when someone opens a device — the page fills while it is looked at — and on a clock after.
  const stopListening = attention.onChange(renew);
  const timer = setInterval(renew, RENEW_EVERY_MS);
  unref(timer);
  return () => {
    stopListening();
    clearInterval(timer);
  };
}
