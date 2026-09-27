import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { savedDeviceId } from '@kraftverk/plugin-sdk';

import { actorOf } from '../auth/routes.ts';
import { pairedStation, pairStation } from '../devices/relay-pairing.ts';
import { auditDevice, body, type AppDeps } from './shared.ts';

/** The grid relay: its state, which station it feeds, and switching it. */
export function gridRoutes({ catalog, connections, host, gateway }: AppDeps): Hono {
  const grid = new Hono();

  grid.get('/', async (c) => {
    const provider = host.activeProvider('gridRelay');
    const paired = pairedStation();
    return c.json({
      provider,
      granted: provider ? host.isGranted(provider, 'gridRelay.switch') : false,
      /** The station this relay feeds, by saved-device id. Null until paired. */
      stationDeviceId: paired,
      stationPresent: paired ? connections.get(paired) !== null : false,
      state: await gateway.state(),
    });
  });

  /**
   * Records which station this relay actually feeds.
   *
   * A stored id rather than a rule evaluated at switch time, because "the only
   * station" silently stops being true the day a second one is added — and the
   * thing it decides is whether cutting mains gets verified against the right
   * machine.
   */
  grid.post('/station', async (c) => {
    const { deviceId } = await body(c, z.object({ deviceId: z.string().min(1).nullable() }));

    if (deviceId === null) {
      pairStation(null);
      auditDevice(c, 'relay.unpaired', '', 'The grid relay is no longer paired with a station');
      return c.json({ stationDeviceId: null });
    }

    const record = catalog.get(savedDeviceId(deviceId));
    if (!record) throw new HTTPException(404, { message: 'No such device' });
    if (record.type !== 'power-station') throw new HTTPException(400, { message: 'A relay is paired with a power station' });

    pairStation(record.id);
    auditDevice(c, 'relay.paired', record.id, `The grid relay now feeds "${record.name}"`);
    return c.json({ stationDeviceId: record.id });
  });

  grid.post('/relay', async (c) => {
    const { on, reason, confirmation } = await body(
      c,
      z.object({
        on: z.boolean(),
        reason: z.string().min(1).max(200).default('Requested from the app'),
        confirmation: z.string().max(64).optional(),
      })
    );
    const result = await gateway.execute({ desired: on, reason, actor: 'user', by: actorOf(c), confirmation });
    return c.json(result, result.outcome === 'refused' ? 409 : 200);
  });

  return grid;
}
