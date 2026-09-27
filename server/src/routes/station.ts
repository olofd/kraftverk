import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { stationId } from '@kraftverk/plugin-sdk';

import { BleHost } from '../transport/ble.ts';
import type { ServerTransportKind } from '../transport/types.ts';
import { auditDevice, bindTarget, body, type AppDeps } from './shared.ts';

/**
 * Which stations the server's transports can see, and which saved device holds
 * which. Distinct from `/api/devices`: "device" means a thing you own, not a
 * station a radio happened to notice.
 */
export function stationRoutes({ config, connections, catalog }: AppDeps): Hono {
  const routes = new Hono();

  routes.get('/transports', (c) => {
    /*
      Every transport this server offers, and everything all of them can see.
      A discovered station carries its own `kind`, so a Bluetooth peripheral
      and a station on the broker sit in one list without either pretending to
      be the other.
    */
    const seen = connections.hosts.flatMap(({ host }) => host.discovered());
    const linked = connections.hosts.flatMap(({ host }) => host.openIds());
    const ble = connections.hosts.find(({ kind }) => kind === 'ble')?.host;

    return c.json({
      /** Every transport offered, whether or not it started, and why if it didn't. */
      transports: (config.simulate ? ['sim'] : connections.transports).map((kind) => ({
        kind,
        running: kind === 'sim' || connections.hosts.some((entry) => entry.kind === kind),
        error: kind === 'sim' ? null : connections.transportError(kind as ServerTransportKind),
      })),
      autoBind: config.autoBind,
      lastError: ble instanceof BleHost ? ble.lastError : null,
      attempts: ble instanceof BleHost ? ble.attempts : null,
      /*
        One entry per saved station, each naming the device that holds it.
        There is deliberately no top-level `boundId` — a single one would
        describe one station under a heading implying it is the only one.
      */
      links: connections.sessions
        .filter((session) => session.kind !== 'sim')
        .map((session) => ({
          deviceId: session.deviceId,
          name: catalog.get(session.deviceId)?.name ?? session.deviceId,
          transport: session.kind,
          stationId: session.link?.boundId ?? null,
          connected: session.link?.connected ?? false,
          refusal: connections.refusal(session.deviceId),
        })),
      devices: seen.map((d) => ({ ...d, bound: linked.includes(stationId(d.id)) })),
    });
  });

  /**
   * Binds a saved device to a station. The choice goes to the device's own
   * record, so a restart reconnects *that* device.
   */
  routes.post('/bind', async (c) => {
    if (config.simulate) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
    const { id, deviceId } = await body(c, z.object({ id: z.string().min(1).max(64), deviceId: z.string().optional() }));

    const target = bindTarget(connections, deviceId);
    await connections.bind(target, stationId(id));
    auditDevice(c, 'station.bound', target, `Linked to station ${id}`);
    const session = connections.get(target);

    return c.json({ deviceId: target, boundId: session?.link?.boundId ?? null, connected: session?.link?.connected ?? false });
  });

  routes.post('/unbind', async (c) => {
    if (config.simulate) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
    const { deviceId } = await body(c, z.object({ deviceId: z.string().optional() }).catch({}));

    const target = bindTarget(connections, deviceId);
    await connections.unbind(target);
    auditDevice(c, 'station.unbound', target, 'Unlinked from its station');

    return c.json({ deviceId: target, boundId: null, connected: false });
  });

  return routes;
}
