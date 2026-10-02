import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  Adding a device (docs/DATA-MODEL.md §1), as everything that uses a home
  asks for it. Each draft is its starter's: another caller is told it has
  expired, as it has for them.
*/

type SetupApi = Pick<KraftverkApi, 'setup'>;

export function setupApi(hub: Hub, caller: Caller): SetupApi {
  const { setup, views } = hub;
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
        // A way a node holds for the master is set up by that node, holding it: the master holds every way it adds itself.
        if (holder === 'this-node') throw new ApiError('conflict', 'This node holds every way it adds itself: only a node that follows a home sets one up for itself');
        return setup.start({ ...input, by: actor });
      },
      /** One a node that follows the home will hold: it speaks for itself only, and must be the caller's account's. */
      async startHeld(input) {
        const node = hub.nodes.get(input.nodeId);
        const account = caller.kind === 'person' ? (caller.account ?? null) : undefined;
        if (!node || node.self || account === undefined || node.accountId !== account) throw new ApiError('not-found', 'No such node');
        return setup.startHeld({ ...input, nodeId: node.id, by: actor });
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
        const view = views.find(device.id);
        if (!view) throw new ApiError('not-found', 'No such device');
        return view;
      },
    },

  };
}
