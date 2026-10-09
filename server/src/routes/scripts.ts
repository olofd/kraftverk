import { Hono } from 'hono';
import { z } from 'zod';

import { SCRIPT_LIMITS } from '@kraftverk/automation';

import { familyFor, type AppDeps } from './context.ts';
import { body } from './parse.ts';

/**
 * Scripts (docs/PLAN-SCRIPTS.md) over HTTP: what each route takes, checked,
 * handed to the home (`KraftverkApi.scripts`), and its answer. A script too
 * long for a script is the home's to say, in its words; one far longer is
 * not read at all.
 */
export function scriptRoutes(deps: AppDeps): Hono {
  const api = new Hono();

  api.post('/scripts/check', async (c) => {
    const input = await body(c, z.object({ source: z.string().max(SCRIPT_LIMITS.sourceBytes * 2) }).strict());
    return c.json(await familyFor(deps, c).scripts.check(input.source));
  });

  return api;
}
