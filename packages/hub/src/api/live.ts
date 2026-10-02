import type { Caller, KraftverkApi, LiveUpdate } from '@kraftverk/api-contract';

import type { Hub } from '../hub.ts';
import { Outbox } from '../live/outbox.ts';
import { actorOf } from './caller.ts';

/*
  What changed, as it changes (docs/API.md, the live stream), to one
  listener: what the home's devices say reaches its bus as it happens; this
  passes it on, coalesced, at most four times a second — and never while
  nothing waits, so an idle listener costs no timer. The one thing a listener
  says back is what its screen shows, kept in the home's attention while it
  listens.
*/

const FLUSH_MS = 250;

export function liveApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'live'> {
  return {
    live(listener: (update: LiveUpdate) => void, options = {}) {
      const viewer = hub.attention.open(caller.kind === 'person' ? caller.name : actorOf(caller));
      const outbox = new Outbox();
      let pending: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        pending = null;
        // One that is not draining keeps it waiting: its backlog coalesces here, not in its buffer.
        if (options.draining && !options.draining()) return schedule();
        for (const update of outbox.take()) listener(update);
      };
      const schedule = () => {
        pending ??= setTimeout(flush, FLUSH_MS);
      };
      const unsubscribe = hub.bus.subscribe((message) => {
        outbox.add(message);
        schedule();
      });
      listener({ type: 'hello', at: new Date().toISOString() });
      return {
        say: (view) => viewer.report(view),
        close: () => {
          viewer.close();
          unsubscribe();
          if (pending) clearTimeout(pending);
          pending = null;
        },
      };
    },
  };
}
