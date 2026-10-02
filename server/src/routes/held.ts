import { Hono } from 'hono';
import { z } from 'zod';

import { nodeId, RESOURCE_KINDS, savedDeviceId, type AuditSubject, type DeviceDescription, type DeviceInfo, type ResourceKind, type Value } from '@kraftverk/device-sdk';

import { body, homeFor, type AppDeps } from './shared.ts';

/**
 * What an app sends for a connection it holds (docs/DATA-MODEL.md §4), over
 * HTTP: checked, and handed to the home (`KraftverkApi.held`), which keeps
 * the device's history, its store and its timeline. Each call names the
 * app, which must be the signed-in account's, and the connection, which must
 * be one that app holds.
 */

const reading = z
  .object({
    key: z.string().min(1).max(64),
    value: z.union([z.number(), z.boolean(), z.string().max(200), z.null()]),
    at: z.string().min(1).max(40),
  })
  .strict();

export function heldRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  /** Readings the app took: live ones become the device's state, queued ones go straight into history. */
  api.post('/devices/:id/readings', async (c) => {
    const input = await body(
      c,
      z
        .object({
          nodeId: z.string().min(1).max(40),
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
    const upload = {
      ...input,
      // Its shape the home checks: a description must hold, as a type's own must.
      description: input.description as unknown as DeviceDescription | undefined,
      info: input.info as unknown as DeviceInfo | undefined,
      events: input.events?.map((event) => ({ ...event, data: event.data as Record<string, Value> | null })),
    };
    return c.json(await homeFor(deps, c).held.readings(savedDeviceId(c.req.param('id')), upload));
  });

  /** The device's own store, which a session keeps between runs. The app keeps a copy for when it is offline. */
  api.get('/devices/:id/store', async (c) => c.json({ values: await homeFor(deps, c).held.store(savedDeviceId(c.req.param('id'))) }));

  api.put('/devices/:id/store/:key', async (c) => {
    const input = await body(c, z.object({ nodeId: z.string().min(1).max(40), connectionId: z.string().min(1).max(40), value: z.unknown() }).strict());
    await homeFor(deps, c).held.keep(savedDeviceId(c.req.param('id')), c.req.param('key'), input);
    return c.json({ ok: true });
  });

  /** The audit entries an app's gateway and session wrote while it held a connection — queued while offline, sent when it can. */
  api.post('/nodes/:id/audit', async (c) => {
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
    return c.json(await homeFor(deps, c).held.audit(nodeId(c.req.param('id')), entries.map((entry) => entry as typeof entry & AuditSubject)));
  });

  return api;
}
