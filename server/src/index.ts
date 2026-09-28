import { ActionGateway } from '@kraftverk/gateway';
import { createApp } from './app.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { loadConfig, transportEnabled } from './config.ts';
import { DeviceCatalog } from './devices/catalog.ts';
import { ClientStore } from './devices/clients.ts';
import { ConnectionStore } from './devices/connections.ts';
import { LinkStore } from './devices/links.ts';
import { Nearby } from './devices/nearby.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { DeviceSessionManager } from './devices/sessions.ts';
import { SetupService } from './devices/setup.ts';
import { DeviceTypeRegistry } from './devices/types.ts';
import { appState, audit, closeDb, setAppState } from './history/db.ts';
import { Sampler } from './history/sampler.ts';
import { keepConsole } from './log.ts';
import { scopedHttp } from './runtime/http.ts';
import { ProtocolRegistry } from './runtime/protocols.ts';
import { TransportHost } from './runtime/transports.ts';

/*
  The server process: everything that starts something.

  The HTTP routes are built by `createApp` in `app.ts`, from what is started
  here. That split is what lets the routes be tested — importing this file
  starts transports; importing `app.ts` starts nothing.
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

  The work is whatever has been started by then — sampling, sessions,
  transports — run together and bounded, so nothing that will not close can
  hold the exit up; then the database is closed. The MQTT broker is left
  alone: it is a process of its own, and keeps the devices while we are gone.
*/
const stopWork: (() => unknown)[] = [];
const onStop = (...work: (() => unknown)[]) => stopWork.push(...work);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const started = Date.now();
    console.log(`[server] ${signal}: stopping.`);
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
 * What is installed: protocols, transports and device types, each found in
 * its folder under `packages/` rather than listed here (docs/ARCHITECTURE.md §3).
 */
const protocols = new ProtocolRegistry();
await protocols.discover();

const transports = new TransportHost({
  enabled: transportEnabled(config),
  context: {
    env: config.env,
    log: (level, message) => console[level === 'info' ? 'log' : level](message),
    audit: (entry) => audit({ at: new Date().toISOString(), ...entry }),
  },
});
await transports.discover();

const types = new DeviceTypeRegistry();
await types.discover();
types.checkConnections({ protocol: (id) => protocols.get(id), transport: (id) => transports.definition(id) });

console.log(
  `[devices] Installed: ${types.all().map((type) => type.id).join(', ') || 'no device types'}; ` +
    `protocols ${protocols.all().map((protocol) => protocol.id).join(', ') || 'none'}; ` +
    `transports ${transports.definitions().map((definition) => definition.id).join(', ') || 'none'}`
);

/** What you have, how each is reached, and how they fit the house. */
const catalog = new DeviceCatalog();
const connections = new ConnectionStore();
const links = new LinkStore();
const clients = new ClientStore();

const sessions = new DeviceSessionManager({
  types,
  protocols,
  transports,
  connections,
  simulate: config.simulate,
  readOnly: config.readOnly,
  allowRawFrames: config.allowRawFrames,
  clientName: (id) => clients.get(id)?.name ?? null,
  // A device saved before it ever answered learns who it is the first time it does.
  onIdentified: (deviceId, identity) => {
    if (catalog.byIdentity(identity).active) return;
    catalog.update(deviceId, { identity });
  },
  log: (message) => console.log(`[devices] ${message}`),
});

if (!config.simulate) {
  /*
    Every transport this server may use starts now, before any session:
    finding a device has to work before there is one to open. MQTT attaches to
    the broker that is already running — the stations have been connected to it
    all along — or starts one. One that cannot start here, Bluetooth in a
    container, is reported and left out.
  */
  await transports.startAll(config.transports);
  for (const id of config.transports) {
    const available = transports.available(id);
    if (!available.ok) console.error(`[transports] ${id} is unavailable: ${available.reason}`);
  }

  /*
    Both modes announce themselves. Read-only saying so and write mode saying
    nothing would mean the dangerous state is the silent one.
  */
  if (config.readOnly) {
    console.log('READ-ONLY: every write will be refused. Nothing can change on any device.');
  } else {
    console.warn(
      'WRITES ALLOWED: this process can change settings on real hardware. ' +
        'The wrong register can destroy a station permanently — see the hardware warning in the README.'
    );
  }
}

// Sessions for the devices already in the catalog, and nothing else.
await sessions.sync(catalog.list());

const registry = new DeviceRegistry({ catalog, types, sessions, connections, links, clients, transports });

const setup = new SetupService({ types, protocols, transports, catalog, connections, links, sessions, http: scopedHttp, simulate: config.simulate });

const nearby = new Nearby({ types, protocols, transports, connections });

/**
 * The only path a command to hardware takes. What a plug feeds comes from the
 * links, so switching one is verified against the station it actually feeds.
 */
const gateway = new ActionGateway({
  device: (id) => {
    const record = catalog.active(id);
    return record ? { name: record.name, session: sessions.get(id), offline: sessions.health(record).detail } : null;
  },
  feeds: (id) => links.targetOf('feeds', id),
  isReadOnly: () => config.readOnly,
  record: audit,
  memory: { get: appState, set: setAppState },
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
  links,
  clients,
  types,
  protocols,
  transports,
  sessions,
  registry,
  setup,
  nearby,
  gateway,
  sampler,
  proxies,
  serverLog,
  startedAt,
});

// Everything is running: from here on, stopping also closes what was opened.
onStop(
  () => sampler.stop(),
  () => setup.stop(),
  () => nearby.stop(),
  () => sessions.closeAll(),
  () => transports.stopAll()
);

const saved = catalog.list().length;
console.log(
  `kraftverk API listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} ` +
    `(${config.simulate ? 'simulator' : config.transports.join(' + ')}, ` +
    `${saved === 1 ? '1 device' : `${saved} devices`})`
);

/*
  Bun closes a connection that has been quiet for 10 s by default, and some
  answers take far longer: switching a plug waits for it and the station it
  feeds to agree (up to 30 s), and a setup helper may scan the network (up to
  90 s). With the default, the switch still happened but the app was told it
  failed — and a retry toggled it again. Above the longest of those, within
  Bun's limit of 255.
*/
export default { port: config.port, hostname: config.host, fetch: app.fetch, idleTimeout: 120 };
