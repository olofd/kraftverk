import type { WebPushSubscription } from '@kraftverk/api-client';

/*
  Notifications pushed to this device (docs/PLAN-WORLD-MODEL.md §8.14). On
  a phone, the platform's own push — APNs, FCM — comes with a native build
  that can register; until then a phone has its inbox, read when the app is
  open. The web's is push.web.ts.
*/

/** Whether this device can be woken with a notification, and why not. */
export function pushHere(): { can: true } | { can: false; why: string } {
  return { can: false, why: 'On a phone, notifications come with the app’s own build: until then, read them in the app' };
}

export async function subscribePush(_publicKey: string): Promise<WebPushSubscription> {
  throw new Error('This device cannot be woken with a notification yet');
}

export async function pushSubscribed(): Promise<boolean> {
  return false;
}

export async function unsubscribePush(): Promise<void> {}
