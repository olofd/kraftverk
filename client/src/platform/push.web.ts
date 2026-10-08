import type { WebPushSubscription } from '@kraftverk/api-client';

/*
  Notifications pushed to this browser (docs/PLAN-WORLD-MODEL.md §8.14):
  kraftverk's service worker (public/sw.js) registered, the browser asked
  once, and its push subscription — sealed to it, signed for by the
  server's key — given to the server for this app. Only on a secure page:
  a browser gives plain HTTP no push.
*/

/** Whether this browser can be woken with a notification, and why not. */
export function pushHere(): { can: true } | { can: false; why: string } {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { can: false, why: 'This browser cannot be woken with a notification' };
  if (!window.isSecureContext) return { can: false, why: 'Plain HTTP gets no notifications: open kraftverk over HTTPS' };
  if (Notification.permission === 'denied') return { can: false, why: 'This browser was told not to show kraftverk’s notifications: allow them in its site settings' };
  return { can: true };
}

/** The server's public key, as PushManager wants it. */
const keyBytes = (key: string): Uint8Array<ArrayBuffer> => {
  const base64 = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

/** Asks the person — once — then subscribes this browser with the server's key. */
export async function subscribePush(publicKey: string): Promise<WebPushSubscription> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed in this browser');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = subscription.toJSON();
  return { endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! } };
}

/** Whether this browser is subscribed already. */
export async function pushSubscribed(): Promise<boolean> {
  if (pushHere().can !== true) return false;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  return Boolean(await registration?.pushManager.getSubscription());
}

export async function unsubscribePush(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
}
