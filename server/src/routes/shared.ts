import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { savedDeviceId } from '@kraftverk/device-sdk';

import type { ActionGateway } from '@kraftverk/gateway';
import { actorOf, userOf } from '../auth/routes.ts';
import type { LoginLimiter } from '../auth/limiter.ts';
import type { ProxyDirectory } from '../auth/trust.ts';
import type { ServerConfig } from '../config.ts';
import type { DeviceCatalog, DeviceRecord } from '../devices/catalog.ts';
import type { ClientStore } from '../devices/clients.ts';
import type { ConnectionStore } from '../devices/connections.ts';
import type { LinkStore } from '../devices/links.ts';
import type { Nearby } from '../devices/nearby.ts';
import type { DeviceRegistry } from '../devices/registry.ts';
import type { RemoteReadings } from '../devices/remote.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import type { SetupService } from '../devices/setup.ts';
import type { DeviceTypeRegistry } from '../devices/types.ts';
import { audit } from '../history/db.ts';
import type { Sampler } from '../history/sampler.ts';
import type { ServerLog } from '../log.ts';
import type { ProtocolRegistry } from '../runtime/protocols.ts';
import type { TransportHost } from '../runtime/transports.ts';

/**
 * Everything the routes need, handed in rather than reached for.
 *
 * The server builds these at startup — transports, sessions, the gateway — and
 * a test builds them around simulators and a throwaway database. The routes
 * cannot tell the difference, which is the point.
 */
export type AppDeps = {
  config: ServerConfig;
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  clients: ClientStore;
  /** The device types installed on this server. */
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
  /** One open session per saved device the server holds. */
  sessions: DeviceSessionManager;
  registry: DeviceRegistry;
  setup: SetupService;
  /** What the transports can see that nothing you have is reached by. */
  nearby: Nearby;
  /** Readings from connections an app holds. */
  remote: RemoteReadings;
  gateway: ActionGateway;
  sampler: Sampler;
  proxies: ProxyDirectory;
  serverLog: Pick<ServerLog, 'dir' | 'recent'>;
  startedAt: Date;
  /** Login guessing; a fresh one unless a test wants to share it. */
  limiter?: LoginLimiter;
};

/**
 * Parses and validates a JSON body.
 *
 * Deliberately not @hono/zod-validator: that package hoists to the workspace
 * root where it binds to the zod v3 an Expo dependency pulls in, while this
 * package is on zod v4. Validating inline keeps one zod and full type inference.
 */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  });
  return schema.parse(raw);
}

/**
 * Records what happened, and who did it.
 *
 * Adding, renaming and removing a device all write here. Deleting one's
 * history is the destructive one, and a device that vanishes with no entry
 * anywhere is one nobody can account for afterwards.
 */
export const auditDevice = (c: Context, kind: string, id: string, summary: string, detail?: unknown) =>
  audit({ at: new Date().toISOString(), kind, actor: actorOf(c), resource: id, summary, detail });

/**
 * The device a route names, or a 404. There is no inference here, not even
 * "when there is only one": a route that guesses right while you own one
 * device guesses wrong, silently, the day you own two.
 */
/**
 * A phone or browser of the signed-in account, or a 404. An app speaks for
 * connections it holds only, and a client id is not a secret: it is checked
 * against the account every time.
 */
export function ownClient(clients: ClientStore, c: Context, id: string | undefined) {
  const user = userOf(c);
  const client = id ? clients.get(id) : null;
  if (!user || !client || client.userId !== user.id) throw new HTTPException(404, { message: 'No such app' });
  return client;
}

export function deviceOr404(catalog: DeviceCatalog, id: string | undefined, { removed = false } = {}): DeviceRecord {
  // Hono has decoded it already; decoding again turned an id with a % into a 500.
  const record = id ? (removed ? catalog.get(savedDeviceId(id)) : catalog.active(savedDeviceId(id))) : null;
  if (!record) throw new HTTPException(404, { message: 'No such device' });
  return record;
}
