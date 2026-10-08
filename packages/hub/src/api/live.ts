import type { Caller, KraftverkApi, LiveUpdate } from '@kraftverk/api-contract';

import { coalesced } from '../live/stream.ts';
import type { Hub } from '../node/hub.ts';
import { positionHidden, readerOf, withoutPosition } from '../presence/levels.ts';
import { actorOf } from './caller.ts';

/*
  What changed, as it changes (docs/API.md, the live stream), to one
  listener: what the home's devices say reaches its bus as it happens; this
  passes it on, coalesced (`live/stream.ts`). The one thing a listener says
  back is what its screen shows, kept in the home's attention while it
  listens.
*/

export function liveApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'live'> {
  return {
    live(listener: (update: LiveUpdate) => void, options = {}) {
      const viewer = hub.attention.open(actorOf(caller).name);
      // What a carried device says of where it is, only as far as its carrier shares.
      const reader = readerOf(caller);
      const stop = coalesced(
        hub.bus,
        (update) => {
          if (update.type !== 'readings' || !positionHidden(hub, update.deviceId, reader)) return listener(update);
          const readings = withoutPosition(update.readings);
          if (readings.length) listener({ ...update, readings });
        },
        options.draining
      );
      // In the process, it is up at once.
      options.onState?.('live');
      listener({ type: 'hello', at: new Date().toISOString() });
      return {
        say: (view) => viewer.report(view),
        close: () => {
          viewer.close();
          stop();
        },
      };
    },
  };
}
