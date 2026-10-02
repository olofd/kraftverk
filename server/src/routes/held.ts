import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { RESOURCE_KINDS, validateDescription, type AuditSubject, type DeviceDescription, type DeviceInfo, type ResourceKind } from '@kraftverk/device-sdk';

import { actorOf } from '../auth/routes.ts';
import { deviceStore, audit } from '../platform/database.ts';
import { loggedAttributes, recordChanges } from '../history/changes.ts';
import { keptAttributes } from '../history/sampler.ts';
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
    value: z.union([z.number(), z.boolean(), z.string().max(200), z.null()]),
    at: z.string().min(1).max(40),
  })
  .strict();

export function heldRoutes({ catalog, connections, clients, remote, sessions, events, bus }: AppDeps): Hono {
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
      z
        .object({
          clientId: z.string().min(1).max(40),
          connectionId: z.string().min(1).max(40),
          // Who the device said it is, read by the app's session.
          identity: z.string().min(1).max(120).nullable().optional(),
          readings: z.array(reading).max(2000),
          // What the device is and says about itself, by the app's session: a pack plugged in.
          description: z.record(z.string(), z.unknown()).optional(),
          info: z.record(z.string(), z.unknown()).optional(),
          // What the device said happened, as the app's holder heard it.
          events: z
            .array(
              z
                .object({
                  id: z.string().min(1).max(80),
                  part: z.string().min(1).max(80).nullable(),
                  data: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).nullable(),
                  at: z.string().max(40),
                })
                .strict()
            )
            .max(500)
            .optional(),
        })
        .strict()
    );
    const { record, client, connection } = heldBy(c, input);

    /*
      The same rule as a connection the server holds (sessions.ts, check): a
      device saved before it ever answered learns who it is the first time it
      does, and a connection that now reaches a different device adds nothing
      to this one's history.
    */
    const said = input.identity ?? null;
    if (said && record.identity && said.toLowerCase() !== record.identity.toLowerCase()) {
      audit({ at: new Date().toISOString(), kind: 'device.mismatch', actor: actorOf(c), resourceKind: 'device', resource: record.id, summary: `${record.name}'s connection from ${client.name} reaches ${said} instead`, detail: { expected: record.identity } });
      throw new HTTPException(409, { message: 'That connection reaches a different device, not the one you added' });
    }
    // What every open app's list shows changes only when the device does, or comes back: then it reads the list again.
    let listChanged = remote.latest(record.id) === null;
    if (said && !record.identity && !catalog.byIdentity(said).active) {
      catalog.update(record.id, { identity: said });
      audit({ at: new Date().toISOString(), kind: 'device.identified', actor: actorOf(c), resourceKind: 'device', resource: record.id, summary: `${record.name} answered for the first time, as ${said}` });
      listChanged = true;
    }

    if (input.description) {
      const description = input.description as unknown as DeviceDescription;
      const problems = validateDescription(description, record.typeId);
      if (problems.length) throw new HTTPException(400, { message: `That description does not hold: ${problems.join('; ')}` });
      // Sent only when the device describes itself: the type's own the server has already.
      if (catalog.describe(record.id, description, (input.info as DeviceInfo | undefined) ?? null, 'device')) listChanged = true;
    }
    const description = sessions.description(catalog.get(record.id)!);
    const counts = remote.accept(record.id, { clientId: client.id, connectionId: connection.id }, input.readings, keptAttributes(description));
    // What it reads now, said on the live stream as a device the server holds says it; the rest went to history.
    const latest = remote.latest(record.id);
    if (counts.live && latest) bus.publish({ kind: 'readings', deviceId: record.id, readings: latest.readings });
    if (listChanged && latest) bus.publish({ kind: 'changed', deviceId: record.id });
    // Its on/offs and modes, when each changed: queued ones land in their place in time.
    recordChanges(record.id, loggedAttributes(description), input.readings);
    // Its events, kept as the server's own are: only what its description declares, at the level it declares.
    for (const event of input.events ?? []) {
      const declared = (description.events ?? []).find((spec) => spec.id === event.id);
      const at = Date.parse(event.at);
      if (!declared || !Number.isFinite(at) || at > Date.now() + 60_000) continue;
      const kept = { id: event.id, level: declared.level, part: event.part ?? declared.part ?? null, data: event.data, at: new Date(at).toISOString() };
      events.record(record.id, kept);
      bus.publish({ kind: 'event', deviceId: record.id, event: kept });
    }
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
                  resourceKind: z.enum(RESOURCE_KINDS as [ResourceKind, ...ResourceKind[]]).optional(),
                  resource: z.string().min(1).max(80).optional(),
                  summary: z.string().min(1).max(500),
                  detail: z.unknown().optional(),
                })
                .strict()
                .refine((entry) => (entry.resource === undefined) === (entry.resourceKind === undefined), 'What an entry is about is a kind and an id together, or nothing')
            )
            .max(500),
        })
        .strict()
    );
    const actor = actorOf(c);
    for (const entry of entries) {
      const at = Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString() : new Date().toISOString();
      const about = (entry.resource === undefined ? {} : { resourceKind: entry.resourceKind, resource: entry.resource }) as AuditSubject;
      audit({ at, kind: entry.kind, summary: entry.summary, ...about, actor, detail: { from: { client: client.id, name: client.name }, ...(entry.detail === undefined ? {} : { detail: entry.detail }) } });
    }
    return c.json({ recorded: entries.length });
  });

  return api;
}
