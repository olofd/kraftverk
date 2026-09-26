import { rmSync, writeFileSync } from 'node:fs';

import { adminApp } from './admin.ts';
import { StationBroker } from './broker.ts';
import { Journal, type JournalOptions } from './journal.ts';
import { brokerBuild, brokerDir, brokerToken, DEFAULTS, paths } from './shared.ts';

/**
 * The broker, as a process of its own.
 *
 * Started by the server when it finds none running (see `supervisor.ts`), by
 * `npm run broker`, or as its own container. The server never stops it: a
 * server restart is a non-event to the station, which stays connected here.
 *
 * Environment:
 *   MQTT_HOST / MQTT_PORT                 where stations connect (0.0.0.0:1883)
 *   BROKER_ADMIN_HOST / BROKER_ADMIN_PORT the admin API (127.0.0.1:3883)
 *   KRAFTVERK_BROKER_DIR                  token, state and logs (server/data/broker)
 *   KRAFTVERK_BROKER_TOKEN                the server's secret, instead of the token file
 *   BROKER_LOG_LEVEL                      console verbosity: debug, info, warn, error, off (info)
 *   BROKER_LOG_DAYS                       days of journal files to keep (14)
 */

const env = process.env;

/** A port from the environment, or the default — and a clear exit for anything else. */
function port(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`[broker] ${name}=${raw} is not a port number.`);
    process.exit(2);
  }
  return value;
}

const LEVELS = ['debug', 'info', 'warn', 'error', 'off'] as const;
const consoleLevel = (LEVELS as readonly string[]).includes(env.BROKER_LOG_LEVEL ?? '')
  ? (env.BROKER_LOG_LEVEL as JournalOptions['consoleLevel'])
  : 'info';

const mqtt = { host: env.MQTT_HOST || DEFAULTS.mqttHost, port: port('MQTT_PORT', DEFAULTS.mqttPort) };
const admin = {
  host: env.BROKER_ADMIN_HOST || DEFAULTS.adminHost,
  port: port('BROKER_ADMIN_PORT', DEFAULTS.adminPort),
};
const dir = brokerDir();
const files = paths(dir);
const build = brokerBuild();
const token = brokerToken(dir);

const journal = new Journal({
  dir: files.logs,
  consoleLevel,
  retainDays: Number(env.BROKER_LOG_DAYS ?? 14),
});

const broker = new StationBroker({
  host: mqtt.host,
  port: mqtt.port,
  token,
  journal,
  stationsFile: files.stations,
});

let stopping = false;

async function shutdown(reason: string, code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    journal.info({ kind: 'broker.stop', message: `Broker stopping: ${reason}`, data: { reason } });
    await broker.stop(reason).catch(() => undefined);
    server?.stop(true);
    rmSync(files.state, { force: true });
  }
  process.exit(code);
}

try {
  await broker.start();
} catch (error) {
  const message = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? `Port ${mqtt.port} is already in use. Another broker is running — \`npm run broker:status\` says whose — ` +
      'or something else holds the port.'
    : (error as Error).message;
  journal.error({ kind: 'broker.failed', message: `The broker could not start: ${message}`, data: { mqtt } });
  process.exit(1);
}

let server: ReturnType<typeof Bun.serve> | null = null;
try {
  server = Bun.serve({
    hostname: admin.host,
    port: admin.port,
    fetch: adminApp({ broker, journal, token, build, mqtt, admin, shutdown: (reason) => void shutdown(reason) }).fetch,
  });
} catch (error) {
  journal.error({
    kind: 'broker.failed',
    message: `The admin API could not listen on ${admin.host}:${admin.port}: ${(error as Error).message}`,
  });
  await shutdown('the admin API could not start', 1);
}

// Where the CLI and the server look first, before assuming the defaults.
writeFileSync(
  files.state,
  JSON.stringify({ pid: process.pid, startedAt: broker.startedAt.toISOString(), build, mqtt: { ...mqtt, port: broker.port }, admin }, null, 2)
);

journal.info({
  kind: 'broker.start',
  message:
    `Broker ${build} (pid ${process.pid}) listening for stations on ${mqtt.host}:${broker.port}; ` +
    `admin API on http://${admin.host}:${admin.port}; journal in ${files.logs}`,
  data: { pid: process.pid, build, mqtt, admin, dir },
});

const known = broker.stations;
if (known.length) {
  journal.info({
    kind: 'broker.expecting',
    message: `Expecting ${known.map((s) => `${s.station}${s.remote ? ` (last from ${s.remote.split(':')[0]})` : ''}`).join(', ')} to reconnect`,
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(`received ${signal}`));
}

// A broker that dies takes the station with it, so a crash is written down
// with its stack before the process goes. The server's watchdog starts a new one.
process.on('uncaughtException', (error) => {
  journal.error({ kind: 'broker.crash', message: `Broker crashed: ${error.stack ?? error.message}` });
  void shutdown('it crashed', 1);
});
process.on('unhandledRejection', (reason) => {
  journal.error({ kind: 'broker.crash', message: `Unhandled rejection in the broker: ${String((reason as Error)?.stack ?? reason)}` });
});
