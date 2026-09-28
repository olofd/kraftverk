import { Hono } from 'hono';

import type { MessageBroker } from './broker.ts';
import type { Journal } from './journal.ts';
import { sameSecret, type BrokerHealth, type JournalLevel } from './shared.ts';

/**
 * The broker's HTTP side: how the server, the CLI and the app find out what it
 * is doing.
 *
 * `/health` is open, and says only what anyone who can reach the port could
 * learn anyway: that this is a kraftverk broker, which build, since when. The
 * rest needs the token, because the journal is a record of your devices and
 * `/shutdown` drops them.
 */
export type AdminDeps = {
  broker: MessageBroker;
  journal: Journal;
  token: string;
  build: string;
  mqtt: { host: string };
  admin: { host: string; port: number };
  /** Called by `/shutdown`, after the response has been sent. */
  shutdown: (reason: string) => void;
};

export function adminApp(deps: AdminDeps): Hono {
  const app = new Hono();

  const health = (): BrokerHealth => ({
    ok: true,
    name: 'kraftverk-broker',
    pid: process.pid,
    startedAt: deps.broker.startedAt.toISOString(),
    uptimeMs: Date.now() - deps.broker.startedAt.getTime(),
    build: deps.build,
    runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`,
    mqtt: { host: deps.mqtt.host, port: deps.broker.port ?? 0, listening: deps.broker.listening },
    admin: deps.admin,
    devicesOnline: deps.broker.devices.filter((d) => d.online).length,
    protocols: deps.broker.protocols,
  });

  app.get('/health', (c) => c.json(health()));

  app.use('*', async (c, next) => {
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!sameSecret(given, deps.token)) return c.json({ error: 'The broker token is required' }, 401);
    await next();
  });

  app.get('/status', (c) => c.json({ ...health(), ...deps.broker.status(), journal: deps.journal.file }));

  /**
   * Journal entries after `after`, oldest first.
   *
   * `level=info` (the default) is the story: connections, subscriptions,
   * writes, disconnects and why. `level=debug` adds every poll and every
   * telemetry frame.
   */
  app.get('/journal', (c) => {
    const level = (c.req.query('level') ?? 'info') as JournalLevel;
    return c.json({
      lastSeq: deps.journal.lastSeq,
      entries: deps.journal.query({
        after: Number(c.req.query('after') ?? 0),
        limit: Number(c.req.query('limit') ?? 200),
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        device: c.req.query('device') || undefined,
        kinds: c.req.query('kind')?.split(',').filter(Boolean),
      }),
    });
  });

  /** Messages in both directions, newest last: what a device said and what it was told. */
  app.get('/traffic', (c) => {
    const entries = deps.journal.query({
      level: 'debug',
      kinds: ['device.message', 'command', 'command.undelivered'],
      limit: Number(c.req.query('limit') ?? 100),
      device: c.req.query('device') || undefined,
    });
    return c.json(
      entries.map((entry) => {
        const data = entry.data ?? {};
        return {
          at: entry.at,
          direction: entry.kind === 'device.message' ? 'in' : 'out',
          address: entry.device ?? '',
          topic: String(data.topic ?? ''),
          bytes: Number(data.bytes ?? 0),
          hex: String(data.hex ?? '').slice(0, 400),
          summary: String(data.summary ?? data.command ?? ''),
          delivered: entry.kind !== 'command.undelivered',
        };
      })
    );
  });

  app.post('/shutdown', (c) => {
    const reason = c.req.query('reason') || 'asked to by the admin API';
    // After the response is on its way, so the caller hears that it worked.
    setTimeout(() => deps.shutdown(reason), 50);
    return c.json({ ok: true, stopping: true });
  });

  return app;
}
