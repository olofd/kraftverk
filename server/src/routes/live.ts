import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';

import type { ConnectionHealth, LiveUpdate } from '@kraftverk/api-contract';
import type { Reading, SavedDeviceId } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import { hostName } from '../auth/host.ts';
import { SESSION_COOKIE } from '../auth/routes.ts';
import { sessionAlive } from '../auth/store.ts';
import type { AppDeps } from './shared.ts';

/**
 * `GET /api/live`: what changed, as it changes — a WebSocket (docs/API.md).
 *
 * What devices say reaches the server's bus as it happens (the session
 * manager publishes what moved); this passes it on to every app that is
 * listening, so none has to ask every few seconds. Server to app only: what
 * an app sends is ignored.
 *
 * Per socket, what is waiting is coalesced — a reading by its key, health by
 * its device — and sent at most four times a second, so a device that
 * chatters costs a phone nothing extra, and a slow phone is sent the latest
 * rather than a backlog.
 *
 * The gate in front of every route has already asked who this is. Two more
 * things a socket needs, that a request does not:
 *
 * - **Where it was opened from.** A browser cannot add the header that stops
 *   forged requests to a WebSocket, but it does say which page opened it. A
 *   socket opened by another website — which would carry your cookie — is
 *   refused. The native app sends no Origin, and is not a browser page.
 * - **That the session still stands.** A socket outlives the request that
 *   opened it; it is closed when you sign out or the session ends, checked
 *   every minute without renewing it.
 */

const FLUSH_MS = 250;
const SESSION_CHECK_MS = 60_000;
/** Beyond this much unsent, a socket is sent nothing until it drains: the latest is kept, not a backlog. */
const MAX_BUFFERED_BYTES = 1 << 20;
/** Events kept for a socket that is not draining; past this, it is told to read everything again instead. */
const MAX_QUEUED_EVENTS = 100;
/** Closed because the session it was opened with has ended. */
export const SIGNED_OUT = 4401;

/** Whether a browser page at `origin` may open a socket to this server. */
export function originAllowed(origin: string | undefined, requestHost: string | undefined, deps: Pick<AppDeps, 'config'>, cors: (origin: string) => string | null): boolean {
  if (!origin) return true; // not a browser page: the native app
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // The same host that was asked: the app this server's web container serves.
  if (requestHost && url.host.toLowerCase() === requestHost.trim().toLowerCase()) return true;
  // A name this server is reached by, through a proxy in front of it.
  const name = hostName(url.host);
  if (name && deps.config.allowedHosts.has(name)) return true;
  // An origin allowed to call the API with the session anyway.
  return cors(origin) !== null;
}

/** What one socket has waiting. */
class Outbox {
  readings = new Map<SavedDeviceId, Map<string, Reading>>();
  health = new Map<SavedDeviceId, ConnectionHealth>();
  events: LiveUpdate[] = [];
  changed = false;

  add(message: LiveMessage): void {
    switch (message.kind) {
      case 'readings': {
        const waiting = this.readings.get(message.deviceId) ?? new Map<string, Reading>();
        for (const reading of message.readings) waiting.set(reading.key, reading);
        this.readings.set(message.deviceId, waiting);
        return;
      }
      case 'health':
        this.health.set(message.deviceId, message.health);
        return;
      case 'event':
        if (this.events.length >= MAX_QUEUED_EVENTS) {
          this.events = [];
          this.changed = true;
          return;
        }
        this.events.push({ type: 'event', deviceId: message.deviceId, event: message.event });
        return;
      case 'described':
      case 'changed':
        this.changed = true;
    }
  }

  /** Everything waiting, in the order it is best applied, and empties. */
  take(): LiveUpdate[] {
    const updates: LiveUpdate[] = [];
    // Read the list again first: what follows is applied on top of it.
    if (this.changed) updates.push({ type: 'changed', deviceId: null });
    for (const [deviceId, readings] of this.readings) updates.push({ type: 'readings', deviceId, readings: [...readings.values()] });
    for (const [deviceId, health] of this.health) updates.push({ type: 'health', deviceId, health });
    updates.push(...this.events);
    this.readings.clear();
    this.health.clear();
    this.events = [];
    this.changed = false;
    return updates;
  }
}

export function liveRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket, cors: (origin: string) => string | null): Hono {
  const api = new Hono();

  const fromHere: MiddlewareHandler = async (c, next) => {
    if (!originAllowed(c.req.header('origin'), c.req.header('host'), deps, cors)) {
      return c.json({ error: 'A live stream can only be opened by this server’s own app' }, 403);
    }
    await next();
  };

  api.get(
    '/live',
    fromHere,
    upgradeWebSocket((c) => {
      const token = getCookie(c, SESSION_COOKIE);
      const outbox = new Outbox();
      let stop = () => {};

      return {
        onOpen: (_event, ws: WSContext) => {
          const send = (update: LiveUpdate) => ws.send(JSON.stringify(update));
          /*
            A send is scheduled when something is waiting, at most every
            FLUSH_MS, and never while nothing is: an idle socket costs no timer.
            A client that is not reading keeps it waiting — its backlog
            coalesces in the outbox rather than in the socket's buffer.
          */
          let pending: ReturnType<typeof setTimeout> | null = null;
          const flush = () => {
            pending = null;
            const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
            if ((raw?.getBufferedAmount?.() ?? 0) > MAX_BUFFERED_BYTES) return schedule();
            for (const update of outbox.take()) send(update);
          };
          const schedule = () => {
            pending ??= setTimeout(flush, FLUSH_MS);
          };
          const unsubscribe = deps.bus.subscribe((message) => {
            outbox.add(message);
            schedule();
          });
          const watch = setInterval(() => {
            if (!sessionAlive(token)) ws.close(SIGNED_OUT, 'Signed out');
          }, SESSION_CHECK_MS);
          stop = () => {
            unsubscribe();
            if (pending) clearTimeout(pending);
            pending = null;
            clearInterval(watch);
          };
          send({ type: 'hello', at: new Date().toISOString() });
        },
        onClose: () => stop(),
        onError: () => stop(),
      };
    })
  );

  return api;
}
