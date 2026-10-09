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

/** How long one push is waited for: a push service that does not answer is a push that failed this time. */
const PUSH_WITHIN_MS = 10_000;

/** Told, and pushed — waited for: what a person asking for a test sees come back delivered or not. */
export async function notify(store: NotificationStore, push: PushSender | null, personId: string, input: NotifyInput): Promise<NotificationView> {
  const said = inbox(store, personId, input);
  await pushed(store, push, personId, said);
  return store.get(said.id)!;
}

/**
 * Told now — in their inbox at once — and pushed on its way, waited for by
 * nobody: what an automation does, so one slow push service holds up no
 * other automation, and no other person.
 */
export function tell(store: NotificationStore, push: PushSender | null, personId: string, input: NotifyInput): NotificationView {
  const said = inbox(store, personId, input);
  void pushed(store, push, personId, said).catch((error) => console.error('[notifications] a push could not be sent:', error));
  return said;
}

const inbox = (store: NotificationStore, personId: string, input: NotifyInput): NotificationView =>
  store.add({ personId, homeId: input.homeId ?? null, level: input.level ?? 'info', title: input.title, body: input.body ?? null, from: input.from, at: new Date().toISOString() });

/** To every app of theirs that can be woken, all at once, each within its time: one gone for good is forgotten. */
async function pushed(store: NotificationStore, push: PushSender | null, personId: string, said: NotificationView): Promise<void> {
  if (!push) return;
  const results = await Promise.all(
    store.endpointsOf(personId).map(async (endpoint) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'failed'>((resolve) => (timer = setTimeout(() => resolve('failed'), PUSH_WITHIN_MS)));
      const result = await Promise.race([push.send(endpoint, { id: said.id, title: said.title, body: said.body, level: said.level }).catch(() => 'failed' as const), late]);
      clearTimeout(timer);
      if (result === 'gone') store.forgetEndpoint(endpoint.nodeId);
      return result;
    })
  );
  if (results.includes('sent')) store.delivered(said.id, new Date().toISOString());
}
