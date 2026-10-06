import { ApiError, type KraftverkApi, type TransportView } from '@kraftverk/api-contract';
import { savedDeviceId } from '@kraftverk/device-sdk';

import type { Hub } from '../node/hub.ts';

/*
  What the home reaches devices over — each transport, whether it runs, its
  diagnostics — and what can be seen near it that nothing you have is reached
  by, as everything that uses a home asks.
*/

export function transportsApi(hub: Hub): Pick<KraftverkApi, 'nearby' | 'ignoreFound' | 'unignoreFound' | 'transports'> {
  const { nearby } = hub;
  const { transports } = hub.installed;
  return {
    /** "Found near you": what can be seen that nothing you have is reached by. The first ask starts watching. */
    nearby: async () => nearby.list(),
    /** Not offered again: kept by where it was found, so seen again it is known. */
    ignoreFound: async (at) => hub.ignored.ignore({ ...at, through: at.through === null ? null : savedDeviceId(at.through) }),
    unignoreFound: async (at) => hub.ignored.unignore({ ...at, through: at.through === null ? null : savedDeviceId(at.through) }),

    transports: {
      /** What this home can reach devices over: each transport, whether it runs, what it can see, its diagnostics by name. */
      async list() {
        return {
          readOnly: hub.readOnly(),
          transports: transports.definitions().map((definition): TransportView => {
            const transport = transports.get(definition.id);
            return {
              ...definition,
              holder: 'master',
              running: transport !== null,
              availability: transports.available(definition.id),
              values: transport?.values?.() ?? {},
              diagnostics: Object.keys(transport?.diagnostics ?? {}),
            };
          }),
          refused: [...transports.refused],
        };
      },

      /** A transport's own read-only diagnostic — the broker's journal, a GATT layout — by name, so none is a route of its own. */
      async diagnostic(id, name, query) {
        const diagnostic = transports.get(id)?.diagnostics?.[name];
        if (!diagnostic) throw new ApiError('not-found', 'No such diagnostic, or it is not running');
        const result = await diagnostic(query);
        if (result === null || result === undefined) throw new ApiError('unavailable', 'It is not answering');
        return result;
      },
    },
  };
}
