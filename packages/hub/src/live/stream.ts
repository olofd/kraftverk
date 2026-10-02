import type { LiveUpdate } from '@kraftverk/api-contract';
import type { LiveBus } from '@kraftverk/holder';

import { Outbox } from './outbox.ts';

/** How often a listener is told what changed, at most: four times a second. */
const FLUSH_MS = 250;

/**
 * What a node's bus says, passed on to one listener coalesced (`Outbox`), at
 * most four times a second — and never while nothing waits, so an idle
 * listener costs no timer. One that is not draining keeps it waiting: its
 * backlog coalesces here, not in its buffer. The master's live stream and a
 * follower's both pass on their own bus by this. Returns what stops it.
 */
export function coalesced(bus: LiveBus, listener: (update: LiveUpdate) => void, draining?: () => boolean): () => void {
  const outbox = new Outbox();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    pending = null;
    if (draining && !draining()) return schedule();
    for (const update of outbox.take()) listener(update);
  };
  const schedule = () => {
    pending ??= setTimeout(flush, FLUSH_MS);
  };
  const unsubscribe = bus.subscribe((message) => {
    outbox.add(message);
    schedule();
  });
  return () => {
    unsubscribe();
    if (pending) clearTimeout(pending);
    pending = null;
  };
}
