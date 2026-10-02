import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';

import { z } from 'zod';

import type { ConnectionHealth, LiveUpdate, ShownThing, ViewReport } from '@kraftverk/api-contract';
import { automationId, savedDeviceId, type AutomationId, type Reading, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import type { ViewerHandle } from '@kraftverk/hub';
import { hostName } from '../auth/host.ts';
import { SESSION_COOKIE, userOf } from '../auth/routes.ts';
import { sessionAlive } from '../auth/store.ts';
import type { AppDeps } from './shared.ts';

/**
 * `GET /api/live`: what changed, as it changes — a WebSocket (docs/API.md).
 *
 * What devices say reaches the server's bus as it happens (the session
 * manager publishes what moved); this passes it on to every app that is
 * listening, so none has to ask every few seconds. The one thing an app says
 * back is what its screen shows (`ViewReport`), kept in the server's
 * attention while the socket is open (`attention/attention.ts`); anything
 * else it sends is ignored.
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

/** What an app may say its screen shows; anything else it sends is not read. */
const SHOWN_ID = z.string().min(1).max(64);
const VIEW_REPORT = z
  .object({
    type: z.literal('view'),
    screen: z.string().min(1).max(64),
    showing: z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('device'), id: SHOWN_ID }).strict(), z.object({ kind: z.literal('automation'), id: SHOWN_ID }).strict()])).max(500),
  })
  .strict();
/** Larger than any view an app could say: not parsed. */
const MAX_REPORT_BYTES = 64 * 1024;

/** What an app said, if it is a view of its screen. */
export function viewReportOf(data: unknown): ViewReport | null {
  if (typeof data !== 'string' || data.length > MAX_REPORT_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = VIEW_REPORT.safeParse(json);
  if (!parsed.success) return null;
  // Where a string off the wire becomes an id: named, as at every edge.
  const showing = parsed.data.showing.map((thing): ShownThing => (thing.kind === 'device' ? { kind: 'device', id: savedDeviceId(thing.id) } : { kind: 'automation', id: automationId(thing.id) }));
  return { type: 'view', screen: parsed.data.screen, showing };
}

/** What one socket has waiting. */
class Outbox {
  readings = new Map<SavedDeviceId, Map<string, Reading>>();
  health = new Map<SavedDeviceId, ConnectionHealth>();
  events: LiveUpdate[] = [];
  changed = false;
  /** Automations that moved: each is said once, however often it moved since. */
  automations = new Set<AutomationId>();

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
        return;
      case 'automation':
        this.automations.add(message.automationId);
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
    for (const id of this.automations) updates.push({ type: 'automation', id });
    this.readings.clear();
    this.health.clear();
    this.events = [];
    this.changed = false;
    this.automations.clear();
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
      const person = userOf(c)?.username ?? null;
      const outbox = new Outbox();
      let viewer: ViewerHandle | null = null;
      let stop = () => {};

      return {
        onMessage: (event) => {
          const view = viewReportOf(event.data);
          if (view) viewer?.report(view);
        },
        onOpen: (_event, ws: WSContext) => {
          viewer = deps.attention.open(person);
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
            viewer?.close();
            viewer = null;
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
