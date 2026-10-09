import { Hono } from 'hono';
import { z } from 'zod';

import { SCRIPT_LIMITS } from '@kraftverk/automation';

import { familyFor, type AppDeps } from './context.ts';
import { body } from './parse.ts';

/**
 * Scripts (docs/PLAN-SCRIPTS.md) over HTTP: what each route takes, checked,
 * handed to the home (`KraftverkApi.scripts`), and its answer. A script too
 * long for a script is the home's to say, in its words; one far longer is
 * not read at all. A script that does not read is refused with each of its
 * problems.
 */

const SOURCE = z.string().max(SCRIPT_LIMITS.sourceBytes * 2);
const NAME = z.string().min(1).max(120);
const KEY = z.string().min(1).max(63);

export function scriptRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.get('/scripts', async (c) => c.json(await familyFor(deps, c).scripts.list()));

  api.post('/scripts', async (c) => {
    const input = await body(c, z.object({ key: KEY.optional(), name: NAME, source: SOURCE }).strict());
    return c.json(await familyFor(deps, c).scripts.create(input), 201);
  });

  api.post('/scripts/check', async (c) => {
    const input = await body(c, z.object({ source: SOURCE }).strict());
    return c.json(await familyFor(deps, c).scripts.check(input.source));
  });

  api.get('/scripts/types', async (c) => c.json({ types: await familyFor(deps, c).scripts.types() }));

  api.get('/scripts/:id', async (c) => c.json(await familyFor(deps, c).scripts.get(c.req.param('id'))));

  api.patch('/scripts/:id', async (c) => {
    const changes = await body(c, z.object({ key: KEY.optional(), name: NAME.optional(), source: SOURCE.optional() }).strict());
    return c.json(await familyFor(deps, c).scripts.update(c.req.param('id'), changes));
  });

  api.delete('/scripts/:id', async (c) => {
    await familyFor(deps, c).scripts.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  return api;
}
