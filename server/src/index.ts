import { savedDeviceId, stationId } from '@kraftverk/device-sdk';

import { ActionGateway } from './actions/gateway.ts';
import { createApp } from './app.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { duration, formatEntry } from './broker/journal.ts';
import { brokerDir, brokerToken } from './broker/shared.ts';
import { BrokerSupervisor } from './broker/supervisor.ts';
import { loadConfig } from './config.ts';
import { ConnectionManager } from './connections/manager.ts';
import { DeviceCatalog } from './devices/catalog.ts';
import { LegacyStationImport } from './devices/legacy.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { relayStation } from './devices/relay-pairing.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import { appState, audit, closeDb, setAppState } from './history/db.ts';
import { Sampler } from './history/sampler.ts';
import { keepConsole } from './log.ts';
import { BrokerBus } from './mqtt/bus.ts';
import { PluginHost } from './plugins/host.ts';
import type { BrokerDeps } from './routes/shared.ts';
import { BleHost } from './transport/ble.ts';
import { MqttHost } from './transport/mqtt.ts';

/*
  The server process: everything that starts something.

  The HTTP routes are built by `createApp` in `app.ts`, from what is started
  here. That split is what lets the routes be tested — importing this file
  starts radios and a broker; importing `app.ts` starts nothing.
*/

const config = loadConfig();

// First, so everything below is kept as well as printed. See `log.ts`.
const serverLog = keepConsole(config.logDir);

/*
  Stopping, when asked to — registered before anything else starts.

  In a container the server is process 1, and process 1 has no default action
  for SIGTERM: without a handler, every deploy waited out Docker's ten-second
  grace period and then killed it, database open. Registered this early
  because startup takes seconds on a small NAS, and a stop that arrives
  during it must be honoured too.

  The work is whatever has been started by then — sampling, station links,
  plugins — run together and bounded, so nothing that will not close can hold
  the exit up; then the database is closed. The broker is left alone: it is
  not ours to stop, and it keeps the station while we are gone.
*/
const stopWork: (() => unknown)[] = [];
const onStop = (...work: (() => unknown)[]) => stopWork.push(...work);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const started = Date.now();
    console.log(`[server] ${signal}: stopping. The broker keeps running.`);
    const exit = (how: string) => {
      console.log(`[server] Stopped ${how} in ${Date.now() - started} ms`);
      try {
        closeDb();
      } finally {
        process.exit(0);
      }
    };
    const deadline = setTimeout(() => exit('at the deadline, with work unfinished'), 3000);
    void Promise.allSettled(stopWork.map(async (work) => work())).then(() => {
      clearTimeout(deadline);
      exit('cleanly');
    });
  });
}

const startedAt = new Date();

/**
 * The MQTT broker, which is a process of its own.
 *
 * Restarting the server — every edit, under `--watch` — used to restart the
 * broker inside it, and a P280 that loses its broker for long enough stops
 * trying to come back. So the broker outlives the server: this attaches to one
 * already running, or starts one detached, and on the way out leaves it be.
 * See `src/broker/`.
 */
const USES_MQTT = config.transports.includes('mqtt');
const BROKER_DIR = brokerDir();

const supervisor = USES_MQTT
  ? new BrokerSupervisor({
      adminUrl: config.mqtt.adminUrl,
      mqtt: { host: config.mqtt.brokerHost, port: config.mqtt.port },
      spawn: config.mqtt.spawn,
      dir: BROKER_DIR,
      env: {
        MQTT_HOST: config.mqtt.host,
        MQTT_PORT: String(config.mqtt.port),
        BROKER_ADMIN_PORT: String(config.mqtt.adminPort),
        BROKER_LOG_LEVEL: config.mqtt.logLevel,
      },
      log: (message, level = 'info') => console[level === 'info' ? 'log' : level](`[broker] ${message}`),
    })
  : null;

const bus = USES_MQTT
  ? new BrokerBus({ host: config.mqtt.brokerHost, port: config.mqtt.port, token: () => brokerToken(BROKER_DIR) })
  : null;

async function brokerAdmin<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${config.mqtt.adminUrl}${path}`, {
      headers: { authorization: `Bearer ${brokerToken(BROKER_DIR)}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

