import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';
import { SYSTEM } from '@kraftverk/device-sdk';

import type { Hub } from '../node/hub.ts';
import { notify } from '../notifications/notify.ts';
import { readerOf } from '../presence/levels.ts';

/*
  A person's notifications (docs/PLAN-WORLD-MODEL.md §8.14), as they ask for
  them: their own inbox, never anyone else's; where their apps are woken;
  and a test, to see that a push reaches them.
*/

export function notificationsApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'notifications'> {
  /** Who asks: only a person has an inbox. */
  const me = (): string => {
    const id = readerOf(caller);
    if (!id || !hub.people.get(id)?.member) throw new ApiError('forbidden', 'Only a person in the family has notifications');
    return id;
  };
  return {
    notifications: {
      list: async () => hub.notifications.inbox(me()),

      async read(id) {
        const person = me();
        if (id && hub.notifications.ownerOf(id) !== person) throw new ApiError('not-found', 'No such notification');
        hub.notifications.read(person, id, new Date().toISOString());
      },

      pushKey: async () => hub.push?.publicKey() ?? null,

      async keepPushEndpoint(nodeId, subscription) {
        const person = me();
        if (!hub.push) throw new ApiError('unavailable', 'This family is kept where nothing sends a push: its server does');
        if (!/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new ApiError('invalid', 'That is not a push subscription');
        hub.notifications.keepEndpoint({ nodeId, personId: person, provider: 'webpush', token: JSON.stringify(subscription) }, new Date().toISOString());
      },

      async forgetPushEndpoint(nodeId) {
        const person = me();
        if (hub.notifications.endpointsOf(person).some((endpoint) => endpoint.nodeId === nodeId)) hub.notifications.forgetEndpoint(nodeId);
      },

      async test() {
        return notify(hub.notifications, hub.push ?? null, me(), { title: 'A test from kraftverk', body: 'If you see this where you are, kraftverk can reach you.', from: SYSTEM });
      },
    },
  };
}
