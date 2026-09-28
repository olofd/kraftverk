import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { actorOf } from '../auth/routes.ts';
import { deviceStore } from '../devices/store.ts';
import { audit } from '../history/db.ts';
import { body, deviceOr404, ownClient, type AppDeps } from './shared.ts';

/**
 * What an app sends for a connection it holds (docs/DATA-MODEL.md §4).
 *
 * The app runs the device's session; the server still keeps the device's
 * history, its store and its audit timeline. Each call names the app, which
 * must be the signed-in account's, and the connection, which must be one that
 * app holds: an app speaks for its own connections and nobody else's.
 */

const reading = z
  .object({
    key: z.string().min(1).max(64),
    value: z.union([z.number(), z.boolean(), z.null()]),
    at: z.string().min(1).max(40),
  })
  .strict();

export function heldRoutes({ catalog, connections, clients, remote }: AppDeps): Hono {
  const api = new Hono();

  /** The device, the app and the connection a call is about — all three checked. */
  const heldBy = (c: Context, input: { clientId: string; connectionId: string }) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    const client = ownClient(clients, c, input.clientId);
    const connection = connections.get(input.connectionId);
    if (!connection || connection.deviceId !== record.id || connection.heldBy !== client.id) {
      throw new HTTPException(403, { message: 'That app does not hold a connection to this device' });
    }
    return { record, client, connection };
  };

  /** Readings the app took: live ones become the device's state, queued ones go straight into history. */
  api.post('/devices/:id/readings', async (c) => {
    const input = await body(
      c,
      z.object({ clientId: z.string().min(1).max(40), connectionId: z.string().min(1).max(40), readings: z.array(reading).max(2000) }).strict()
    );
    const { record, client, connection } = heldBy(c, input);
    const counts = remote.accept(record.id, { clientId: client.id, connectionId: connection.id }, input.readings);
    connections.touch(connection.id);
    return c.json(counts);
  });

  /**
   * The device's own store, which a session keeps between runs: a baseline, a
   * detected protocol version. The app keeps a copy for when it is offline.
   */
  api.get('/devices/:id/store', (c) => {
    const record = deviceOr404(catalog, c.req.param('id'));
    const rows = catalog.storeOf(record.id);
    return c.json({ values: rows });
  });

  api.put('/devices/:id/store/:key', async (c) => {
    const key = c.req.param('key');
    if (!/^[\w.:-]{1,80}$/.test(key)) throw new HTTPException(400, { message: 'That is not a store key' });
    const input = await body(c, z.object({ clientId: z.string().min(1).max(40), connectionId: z.string().min(1).max(40), value: z.unknown() }).strict());
    const { record } = heldBy(c, input);
    if (JSON.stringify(input.value ?? null).length > 256 * 1024) throw new HTTPException(413, { message: 'That value is too large to keep' });
    if (input.value === null || input.value === undefined) deviceStore(record.id).delete(key);
    else deviceStore(record.id).set(key, input.value);
    return c.json({ ok: true });
  });

  /**
   * The audit entries an app's gateway and session wrote while it held a
   * connection — queued while offline, sent when it can. The actor is always
   * the signed-in account, whatever the entry says, and the app is recorded.
   */
  api.post('/clients/:id/audit', async (c) => {
    const client = ownClient(clients, c, c.req.param('id'));
    const { entries } = await body(
      c,
      z
        .object({
          entries: z
            .array(
              z
                .object({
                  at: z.string().max(40),
                  kind: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
                  resource: z.string().max(80).optional(),
                  summary: z.string().min(1).max(500),
                  detail: z.unknown().optional(),
                })
                .strict()
            )
            .max(500),
        })
        .strict()
    );
    const actor = actorOf(c);
    for (const entry of entries) {
      const at = Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString() : new Date().toISOString();
      audit({ ...entry, at, actor, detail: { from: { client: client.id, name: client.name }, ...(entry.detail === undefined ? {} : { detail: entry.detail }) } });
    }
    return c.json({ recorded: entries.length });
  });

  return api;
}
