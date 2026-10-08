/*
  kraftverk's service worker, for notifications pushed to this browser
  (docs/PLAN-WORLD-MODEL.md §8.14): the server's push, sealed to this
  browser, opened here and shown — and a tap on it opens the app's inbox.
  It caches nothing: the app is always the server's, as it is now.
*/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = { title: 'kraftverk', body: null, id: null, level: 'info' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // Not what the server sends: shown as it is, if it said anything.
    if (event.data) message.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body ?? undefined,
      // One notification once: the same one pushed twice replaces itself.
      tag: message.id ?? undefined,
      requireInteraction: message.level === 'alarm',
      data: { id: message.id },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
      if (open) return open.focus().then((focused) => focused?.navigate?.('/notifications'));
      return self.clients.openWindow('/notifications');
    })
  );
});
