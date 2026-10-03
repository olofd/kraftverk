import { Hono } from 'hono';
import { z } from 'zod';

import { HELD_LIMITS } from '@kraftverk/api-contract';
import { nodeId, savedDeviceId, type AuditSubject, type DeviceDescription, type DeviceInfo, type Value } from '@kraftverk/device-sdk';

import { HELD_BY, homeFor, RESOURCE_KIND, type AppDeps } from './context.ts';
import { body } from './parse.ts';

/**
 * What a follower sends the master for a connection it holds
 * (docs/DATA-MODEL.md §4), over HTTP: a way it set up itself, what its
 * session read, what it kept and what its gateway did — checked, and handed
 * to the home (`KraftverkApi.setup.startHeld`, `KraftverkApi.held`), which
 * keeps the device's history, its store and its timeline. Each call names the
 * node, which must be the signed-in account's, and the connection, which must
 * be one that node holds.
 */

const reading = z
  .object({
    key: z.string().min(1).max(64),
    value: z.union([z.number(), z.boolean(), z.string().max(200), z.null()]),
    at: z.string().min(1).max(40),
  })
  .strict();

const values = z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()]));

export function followerRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  /**
   * A way the follower will hold. It ran the steps itself and read the
   * device with its own radio; this is what it learnt, never a secret. It
   * speaks for itself only: the home checks the node is this account's.
   */
  api.post('/setup/held', async (c) => {
    const input = await body(
      c,
      z
        .object({
          nodeId: HELD_BY.nodeId,
          typeId: z.string().min(1).max(80),
          methodId: z.string().min(1).max(40),
          address: z.string().min(1).max(200),
          identified: z
            .object({
              identity: z.string().min(1).max(120).nullable(),
              model: z.string().max(80).nullable(),
              name: z.string().max(80).optional(),
              summary: z.string().max(300),
              config: values.optional(),
            })
            .strict()
            .nullable(),
          failure: z.string().max(300).optional(),
          device: values.optional(),
          connection: values.optional(),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).setup.startHeld(input));
  });

  /** Readings the follower took: live ones become the device's state, queued ones go straight into history. */
  api.post('/devices/:id/readings', async (c) => {
    const input = await body(
      c,
      z
        .object({
          ...HELD_BY,
          // Who the device said it is, read by the follower's session.
          identity: z.string().min(1).max(120).nullable().optional(),
          readings: z.array(reading).max(HELD_LIMITS.readings),
          // What the device is and says about itself, by the follower's session: a pack plugged in.
          description: z.record(z.string(), z.unknown()).optional(),
          info: z.record(z.string(), z.unknown()).optional(),
          // What the device said happened, as the follower's holder heard it.
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
            .max(HELD_LIMITS.events)
            .optional(),
          sentAt: z.iso.datetime({ offset: true }).optional(),
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

  /** The device's own store, which a session keeps between runs. The follower keeps a copy for when it is offline. */
  api.get('/devices/:id/store', async (c) => c.json({ values: await homeFor(deps, c).held.store(savedDeviceId(c.req.param('id'))) }));

  api.put('/devices/:id/store/:key', async (c) => {
    const input = await body(c, z.object({ ...HELD_BY, value: z.unknown() }).strict());
    await homeFor(deps, c).held.keep(savedDeviceId(c.req.param('id')), c.req.param('key'), input);
    return c.json({ ok: true });
  });

  /** The audit entries a node's gateway and session wrote while it held a connection — queued while offline, sent when it can. */
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
                  resourceKind: RESOURCE_KIND.optional(),
                  resource: z.string().min(1).max(80).optional(),
                  summary: z.string().min(1).max(500),
                  detail: z.unknown().optional(),
                })
                .strict()
                .refine((entry) => (entry.resource === undefined) === (entry.resourceKind === undefined), 'What an entry is about is a kind and an id together, or nothing')
            )
            .max(HELD_LIMITS.audit),
        })
        .strict()
    );
    return c.json(await homeFor(deps, c).held.audit(nodeId(c.req.param('id')), entries.map((entry) => entry as typeof entry & AuditSubject)));
  });

  return api;
}
