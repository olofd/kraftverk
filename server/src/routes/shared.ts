import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { savedDeviceId, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { ActionGateway } from '../actions/gateway.ts';
import { actorOf } from '../auth/routes.ts';
import type { LoginLimiter } from '../auth/limiter.ts';
import type { ProxyDirectory } from '../auth/trust.ts';
import type { BrokerBus } from '../mqtt/bus.ts';
import type { BrokerSupervisor } from '../broker/supervisor.ts';
import type { ServerConfig } from '../config.ts';
import type { ConnectionManager, StationSession } from '../connections/manager.ts';
import type { DeviceCatalog } from '../devices/catalog.ts';
import type { LegacyStationImport } from '../devices/legacy.ts';
import type { DeviceRegistry } from '../devices/registry.ts';
import type { DeviceSessionManager } from '../devices/sessions.ts';
import type { DeviceTypeRegistry } from '../devices/types.ts';
import type { DeviceDriver } from '../drivers/device.ts';
import { audit } from '../history/db.ts';
import type { Sampler } from '../history/sampler.ts';
import type { ServerLog } from '../log.ts';
import type { PluginHost } from '../plugins/host.ts';

/** The broker, when this server runs the MQTT transport. */
export type BrokerDeps = {
  supervisor: BrokerSupervisor;
  bus: BrokerBus;
  /** A GET against the broker's admin API; null when it does not answer. */
  admin<T>(path: string): Promise<T | null>;
};

/**
 * Everything the routes need, handed in rather than reached for.
 *
 * The server builds these at startup — broker, radios, plugins — and a test
 * builds them around the simulator and a throwaway database. The routes cannot
 * tell the difference, which is the point.
 */
export type AppDeps = {
  config: ServerConfig;
  catalog: DeviceCatalog;
  /** The device types installed on this server. */
  types: DeviceTypeRegistry;
  /** One open session per saved device. Syncing it also syncs the station links. */
  sessions: DeviceSessionManager;
  /** The station links, until a station session holds its own (step 7). */
  connections: ConnectionManager;
  host: PluginHost;
  registry: DeviceRegistry;
  gateway: ActionGateway;
  sampler: Sampler;
  legacyStation: LegacyStationImport;
  proxies: ProxyDirectory;
  serverLog: Pick<ServerLog, 'dir' | 'recent'>;
  broker: BrokerDeps | null;
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
 * Adding, renaming and *forgetting* a device used to write nothing at all.
 * Forgetting is the destructive one: it takes the device's entire recorded
 * history with it, and a device that vanishes with no entry anywhere is one
 * nobody can account for afterwards.
 */
export const auditDevice = (c: Context, kind: string, id: string, summary: string, detail?: unknown) =>
  audit({ at: new Date().toISOString(), kind, actor: actorOf(c), resource: id, summary, detail });

/**
 * The saved station a request names, or a 404.
 *
 * There is no inference here, deliberately — not even "when there is only one".
 * A route that guesses correctly while you own one device is a route that
 * guesses *wrongly* the day you own two, and it does so silently.
 */
export function stationSession(connections: ConnectionManager, deviceId: string | undefined): StationSession {
  if (!deviceId) throw new HTTPException(400, { message: 'Name the device with deviceId' });
  // Hono has decoded it already; decoding again turned an id with a % into a 500.
  const session = connections.get(savedDeviceId(deviceId));
  if (!session) throw new HTTPException(404, { message: 'No such device, or it has no open session' });
  return session;
}

/** Register-level access, which only real hardware has. Always by device id. */
export function hardwareOr400(connections: ConnectionManager, deviceId: string | undefined): DeviceDriver {
  const session = stationSession(connections, deviceId);
  if (!session.device) {
    throw new HTTPException(400, { message: 'That device has no hardware link (STATION_DRIVER=device or ble)' });
  }
  return session.device;
}

/** Which saved device a bind or a raw frame acts on. Named, never inferred. */
export const bindTarget = (connections: ConnectionManager, deviceId: string | undefined): SavedDeviceId =>
  stationSession(connections, deviceId).deviceId;
