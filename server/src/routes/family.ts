import { Hono } from 'hono';
import { z } from 'zod';

import type { KraftverkApi } from '@kraftverk/api-contract';
import { acceptInvitation } from '@kraftverk/hub';
import { KEY, NODE_ID, nodeId, type PolicyValueName } from '@kraftverk/device-sdk';

import { familyFor, RESOURCE_KIND, type AppDeps } from './context.ts';
import { body, query } from './parse.ts';

/**
 * The family over HTTP (docs/PLAN-WORLD-MODEL.md): what its people call it
 * and which node is its master, its homes, the kraftverk nodes that are part
 * of it, the values it decides, and its timeline. What each does is the
 * family's (`KraftverkApi`).
 */
export function familyRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/family', async (c) => c.json(await familyFor(deps, c).family()));

  /** Its homes: each a place, with its own clock — the family checks what each says. */
  const HOME = z
    .object({
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(60),
      type: z.enum(['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other']),
      timeZone: z.string().min(1).max(64),
      icon: z.string().max(40).nullable(),
      location: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), radius: z.number().finite().positive().max(50_000) }).strict().nullable(),
      address: z.object({ street: z.string().max(120).nullable(), postalCode: z.string().max(20).nullable(), locality: z.string().max(80).nullable(), region: z.string().max(80).nullable() }).strict(),
      country: z.string().regex(/^[A-Z]{2}$/).nullable(),
      bearing: z.number().finite().min(0).lt(360),
    })
    .strict();
  api.get('/homes', async (c) => c.json({ homes: await familyFor(deps, c).homes.list({ removed: c.req.query('removed') === 'true' }) }));
  api.post('/homes', async (c) => c.json(await familyFor(deps, c).homes.add(await body(c, HOME.partial({ key: true, icon: true, location: true, address: true, country: true, bearing: true })))));
  api.patch('/homes/:id', async (c) => c.json(await familyFor(deps, c).homes.update(c.req.param('id'), await body(c, HOME.partial()))));
  api.delete('/homes/:id', async (c) => c.json(await familyFor(deps, c).homes.remove(c.req.param('id'))));

  const SHARING = z.enum(['precise', 'places', 'home-away', 'off']);
  // Its zones: places it knows that are no home, each a circle on the map.
  const ZONE = z
    .object({
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(60),
      icon: z.string().max(40).nullable(),
      location: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), radius: z.number().finite().min(10).max(50_000) }).strict(),
    })
    .strict();
  // A person's own notifications: their inbox, where their apps are woken, and a test.
  api.get('/notifications', async (c) => c.json({ notifications: await familyFor(deps, c).notifications.list() }));
  api.post('/notifications/read', async (c) => {
    const { id } = await body(c, z.object({ id: z.string().max(60).nullable() }).strict());
    await familyFor(deps, c).notifications.read(id);
    return c.json({ ok: true });
  });
  api.get('/notifications/push-key', async (c) => c.json({ key: await familyFor(deps, c).notifications.pushKey() }));
  api.put('/notifications/endpoints/:node', async (c) => {
    const subscription = await body(c, z.object({ endpoint: z.string().url().max(1000), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict() }).strict());
    await familyFor(deps, c).notifications.keepPushEndpoint(c.req.param('node'), { endpoint: subscription.endpoint, keys: subscription.keys });
    return c.json({ ok: true });
  });
  api.delete('/notifications/endpoints/:node', async (c) => {
    await familyFor(deps, c).notifications.forgetPushEndpoint(c.req.param('node'));
    return c.json({ ok: true });
  });
  api.post('/notifications/test', async (c) => c.json(await familyFor(deps, c).notifications.test()));
  // Where each member is, as far as each shares: never more.
  api.get('/presence', async (c) => c.json({ presence: await familyFor(deps, c).presence.list() }));
  // A home's modes: the family's own, and which each home is in.
  const MODE = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/), axis: z.enum(['presence', 'day']), name: z.string().trim().min(1).max(30), icon: z.string().max(40).nullable() }).strict();
  api.get('/modes', async (c) => c.json({ modes: await familyFor(deps, c).modes.list({ removed: c.req.query('removed') === 'true' }) }));
  api.post('/modes', async (c) => c.json(await familyFor(deps, c).modes.add(await body(c, MODE.partial({ key: true, icon: true })))));
  api.patch('/modes/:id', async (c) => c.json(await familyFor(deps, c).modes.update(c.req.param('id'), await body(c, MODE.omit({ axis: true }).partial()))));
  api.delete('/modes/:id', async (c) => c.json(await familyFor(deps, c).modes.remove(c.req.param('id'))));
  api.get('/homes/:id/modes', async (c) => c.json({ modes: await familyFor(deps, c).modes.of(c.req.param('id')) }));
  api.put('/homes/:id/modes', async (c) =>
    c.json({ modes: await familyFor(deps, c).modes.set(c.req.param('id'), await body(c, z.object({ mode: z.string().min(1).max(40), from: z.iso.datetime({ offset: true }).optional(), until: z.iso.datetime({ offset: true }).nullable().optional() }).strict())) })
  );
  // Which spaces have someone in them: whoever they are.
  api.get('/homes/:id/occupancy', async (c) => c.json({ occupancy: await familyFor(deps, c).occupancy.now(c.req.param('id')) }));
  api.get('/spaces/:id/occupancy', async (c) => {
    const asked = query(c, z.object({ hours: z.coerce.number().min(0.25).max(24 * 30).optional() }).strict());
    return c.json({ occupancy: await familyFor(deps, c).occupancy.history(c.req.param('id'), asked) });
  });
  api.get('/zones', async (c) => c.json({ zones: await familyFor(deps, c).zones.list({ removed: c.req.query('removed') === 'true' }) }));
  api.post('/zones', async (c) => c.json(await familyFor(deps, c).zones.add(await body(c, ZONE.partial({ key: true, icon: true })))));
  api.patch('/zones/:id', async (c) => c.json(await familyFor(deps, c).zones.update(c.req.param('id'), await body(c, ZONE.partial()))));
  api.delete('/zones/:id', async (c) => c.json(await familyFor(deps, c).zones.remove(c.req.param('id'))));

  /** A point in a frame: metres east and north of its origin, as the frame is turned. */
  const POINT = z.tuple([z.number().finite(), z.number().finite()]);
  /** A home's spaces: a tree from its site — the family checks what each says. */
  const SPACE = z
    .object({
      parentId: z.string().min(1).max(40),
      key: z.string().regex(KEY),
      kind: z.enum(['building', 'floor', 'room', 'area', 'stairs', 'outdoor']),
      purpose: z.enum(['kitchen', 'living', 'dining', 'bedroom', 'children', 'guest', 'bathroom', 'toilet', 'hallway', 'office', 'laundry', 'storage', 'utility', 'garage', 'gym', 'sauna', 'other']).nullable(),
      name: z.string().trim().min(1).max(60),
      icon: z.string().max(40).nullable(),
      pictureId: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      position: z.number().int().min(0).max(10_000),
      level: z.number().int().min(-200).max(200).nullable(),
      elevation: z.number().finite().min(-1000).max(1000).nullable(),
      height: z.number().finite().positive().max(100).nullable(),
      frame: z.object({ x: z.number().finite(), y: z.number().finite(), turn: z.number().finite() }).strict().nullable(),
      outline: z.array(POINT).min(3).max(200).nullable(),
      plan: z.object({ pictureId: z.string().regex(/^[0-9a-f]{64}$/), scale: z.number().finite().positive(), x: z.number().finite(), y: z.number().finite(), turn: z.number().finite() }).strict().nullable(),
    })
    .strict();
  api.get('/homes/:id/spaces', async (c) => c.json({ spaces: await familyFor(deps, c).spaces.list(c.req.param('id'), { removed: c.req.query('removed') === 'true' }) }));
  api.post('/spaces', async (c) => c.json(await familyFor(deps, c).spaces.add(await body(c, SPACE.partial({ key: true, purpose: true, icon: true, pictureId: true, position: true, level: true, elevation: true, height: true, frame: true, outline: true, plan: true })))));
  api.patch('/spaces/:id', async (c) => c.json(await familyFor(deps, c).spaces.update(c.req.param('id'), await body(c, SPACE.partial()))));
  api.delete('/spaces/:id', async (c) => c.json(await familyFor(deps, c).spaces.remove(c.req.param('id'))));
  api.get('/spaces/:id/history', async (c) => {
    const asked = query(c, z.object({ means: z.string().min(1).max(64), points: z.coerce.number().int().min(20).max(1000).default(240), hours: z.coerce.number().min(0.5).max(24 * 730).optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).strict());
    return c.json(await familyFor(deps, c).spaces.history(c.req.param('id'), asked));
  });

  /** Where its spaces meet, or meet the outside. */
  const OPENING = z
    .object({
      key: z.string().regex(KEY),
      fromId: z.string().min(1).max(40),
      toId: z.string().min(1).max(40).nullable(),
      kind: z.enum(['door', 'opening', 'stairs', 'window', 'gate', 'garage-door', 'elevator']),
      name: z.string().trim().max(60).nullable(),
      shape: z.array(POINT).min(2).max(200).nullable(),
    })
    .strict();
  api.get('/homes/:id/openings', async (c) => c.json({ openings: await familyFor(deps, c).openings.list(c.req.param('id')) }));
  api.post('/openings', async (c) => c.json(await familyFor(deps, c).openings.add(await body(c, OPENING.partial({ key: true, name: true, shape: true })))));
  api.patch('/openings/:id', async (c) => c.json(await familyFor(deps, c).openings.update(c.req.param('id'), await body(c, OPENING.partial()))));
  api.delete('/openings/:id', async (c) => c.json(await familyFor(deps, c).openings.remove(c.req.param('id'))));

  /** Its labels, and what each is on. */
  const LABEL = z
    .object({
      key: z.string().regex(KEY),
      name: z.string().trim().min(1).max(30),
      color: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
      icon: z.string().max(40).nullable(),
    })
    .strict();
  const TARGET = z.union([z.object({ device: z.string().min(1).max(40) }).strict(), z.object({ space: z.string().min(1).max(40) }).strict(), z.object({ automation: z.string().min(1).max(40) }).strict()]);
  /** Its people: each as their own chain says — the hub checks every statement — and what the family calls them. */
  const CHAIN = z.array(z.record(z.string(), z.unknown())).min(1).max(1000);
  api.get('/people', async (c) => c.json({ people: await familyFor(deps, c).people.list() }));
  api.get('/people/me', async (c) => c.json({ person: await familyFor(deps, c).people.me() }));
  api.get('/people/me/chain', async (c) => c.json({ chain: await familyFor(deps, c).people.myChain() }));
  api.post('/people/found', async (c) => {
    const input = await body(
      c,
      z
        .object({
          chain: CHAIN,
          name: z.string().max(60),
          kind: z.enum(['family', 'household', 'friends', 'other']),
          home: z.object({ name: z.string().max(60), type: z.enum(['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other']), timeZone: z.string().max(60) }).strict(),
          sharing: SHARING.optional(),
        })
        .strict()
    );
    return c.json(await familyFor(deps, c).people.found(input as unknown as Parameters<KraftverkApi['people']['found']>[0]));
  });
  api.post('/people/present', async (c) => {
    const { chain } = await body(c, z.object({ chain: CHAIN }).strict());
    return c.json(await familyFor(deps, c).people.present(chain as unknown as Parameters<KraftverkApi['people']['present']>[0]));
  });
  api.get('/people/invitations', async (c) => c.json({ invitations: await familyFor(deps, c).people.invitations() }));
  api.post('/people/invitations', async (c) => {
    const input = await body(c, z.object({ role: z.enum(['admin', 'member', 'child']), forName: z.string().max(60).nullable().optional(), needsApproval: z.boolean(), days: z.number().int().min(1).max(30).optional() }).strict());
    return c.json(await familyFor(deps, c).people.invite(input));
  });
  api.post('/people/invitations/:id/approve', async (c) => c.json(await familyFor(deps, c).people.approve(c.req.param('id'))));
  api.delete('/people/invitations/:id', async (c) => c.json(await familyFor(deps, c).people.revokeInvitation(c.req.param('id'))));
  /** An invitation taken: open — the secret is what lets someone with no session here ask — and taken once. */
  api.post('/join', async (c) => {
    const input = await body(c, z.object({ invitation: z.string().max(40), secret: z.string().min(20).max(100), chain: CHAIN, sharing: SHARING.optional() }).strict());
    return c.json(acceptInvitation(deps.hub, input as unknown as Parameters<typeof acceptInvitation>[1]));
  });
  // What a person shares of where they are: their own, an admin's for a child.
  api.put('/people/:id/sharing', async (c) => {
    const changes = await body(c, z.object({ level: SHARING, keepDays: z.number().int().min(1).max(366), pausedUntil: z.string().datetime().nullable() }).partial().strict());
    return c.json(await familyFor(deps, c).people.setSharing(c.req.param('id'), changes));
  });
  // A person forgotten: in the family, and every login here that was theirs, with its sessions.
  api.delete('/people/:id', async (c) => {
    const personId = c.req.param('id');
    await familyFor(deps, c).people.erase(personId);
    for (const user of deps.accounts.listUsers().filter((each) => each.personId === personId)) deps.accounts.forgetUser(user.id);
    deps.accounts.endPersonSessions(personId);
    return c.json({ ok: true });
  });
  api.patch('/people/:id', async (c) => {
    const changes = await body(c, z.object({ role: z.enum(['admin', 'member', 'child']), nickname: z.string().max(30).nullable(), color: z.string().regex(/^#[0-9a-f]{6}$/) }).partial().strict());
    return c.json(await familyFor(deps, c).people.update(c.req.param('id'), changes));
  });

  api.get('/labels', async (c) => c.json({ labels: await familyFor(deps, c).labels.list() }));
  api.get('/labels/labelled', async (c) => c.json(await familyFor(deps, c).labels.labelled()));
  api.post('/labels', async (c) => c.json(await familyFor(deps, c).labels.add(await body(c, LABEL.partial({ key: true, color: true, icon: true })))));
  api.put('/labels/on', async (c) => {
    const { target, labelIds } = await body(c, z.object({ target: TARGET, labelIds: z.array(z.string().min(1).max(40)).max(50) }).strict());
    return c.json({ labels: await familyFor(deps, c).labels.set(target, labelIds) });
  });
  api.patch('/labels/:id', async (c) => c.json(await familyFor(deps, c).labels.update(c.req.param('id'), await body(c, LABEL.partial()))));
  api.delete('/labels/:id', async (c) => {
    await familyFor(deps, c).labels.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  /**
   * A node joins the home, saying who it is — by its own id — and what it can
   * reach devices over. It does so at every start, so "held by Olof's iPhone"
   * has something to name and the add flow knows what that node can hold.
   */
  api.post('/nodes', async (c) => {
    const input = await body(
      c,
      z
        .object({
          id: z.string().regex(NODE_ID),
          name: z.string().trim().min(1).max(60),
          platform: z.enum(['system', 'web', 'native']),
          transports: z.array(z.string().min(1).max(20)).max(10),
          alwaysOn: z.boolean(),
          reachable: z.boolean(),
          trusted: z.boolean(),
        })
        .strict()
    );
    return c.json(await familyFor(deps, c).nodes.join({ ...input, id: nodeId(input.id) }));
  });

  api.get('/nodes', async (c) => c.json({ nodes: await familyFor(deps, c).nodes.list() }));

  /** Forgets a node, and every connection it held. */
  api.delete('/nodes/:id', async (c) => {
    await familyFor(deps, c).nodes.forget(nodeId(c.req.param('id')));
    return c.json({ ok: true });
  });

  /** What this home decides that declarations name: how much is a load worth confirming. */
  api.get('/policy', async (c) => c.json(await familyFor(deps, c).policy.list()));

  api.put('/policy/:name', async (c) => {
    const { value } = await body(c, z.object({ value: z.number().finite().nullable() }).strict());
    return c.json(await familyFor(deps, c).policy.set(c.req.param('name') as PolicyValueName, value));
  });

  /** The timeline, newest first: all of it, one kind of thing's, or one thing's; `before` pages back. */
  api.get('/audit', async (c) => {
    const asked = query(
      c,
      z
        .object({
          limit: z.coerce.number().int().min(1).max(1000).default(100),
          resourceKind: RESOURCE_KIND.optional(),
          resource: z.string().min(1).max(120).optional(),
          before: z.coerce.number().int().min(1).optional(),
        })
        .strict()
    );
    return c.json(await familyFor(deps, c).timeline(asked));
  });

  return api;
}
