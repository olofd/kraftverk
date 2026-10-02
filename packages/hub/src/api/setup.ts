import { ApiError, type Caller, type KraftverkApi, type TransportView } from '@kraftverk/api-contract';

import type { Hub } from '../hub.ts';
import { actorOf } from './caller.ts';

/*
  Adding a device (docs/DATA-MODEL.md §1), what is near, and what the home
  reaches devices over, as everything that uses a home asks for them. Each
  draft is its starter's: another caller is told it has expired, as it has
  for them.
*/

type SetupApi = Pick<KraftverkApi, 'setup' | 'nearby' | 'transports'>;

export function setupApi(hub: Hub, caller: Caller): SetupApi {
  const { setup, registry, nearby } = hub;
  const { transports } = hub.installed;
  const actor = actorOf(caller);
  /** The draft asked for, if it is this caller's. */
  const own = (id: string): string => {
    setup.assertOwner(id, actor);
    return id;
  };
  const record = (kind: string, device: string, summary: string) => hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind: 'device', resource: device, summary });

  return {
    setup: {
      start: async ({ holder, ...input }) => {
        // A way an app holds for a server is set up by that app, holding it: a home holds every way it adds itself.
        if (holder === 'this-app') throw new ApiError('invalid', 'This home holds every way it adds itself: only an app holding ways for a server sets one up for itself');
        return setup.start({ ...input, by: actor });
      },
      /** One an app will hold: the app speaks for itself only, and must be the caller's account's. */
      async startHeld(input) {
        const app = hub.clients.get(input.clientId);
        const account = caller.kind === 'person' ? caller.account : undefined;
        if (!app || !account || app.userId !== account) throw new ApiError('not-found', 'No such app');
        return setup.startHeld({ ...input, clientId: app.id, by: actor });
      },
      get: async (id) => setup.view(own(id)),
      discard: async (id) => setup.discard(own(id)),
      sightings: async (id) => setup.sightings(own(id)),
      choose: async (id, choice) => setup.choose(own(id), choice),
      update: async (id, values) => setup.update(own(id), values),
      action: (id, step, action, input, signal) => setup.action(own(id), step, action, input, signal),
      discover: (id, step, signal) => setup.discover(own(id), step, signal),
      check: (id) => setup.check(own(id)),

      /** Saved in one go — the device, its connection, the connection's secrets, its links — and then its session opens. */
      async save(id, input) {
        const device = await setup.save(own(id), { ...input, name: input.name ?? '', mode: input.mode ?? 'new' });
        if (input.anyway) record('device.saved-unchecked', device.id, `"${device.name}" was saved without answering the check`);
        if (input.secretsExportable) record('device.exportable', device.id, `"${device.name}": its secrets may leave in an export as plain text`);
        hub.bus.publish({ kind: 'changed', deviceId: null });
        const view = registry.find(device.id);
        if (!view) throw new ApiError('not-found', 'No such device');
        return view;
      },
    },

    /** "Found near you": what can be seen that nothing you have is reached by. The first ask starts watching. */
    nearby: async () => nearby.list(),

    transports: {
      /** What this home can reach devices over: each transport, whether it runs, what it can see, its diagnostics by name. */
      async list() {
        return {
          readOnly: hub.readOnly(),
          transports: transports.definitions().map((definition): TransportView => {
            const transport = transports.get(definition.id);
            return {
              ...definition,
              holder: 'home',
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
