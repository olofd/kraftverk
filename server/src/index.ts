import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import pkg from '../package.json' with { type: 'json' };
import { station } from './station.ts';
import {
  PortIdSchema,
  PortPatchSchema,
  StationSettingsPatchSchema,
  type VersionInfo,
} from './types.ts';

const PORT = Number(process.env.PORT ?? 3333);
// 0.0.0.0 so Expo Go on a phone can reach the dev machine over the LAN.
const HOST = process.env.HOST ?? '0.0.0.0';
const TICK_MS = 1000;

await station.load();
setInterval(() => station.tick(), TICK_MS);

const app = new Hono();

// The client polls /status every couple of seconds; logging that would drown
// out everything worth reading.
app.use('*', async (c, next) =>
  c.req.path === '/api/status' ? next() : logger()(c, next)
);
app.use(
  '/api/*',
  cors({
    // The client's origin varies during development (localhost, a LAN IP, or
    // Expo Go with no origin at all). This is a local-network appliance
    // controller — tighten this to an allowlist before exposing it anywhere.
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })
);

const api = new Hono();

api.get('/health', (c) => c.json({ ok: true }));

api.get('/version', (c) => {
  const runtime =
    typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.versions.node}`;

  const info: VersionInfo = {
    name: pkg.name,
    version: pkg.version,
    runtime,
    startedAt: station.startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - station.startedAt.getTime()) / 1000),
  };
  return c.json(info);
});

api.get('/status', (c) => c.json(station.status()));

api.get('/settings', (c) => c.json(station.settings));

api.patch('/settings', zValidator('json', StationSettingsPatchSchema), async (c) =>
  c.json(await station.applySettings(c.req.valid('json')))
);

api.post(
  '/ports/:id',
  zValidator('param', z.object({ id: PortIdSchema })),
  zValidator('json', PortPatchSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    return c.json(station.setPort(id, enabled));
  }
);

/** Dev affordance: pretend the wall plug was pulled, to exercise the UI. */
api.post('/grid', zValidator('json', z.object({ connected: z.boolean() })), (c) =>
  c.json(station.setGridConnected(c.req.valid('json').connected))
);

app.route('/api', api);

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error('[server]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

console.log(`Aferiy API listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
};
