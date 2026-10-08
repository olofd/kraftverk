import { Hono } from 'hono';
import { z } from 'zod';

import { connectionId, savedDeviceId } from '@kraftverk/device-sdk';

import { familyFor, type AppDeps, type ConfirmPassword } from './context.ts';
import { body, query } from './parse.ts';

/*
  The devices you own, whatever they are, and how each is reached, over
  HTTP: what each route takes, checked, handed to the home (`KraftverkApi`,
  `hub.as(caller)`), and its answer. What each does is the hub's. A command
  or a setting the gateway refuses is an answer, not an error: its verdict,
  with 409. A connection is added by the setup flow, never here: adding one
  has to find the device, and that is what setup is.
*/

const VALUE = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const SPAN = {
  hours: z.coerce.number().min(0.5).max(24 * 730).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};
const LIMITED = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();

export function deviceRoutes(deps: AppDeps, confirm: ConfirmPassword): Hono {
  const api = new Hono();
  /** The device a route names: Hono has decoded it already, and decoding again turned an id with a % into a 500. */
  const id = (raw: string | undefined) => savedDeviceId(raw ?? '');
  const ids = (c: { req: { param(name: string): string | undefined } }) => [id(c.req.param('id')), connectionId(c.req.param('connection') ?? '')] as const;

  api.get('/device-types', async (c) => c.json(await familyFor(deps, c).deviceTypes()));

  api.get('/devices', async (c) => c.json({ devices: await familyFor(deps, c).devices.list() }));

  /** Removed devices, kept with their history: to bring back by adding again, or to delete. */
  api.get('/devices/removed', async (c) => c.json({ devices: await familyFor(deps, c).devices.removed() }));

  api.get('/devices/:id', async (c) => c.json(await familyFor(deps, c).devices.get(id(c.req.param('id')))));

  api.patch('/devices/:id', async (c) => {
    const changes = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), key: z.string().trim().min(1).max(63).optional() }).strict());
    return c.json(await familyFor(deps, c).devices.update(id(c.req.param('id')), changes));
  });

  api.delete('/devices/:id', async (c) => {
    await familyFor(deps, c).devices.remove(id(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/devices/:id/delete-history', async (c) => {
    const { name } = await body(c, z.object({ name: z.string().max(60) }).strict());
    return c.json({ ok: true, ...(await familyFor(deps, c).devices.deleteHistory(id(c.req.param('id')), name)) });
  });

  /** Paused, or resumed: kept, and not reached, until resumed. */
  api.put('/devices/:id/paused', async (c) => {
    const { paused } = await body(c, z.object({ paused: z.boolean() }).strict());
    return c.json(await familyFor(deps, c).devices.setPaused(id(c.req.param('id')), paused));
  });

  /** Where it has been, kept for so many days, or none of it: null forgets what was kept. */
  api.put('/devices/:id/track', async (c) => {
    const { days } = await body(c, z.object({ days: z.number().int().min(1).max(366).nullable() }).strict());
    return c.json(await familyFor(deps, c).devices.setTrack(id(c.req.param('id')), days));
  });

  /** Where it has been since a time, while that is kept: never cached, never in an export. */
  api.get('/devices/:id/track', async (c) => {
    const { since } = query(c, z.object({ since: z.iso.datetime({ offset: true }) }).strict());
    return c.json({ points: await familyFor(deps, c).devices.track(id(c.req.param('id')), since) });
  });

  /** Which picture it shows: the home says which it has. */
  api.put('/devices/:id/picture', async (c) => {
    const { picture } = await body(c, z.object({ picture: z.string().min(1).max(40) }).strict());
    return c.json(await familyFor(deps, c).devices.setPicture(id(c.req.param('id')), picture as `type:${number}`));
  });

  api.patch('/devices/:id/attributes', async (c) => {
    const input = await body(c, z.object({ patch: z.record(z.string().max(64), VALUE), confirmation: z.string().max(64).optional() }).strict());
    const result = await familyFor(deps, c).devices.write(id(c.req.param('id')), input);
    return c.json(result, result.outcome === 'verified' || result.outcome === 'unverified' ? 200 : 409);
  });

  api.get('/problems', async (c) => c.json({ problems: await familyFor(deps, c).problems(query(c, LIMITED).limit) }));
  api.get('/needs-you', async (c) => c.json({ needsYou: await familyFor(deps, c).needsYou() }));

  api.get('/devices/:id/events', async (c) => c.json({ events: await familyFor(deps, c).devices.events(id(c.req.param('id')), query(c, LIMITED).limit) }));

  api.get('/devices/:id/history', async (c) => {
    const asked = query(c, z.object({ key: z.string().min(1).max(64), points: z.coerce.number().int().min(20).max(1000).default(240), ...SPAN }).strict());
    return c.json(await familyFor(deps, c).devices.history(id(c.req.param('id')), asked));
  });

  api.get('/devices/:id/changes', async (c) => {
    const asked = query(c, z.object({ key: z.string().min(1).max(64).optional(), ...SPAN }).strict());
    return c.json(await familyFor(deps, c).devices.changes(id(c.req.param('id')), asked));
  });

  api.post('/devices/:id/parts/:part/commands/:capability/:command', async (c) => {
    const input = await body(c, z.object({ args: z.record(z.string().max(64), VALUE), confirmation: z.string().max(64).optional(), reason: z.string().min(1).max(200).optional() }).strict());
    const result = await familyFor(deps, c).devices.command(id(c.req.param('id')), c.req.param('part'), c.req.param('capability'), c.req.param('command'), input);
    return c.json(result, result.outcome === 'refused' ? 409 : 200);
  });

  /** A query a part's capability declares — a forecast's hours — answered in the type it declares. */
  api.post('/devices/:id/parts/:part/queries/:capability/:query', async (c) => {
    const { args } = await body(c, z.object({ args: z.record(z.string().max(64), VALUE).default({}) }).strict());
    const answer: unknown = await familyFor(deps, c).devices.query(id(c.req.param('id')), c.req.param('part'), c.req.param('capability'), c.req.param('query'), args);
    return c.json(answer);
  });

  /** A tool that only reads is a GET, its input in the query; one that writes is a POST. */
  api.get('/devices/:id/tools/:name', async (c) => c.json(await familyFor(deps, c).devices.tool(id(c.req.param('id')), c.req.param('name'), { input: c.req.query(), reading: true })));

  api.post('/devices/:id/tools/:name', async (c) => {
    const request = await body(c, z.object({ input: z.record(z.string().max(64), VALUE).optional(), confirmation: z.string().max(64).optional() }).strict());
    return c.json(await familyFor(deps, c).devices.tool(id(c.req.param('id')), c.req.param('name'), request));
  });

  /** Lets devices join a bridge that devices join — a Zigbee coordinator — for a while; 0 stops them. */
  api.post('/devices/:id/join', async (c) => {
    const { seconds } = await body(c, z.object({ seconds: z.number().int().min(0).max(3600) }).strict());
    return c.json(await familyFor(deps, c).devices.join(id(c.req.param('id')), seconds));
  });

  // --- how it is reached ---------------------------------------------------------

  api.post('/devices/:id/connections/:connection/prefer', async (c) => c.json(await familyFor(deps, c).connections.prefer(...ids(c))));

  api.delete('/devices/:id/connections/:connection', async (c) => c.json(await familyFor(deps, c).connections.remove(...ids(c))));

  api.put('/devices/:id/connections/:connection/secrets', async (c) => {
    const given = await body(c, z.record(z.string().max(64), z.string().min(1).max(4096)));
    return c.json(await familyFor(deps, c).connections.setSecrets(...ids(c), given));
  });

  api.patch('/devices/:id/connections/:connection', async (c) => {
    const input = await body(c, z.object({ secretsExportable: z.boolean(), yourPassword: z.string().max(256).optional() }).strict());
    // Letting a kept secret leave is the account's to say, not a borrowed session's.
    if (input.secretsExportable) {
      const refused = await confirm(c, input.yourPassword);
      if (refused) return refused;
    }
    return c.json(await familyFor(deps, c).connections.setExportable(...ids(c), input.secretsExportable));
  });

  return api;
}
