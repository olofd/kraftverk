import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';

import { z } from 'zod';

import { SIGNED_OUT, type LiveStream, type ShownThing, type ViewReport } from '@kraftverk/api-contract';
import { automationId, savedDeviceId } from '@kraftverk/device-sdk';

import { hostName } from '../auth/host.ts';
import { SESSION_COOKIE } from '../auth/routes.ts';
import { homeFor, type AppDeps } from './context.ts';

/**
 * `GET /api/live`: what changed, as it changes — a WebSocket (docs/API.md).
 *
 * What goes out is the home's (`KraftverkApi.live`): what its devices say,
 * coalesced, at most four times a second, so none has to ask every few
 * seconds. The one thing an app says back is what its screen shows
 * (`ViewReport`), kept in the home's attention while the socket is open;
 * anything else it sends is ignored. A socket that is not draining is sent
 * the latest, not a backlog.
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

const SESSION_CHECK_MS = 60_000;
/** Beyond this much unsent, a socket is sent nothing until it drains: the latest is kept, not a backlog. */
const MAX_BUFFERED_BYTES = 1 << 20;

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
  /*
    A name this server is reached by, through a proxy in front of it — on
    its scheme's own port. A cookie is not kept per port, so another site on
    the same name at another port (a NAS's own pages, say) would otherwise
    open a socket with your session. A proxy on a port of its own passes on
    that Host, and is the same host asked, above.
  */
  const name = hostName(url.host);
  if (name && url.port === '' && deps.config.allowedHosts.has(name)) return true;
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
function viewReportOf(data: unknown): ViewReport | null {
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
      const home = homeFor(deps, c);
      let stream: LiveStream | null = null;
      let stop = () => {};

      return {
        onMessage: (event) => {
          const view = viewReportOf(event.data);
          if (view) stream?.say(view);
        },
        onOpen: (_event, ws: WSContext) => {
          const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
          stream = home.live((update) => ws.send(JSON.stringify(update)), { draining: () => (raw?.getBufferedAmount?.() ?? 0) <= MAX_BUFFERED_BYTES });
          const watch = setInterval(() => {
            if (!deps.accounts.sessionAlive(token)) ws.close(SIGNED_OUT, 'Signed out');
          }, SESSION_CHECK_MS);
          stop = () => {
            stream?.close();
            stream = null;
            clearInterval(watch);
          };
        },
        onClose: () => stop(),
        onError: () => stop(),
      };
    })
  );

  return api;
}