const broker: BrokerDeps | null = supervisor && bus ? { supervisor, bus, admin: brokerAdmin } : null;

if (bus) {
  bus.on('connected', () => console.log(`[broker] Connected to the broker at ${config.mqtt.brokerHost}:${config.mqtt.port}`));
  bus.on('disconnected', (error) => console.warn(`[broker] Lost the broker${error ? `: ${error.message}` : ''}. Reconnecting…`));
  // Why it cannot connect — refused token, nothing listening, no handshake —
  // or a subscription it was refused: once per distinct reason, not per retry.
  bus.on('failed', (error) => console.warn(`[broker] Problem with the broker connection: ${error.message}`));

  /*
    What the station does, in this terminal. The broker publishes its journal's
    notable entries — connections, subscriptions, writes, disconnects and why —
    and the server prints them, so the one window you are watching says whether
    the station is there. Polls and telemetry stay in the broker's own journal.
  */
  bus.on('journal', (entry) => {
    const line = `[broker] ${formatEntry(entry)}`;
    if (entry.level === 'error') console.error(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.log(line);
  });

  /*
    Something on the network tried to command a station through the broker,
    and was cut off: a misconfigured integration or an attack, worth a durable
    record either way. One audit row per client per minute, so a client that
    reconnects in a loop cannot fill the timeline.
  */
  const lastRefusalAudit = new Map<string, number>();
  bus.on('journal', (entry) => {
    if (entry.kind !== 'mqtt.refused') return;
    const key = entry.clientId ?? '';
    const now = Date.now();
    if (now - (lastRefusalAudit.get(key) ?? 0) < 60_000) return;
    lastRefusalAudit.set(key, now);
    audit({
      at: entry.at,
      kind: 'mqtt.refused',
      actor: entry.clientId ?? 'unknown',
      resource: entry.station ?? String(entry.data?.topic ?? '').split('/')[0],
      summary: entry.message,
      detail: entry.data,
    });
  });
}

/**
 * What this process can reach, and what it is reaching right now.
 *
 * The catalog says what you own; the connection manager opens one session per
 * saved station and is the only thing that knows about live drivers and links.
 */
const catalog = new DeviceCatalog();

const connections = new ConnectionManager({
  transports: config.transports,
  simulate: config.simulate,
  readOnly: config.readOnly,
  autoBind: config.autoBind,
  host: (kind) => (kind === 'ble' ? new BleHost() : new MqttHost(bus!)),
  simulator: () => new SimulatorDriver(),
  // Where a device is reached is a property of that device, so the answer is
  // written onto its own record.
  onBound: (deviceId, kind, boundId) => {
    catalog.update(deviceId, { config: { transport: kind, boundId } });
  },
  log: (message) => console.log(`[link] ${message}`),
});

const host = new PluginHost();
await host.discover();
await host.startEnabled();

const registry = new DeviceRegistry(catalog, host, connections);

if (!config.simulate) {
  /*
    Every offered transport starts here, before any session, because discovery
    has to work before there is a device to bind. The broker comes first:
    attached if it is already running — the station has been connected to it
    all along — or started if not. Then watched, so a broker that dies is
    replaced while this server runs.
  */
  if (supervisor) {
    const state = await supervisor.ensure();
    if (state.status === 'running' && state.health && !state.started) {
      const { health } = state;
      console.log(
        `[broker] Attached to the running broker (pid ${health.pid}, up ${duration(health.uptimeMs)}): ` +
          `${health.stationsOnline} station(s) online, stations connect to ${health.mqtt.host}:${health.mqtt.port}`
      );
    }
    supervisor.watch();
  }

  await connections.startTransports();

  for (const kind of config.transports) {
    const problem = connections.transportError(kind);
    if (problem) {
      console.error(`${kind} is unavailable: ${problem}`);
      continue;
    }
    if (kind === 'ble') console.log('Scanning for Bluetooth stations…');
    else if (bus && !bus.connected) console.warn('[broker] Not connected to the broker yet; retrying in the background');
  }

  /*
    Both modes announce themselves. Read-only saying so and write mode saying
    nothing would mean the dangerous state is the silent one.
  */
  if (config.readOnly) {
    console.log('READ-ONLY: every write will be refused. Nothing can change on the station.');
  } else {
    console.warn(
      'WRITES ALLOWED: this process can change settings on a real station. ' +
        'The wrong register can destroy it permanently — see the hardware warning in the README.'
    );
  }
}

// Sessions for the stations already in the catalog, and nothing else.
await connections.sync(catalog.list());

// Where each saved Wi-Fi station stands with the broker, said once at startup.
if (bus?.connected) {
  for (const session of connections.sessions.filter((s) => s.kind === 'mqtt' && s.link?.boundId)) {
    const mac = session.link!.boundId!;
    const station = bus.presence(mac);
    const name = catalog.get(session.deviceId)?.name ?? session.deviceId;
    console.log(
      `[broker] ${name} (${mac}): ` +
        (!station
          ? 'has not connected to the broker yet'
          : station.online
            ? `connected from ${station.remote} since ${new Date(station.connectedAt!).toLocaleTimeString()}`
            : `not connected; its last session ended at ${new Date(station.disconnectedAt ?? Date.now()).toLocaleTimeString()}: ${station.lastDisconnect ?? 'reason unknown'}`)
    );
  }
}

if (config.deviceId) {
  /*
    `--device=` names a *station*, so it also has to name the saved device that
    should hold it. `--for=` is that; without it the flag can only be honoured
    when there is exactly one saved station.
  */
  const stations = connections.sessions.filter((session) => session.kind !== 'sim');
  const target = config.deviceFor ? savedDeviceId(config.deviceFor) : stations.length === 1 ? stations[0]!.deviceId : null;
  if (!target) {
    console.log(
      stations.length === 0
        ? `[link] --device=${config.deviceId} ignored: no station has been added yet`
        : `[link] --device=${config.deviceId} ignored: ${stations.length} stations are saved. Add --for=<saved device id> to say which one should hold it.`
    );
  } else {
    await connections.bind(target, stationId(config.deviceId)).catch((error: unknown) => {
      console.log(`[link] --device=${config.deviceId} could not be bound: ${(error as Error).message}`);
    });
  }
}

/**
 * The only thing allowed to switch mains. Verified against the station the
 * relay is recorded as feeding — see `devices/relay-pairing.ts`.
 */
const gateway = new ActionGateway({
  host,
  readStation: () => relayStation(connections),
  isReadOnly: () => connections.readOnly,
  memory: { get: appState, set: setAppState },
});

/*
  Nothing is adopted at startup. The one exception is offered rather than
  taken: a station bound before the catalog existed can be imported, once.
*/
const legacyStation = new LegacyStationImport({
  catalog,
  transport: () => connections.hosts.map(({ kind }) => kind),
  stationName: (boundId) =>
    connections.hosts
      .flatMap(({ host: radio }) => radio.discovered())
      .find((d) => d.id.toUpperCase() === boundId.toUpperCase())?.name ?? 'Power station',
});

const sampler = new Sampler(registry);
sampler.start();

/** The web container, the one proxy whose "home-network entrance" stamp is believed. */
const proxies = new ProxyDirectory(config.trustedProxies);
proxies.start();

const { app } = createApp({
  config,
  catalog,
  connections,
  host,
  registry,
  gateway,
  sampler,
  legacyStation,
  proxies,
  serverLog,
  broker,
  startedAt,
});

// Everything is running: from here on, stopping also closes what was opened.
onStop(
  () => sampler.stop(),
  () => connections.closeAll(),
  () => bus?.stop(),
  () => host.stopAll()
);

const open = connections.sessions.length;
console.log(
  `Aferiy API listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} ` +
    `(${config.simulate ? 'simulator' : config.transports.join(' + ')}, ` +
    `${open === 1 ? '1 station open' : `${open} stations open`})`
);

/*
  Bun closes a connection that has been quiet for 10 s by default, and some
  answers take far longer: switching the grid relay waits for the plug and the
  station to agree (up to 30 s), and a plugin's setup action may scan the
  network (up to 90 s). With the default, the switch still happened but the app
  was told it failed — and a retry toggled it again. Above the longest of those,
  within Bun's limit of 255.
*/
export default { port: config.port, hostname: config.host, fetch: app.fetch, idleTimeout: 120 };
