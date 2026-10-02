import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { Caller, KraftverkApi } from '@kraftverk/api-contract';

import type { ActionGateway } from '@kraftverk/gateway';
import type { LiveBus } from '@kraftverk/holder';
import type { Attention, Configuration, DeviceRegistry, DeviceTypeRegistry, Hub, Nearby, ProtocolRegistry, RemoteReadings, Sampler, SetupService, TransportHost } from '@kraftverk/hub';
import type { AutomationEngine, AutomationLibrary } from '@kraftverk/automation-engine';
import type { AutomationStore, DeviceCatalog, ClientStore, ConnectionStore, LinkStore, EventStore } from '@kraftverk/store';
import { actorOf, userOf } from '../auth/routes.ts';
import type { LoginLimiter } from '../auth/limiter.ts';
import type { ProxyDirectory } from '../auth/trust.ts';
import type { ServerConfig } from '../config.ts';
import type { SessionManager } from '@kraftverk/holder';
import type { ConfigSnapshot } from '../platform/snapshot.ts';
import type { ServerLog } from '../log.ts';

/**
 * Everything the routes need, handed in rather than reached for.
 *
 * The server builds these at startup — transports, sessions, the gateway — and
 * a test builds them around simulators and a throwaway database. The routes
 * cannot tell the difference, which is the point.
 */
export type AppDeps = {
  /** The home: what the routes adapt from HTTP to (`hub.as(caller)`). */
  hub: Hub;
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
  sessions: SessionManager;
  registry: DeviceRegistry;
  setup: SetupService;
  /** What the transports can see that nothing you have is reached by. */
  nearby: Nearby;
  /** Readings from connections an app holds. */
  remote: RemoteReadings;
  gateway: ActionGateway;
  /** What devices said happened. */
  events: EventStore;
  /** What devices say as they say it, and what changed: the live stream's source. */
  bus: LiveBus;
  /** What each app with the live stream open says its screen shows, now. */
  attention: Attention;
  automations: AutomationStore;
  engine: AutomationEngine;
  /** The recipes and functions the installed packages bring. */
  library: AutomationLibrary;
  sampler: Sampler;
  proxies: ProxyDirectory;
  serverLog: Pick<ServerLog, 'dir' | 'recent'>;
  startedAt: Date;
  /** Login guessing; a fresh one unless a test wants to share it. */
  limiter?: LoginLimiter;
  /** The home's configuration: its export, its import, its restore (docs/CONFIG.md). */
  configuration: Configuration;
  /** The configuration kept beside the database, as a file; none in a test that does not ask for one. */
  snapshot?: ConfigSnapshot;
};

/** What the routes need of a home, from the hub that runs it: everything in `AppDeps` but the server's own. */
export type HomeDeps = Omit<AppDeps, 'config' | 'proxies' | 'serverLog' | 'startedAt' | 'limiter' | 'snapshot'>;

export const homeOf = (hub: Hub): HomeDeps => ({
  hub,
  catalog: hub.catalog,
  connections: hub.connections,
  links: hub.links,
  clients: hub.clients,
  types: hub.installed.types,
  protocols: hub.installed.protocols,
  transports: hub.installed.transports,
  sessions: hub.sessions,
  registry: hub.registry,
  setup: hub.setup,
  nearby: hub.nearby,
  remote: hub.remote,
  gateway: hub.gateway,
  events: hub.events,
  bus: hub.bus,
  attention: hub.attention,
  automations: hub.automations,
  engine: hub.engine,
  library: hub.library,
  sampler: hub.sampler,
  configuration: hub.configuration,
});

/** Who a request is, to the home: the person signed in on it. */
export const callerOf = (c: Context): Caller => {
  const account = userOf(c)?.id;
  return { kind: 'person', name: actorOf(c), ...(account ? { account } : {}) };
};

/** The home, as the person a request is from asks it. */
export const homeFor = (deps: Pick<AppDeps, 'hub'>, c: Context): KraftverkApi => deps.hub.as(callerOf(c));

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
