import { Hono } from 'hono';
import { z } from 'zod';

import { savedDeviceId } from '@kraftverk/device-sdk';
import { PICTURE_REF } from '@kraftverk/hub';

import { body, homeFor, type AppDeps } from './shared.ts';

/*
  The devices you own, whatever they are, over HTTP: what each route takes,
  checked, handed to the home (`KraftverkApi`, `hub.as(caller)`), and its
  answer. What each does is the hub's. A command or a setting the gateway
  refuses is an answer, not an error: its verdict, with 409.
*/

const VALUE = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const SPAN = {
  hours: z.coerce.number().min(0.5).max(24 * 730).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};
const LIMIT = z.coerce.number().int().min(1).max(500).default(100);

export function deviceRoutes(deps: AppDeps): Hono {
  const api = new Hono();
  /** The device a route names: Hono has decoded it already, and decoding again turned an id with a % into a 500. */
  const id = (raw: string | undefined) => savedDeviceId(raw ?? '');

  api.get('/device-types', async (c) => c.json(await homeFor(deps, c).deviceTypes()));

  api.get('/devices', async (c) => c.json({ devices: await homeFor(deps, c).devices.list() }));

  /** Removed devices, kept with their history: to bring back by adding again, or to delete. */
  api.get('/devices/removed', async (c) => c.json({ devices: await homeFor(deps, c).devices.removed() }));

  api.get('/devices/:id', async (c) => c.json(await homeFor(deps, c).devices.get(id(c.req.param('id')))));

  api.patch('/devices/:id', async (c) => {
    const changes = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), key: z.string().trim().min(1).max(63).optional() }).strict());
    return c.json(await homeFor(deps, c).devices.update(id(c.req.param('id')), changes));
  });

  api.delete('/devices/:id', async (c) => {
    await homeFor(deps, c).devices.remove(id(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/devices/:id/delete-history', async (c) => {
    const { name } = await body(c, z.object({ name: z.string().max(60) }).strict());
    return c.json({ ok: true, ...(await homeFor(deps, c).devices.deleteHistory(id(c.req.param('id')), name)) });
  });

  api.put('/devices/:id/picture', async (c) => {
    const { picture } = await body(c, z.object({ picture: z.string().regex(PICTURE_REF, 'type:0, type:1… (or, one day, own:<id>)') }).strict());
    return c.json(await homeFor(deps, c).devices.setPicture(id(c.req.param('id')), picture as `type:${number}`));
  });

  api.patch('/devices/:id/attributes', async (c) => {
    const input = await body(c, z.object({ patch: z.record(z.string().max(64), VALUE), confirmation: z.string().max(64).optional() }).strict());
    const result = await homeFor(deps, c).devices.write(id(c.req.param('id')), input);
    return c.json(result, result.outcome === 'verified' || result.outcome === 'unverified' ? 200 : 409);
  });

  api.get('/problems', async (c) => c.json({ problems: await homeFor(deps, c).problems(LIMIT.parse(c.req.query('limit') ?? 100)) }));

  api.get('/devices/:id/events', async (c) => c.json({ events: await homeFor(deps, c).devices.events(id(c.req.param('id')), LIMIT.parse(c.req.query('limit') ?? 100)) }));

  api.get('/devices/:id/history', async (c) => {
    const query = z
      .object({ key: z.string().min(1).max(64), points: z.coerce.number().int().min(20).max(1000).default(240), ...SPAN })
      .strict()
      .parse(c.req.query());
    return c.json(await homeFor(deps, c).devices.history(id(c.req.param('id')), query));
  });

  api.get('/devices/:id/changes', async (c) => {
    const query = z
      .object({ key: z.string().min(1).max(64).optional(), ...SPAN })
      .strict()
      .parse(c.req.query());
    return c.json(await homeFor(deps, c).devices.changes(id(c.req.param('id')), query));
  });

  api.post('/devices/:id/parts/:part/commands/:capability/:command', async (c) => {
    const input = await body(c, z.object({ args: z.record(z.string().max(64), VALUE), confirmation: z.string().max(64).optional(), reason: z.string().min(1).max(200).optional() }).strict());
    const result = await homeFor(deps, c).devices.command(id(c.req.param('id')), c.req.param('part'), c.req.param('capability'), c.req.param('command'), input);
    return c.json(result, result.outcome === 'refused' ? 409 : 200);
  });

  /** A query a part's capability declares — a forecast's hours — answered in the type it declares. */
  api.post('/devices/:id/parts/:part/queries/:capability/:query', async (c) => {
    const { args } = await body(c, z.object({ args: z.record(z.string().max(64), VALUE).default({}) }).strict());
    const answer: unknown = await homeFor(deps, c).devices.query(id(c.req.param('id')), c.req.param('part'), c.req.param('capability'), c.req.param('query'), args);
    return c.json(answer);
  });

  /** A tool that only reads is a GET, its input in the query; one that writes is a POST. */
  api.get('/devices/:id/tools/:name', async (c) => c.json(await homeFor(deps, c).devices.tool(id(c.req.param('id')), c.req.param('name'), { input: c.req.query(), reading: true })));

  api.post('/devices/:id/tools/:name', async (c) => {
    const request = await body(c, z.object({ input: z.record(z.string().max(64), VALUE).optional(), confirmation: z.string().max(64).optional() }).strict());
    return c.json(await homeFor(deps, c).devices.tool(id(c.req.param('id')), c.req.param('name'), request));
  });

  return api;
}
