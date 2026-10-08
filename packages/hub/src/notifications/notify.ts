import type { NotificationView } from '@kraftverk/api-contract';
import type { Actor } from '@kraftverk/device-sdk';
import type { NotificationStore, PushEndpoint } from '@kraftverk/store';

/*
  Telling a person something (docs/PLAN-WORLD-MODEL.md §8.14): it goes in
  their inbox, and to every app of theirs that can be woken — by a push the
  place sends (the server: web push today; APNs and FCM with a native
  build). An app whose push service says it is gone is forgotten. Where no
  push is sent — a family on a phone — the inbox is all there is.
*/

/** How the place wakes an app: given by the server; none where there is no server to send from. */
export type PushSender = {
  /** The public half of the key pushes are signed with: what a browser subscribes with. */
  publicKey(): string;
  /** Sends one push: sent, the app gone for good, or failed this time. */
  send(endpoint: PushEndpoint, message: { id: string; title: string; body: string | null; level: NotificationView['level'] }): Promise<'sent' | 'gone' | 'failed'>;
};

export type NotifyInput = { title: string; body?: string | null; level?: NotificationView['level']; homeId?: string | null; from: Actor };

export async function notify(store: NotificationStore, push: PushSender | null, personId: string, input: NotifyInput): Promise<NotificationView> {
  const at = new Date().toISOString();
  const said = store.add({ personId, homeId: input.homeId ?? null, level: input.level ?? 'info', title: input.title, body: input.body ?? null, from: input.from, at });
  if (!push) return said;
  let sent = false;
  for (const endpoint of store.endpointsOf(personId)) {
    const result = await push.send(endpoint, { id: said.id, title: said.title, body: said.body, level: said.level }).catch(() => 'failed' as const);
    if (result === 'gone') store.forgetEndpoint(endpoint.nodeId);
    if (result === 'sent') sent = true;
  }
  if (sent) store.delivered(said.id, new Date().toISOString());
  return store.get(said.id)!;
}
