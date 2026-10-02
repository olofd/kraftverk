import { existsSync } from 'node:fs';

import { ActionGateway } from '@kraftverk/gateway';
import { LiveBus } from '@kraftverk/holder';
import { createApp } from './app.ts';
import { Attention } from './attention/attention.ts';
import { keepWatchedFresh } from './attention/freshness.ts';
import { AutomationEngine, serverDevices } from './automations/engine.ts';
import { plans } from './automations/plans.ts';
import { restoreFrom } from './config/restore.ts';
import { ConfigSnapshot } from './config/snapshot.ts';
import { AutomationLibrary } from './automations/library.ts';
import { AutomationStore } from './automations/store.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { DeviceCatalog } from './devices/catalog.ts';
import { EventStore } from './devices/events.ts';
import { ClientStore } from './devices/clients.ts';
import { ConnectionStore } from './devices/connections.ts';
import { LinkStore } from './devices/links.ts';
import { Nearby } from './devices/nearby.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { RemoteReadings } from './devices/remote.ts';
import { DeviceSessionManager } from './devices/sessions.ts';
import { SetupService } from './devices/setup/index.ts';
import { DeviceTypeRegistry } from './devices/types.ts';
import { databaseLedger } from './devices/ledger.ts';
import { audit, closeDb, startedFresh } from './history/db.ts';
import { policyValues } from './history/policy.ts';
import { ChangeLog } from './history/changes.ts';
import { transportStore } from './history/transport-store.ts';
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

/*
  A promise rejected with no one listening — a bug, always — is said, not
  died of. A process that ends at one restarts into the same condition: a
  device closing every connection had the server down in a loop, logging in
  to every cloud account at each start until they refused it.
*/
process.on('unhandledRejection', (reason) => {
  console.error('[server] A promise failed with no one to tell — a bug; kept running:', reason);
});

const startedAt = new Date();

/**
 * What is installed: protocols, transports and device types, each found in
 * its folder under `packages/` rather than listed here (docs/ARCHITECTURE.md §3).
 */
const protocols = new ProtocolRegistry();
await protocols.discover();

const transports = new TransportHost({
  context: {
    env: config.env,
    log: (level, message) => console[level === 'info' ? 'log' : level](message),
    audit: (entry) => audit({ at: new Date().toISOString(), ...entry }),
  },
  store: transportStore,
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

/** What devices say as they say it: readings, events, a changed description. */
const bus = new LiveBus();
const events = new EventStore();

const sessions = new DeviceSessionManager({
  types,
  protocols,
  transports,
  connections,
  readOnly: config.readOnly,
  allowRawFrames: config.allowRawFrames,
  clientName: (id) => clients.get(id)?.name ?? null,
  // A device saved before it ever answered learns who it is the first time it does.
  onIdentified: (deviceId, identity) => {
    if (catalog.byIdentity(identity).active) return;
    catalog.update(deviceId, { identity });
  },
  onDescribed: (deviceId, description, info, source) => catalog.describe(deviceId, description, info, source),
  onEvent: (deviceId, event) => events.record(deviceId, event),
  bus,
  log: (message) => console.log(`[devices] ${message}`),
});

/*
  Every installed transport an installed device type uses starts now, before
  any session: finding a device has to work before there is one to open. None
  is chosen by configuration — what reaches a device is how it was added. MQTT
  attaches to the broker that is already running — its devices have been
  connected to it all along — or starts one. One that cannot run here,
  Bluetooth in a container, is reported and left out; connections over it say
  why they are not reached.
*/
const needed = new Set(types.all().flatMap((type) => type.connections.map((method) => method.transport)));
const starting = transports.definitions().map((definition) => definition.id).filter((id) => needed.has(id));
await transports.startAll(starting);
for (const id of starting) {
  const available = transports.available(id);
  if (!available.ok) console.warn(`[transports] ${id} is unavailable here: ${available.reason}`);
}

/*
  Both modes announce themselves. Read-only saying so and write mode saying
  nothing would mean the dangerous state is the silent one. Simulated devices
  reach no hardware, and take writes either way.
*/
if (config.readOnly) {
  console.log('READ-ONLY: every write to hardware will be refused.');
} else {
  console.warn(
    'WRITES ALLOWED: this process can change settings on real hardware. ' +
      'The wrong register can destroy a device permanently — see the hardware warning in the README.'
  );
}

// Sessions for the devices already in the catalog, and nothing else.
await sessions.sync(catalog.list());

const remote = new RemoteReadings();
const registry = new DeviceRegistry({ catalog, types, sessions, connections, links, clients, transports, remote });

const setup = new SetupService({ types, protocols, transports, catalog, connections, links, sessions, http: scopedHttp });

const nearby = new Nearby({ types, protocols, transports, connections });

/**
 * The only path a command to hardware takes. What a part is linked to comes
 * from the links, so a command on it is verified against what it reaches.
 */
const gateway = new ActionGateway({
  device: (id) => {
    const record = catalog.active(id);
    return record ? { name: record.name, session: sessions.get(id), description: sessions.description(record), offline: sessions.health(record).detail } : null;
  },
  linksFrom: (id, part) => links.from(id, part).map((link) => ({ kind: link.kind, target: link.target })),
  isReadOnly: (id) => config.readOnly && !sessions.simulated(id),
  record: audit,
  ledger: databaseLedger(),
  policyValues,
});

const sampler = new Sampler(registry);
sampler.start();

/** Every change of an on/off or an enum, as the server's sessions report it. */
const changeLog = new ChangeLog(bus, (id) => {
  const record = catalog.active(id);
  return record ? sessions.description(record) : null;
});
changeLog.start();

/** Automations: decided here, acted on only through the gateway. */
/** What the installed packages bring to automations: their recipes and functions. None of the core's own. */
const library = new AutomationLibrary(types.contributions());
const automations = new AutomationStore();
const engine = new AutomationEngine({
  store: automations,
  library,
  device: serverDevices(catalog, sessions),
  gateway,
  record: audit,
  bus,
});
// Its triggers' state and its runs are in the database: a restart continues them, and ends as interrupted a run it cut short.
engine.start();

/** The web container, the one proxy whose "home-network entrance" stamp is believed. */
const proxies = new ProxyDirectory(config.trustedProxies);
proxies.start();

/*
  The configuration kept beside the database (docs/CONFIG.md): written now,
  and again after every change to it, so a database set aside for a new
  schema leaves a home to restore.
*/
const snapshot = new ConfigSnapshot({ catalog, connections, links, automations, types, protocols });
/*
  A database started afresh this run — a new schema set the old one aside —
  is restored from the configuration kept beside it, before anything is
  written over that. A restore with problems leaves the kept file as it is
  until something changes; it is copied aside first in any case.
*/
let restoring = true;
if (startedFresh().fresh && existsSync(snapshot.path)) {
  const { checked } = plans({ catalog, sessions, library, engine, automations });
  const restored = await restoreFrom({ catalog, connections, links, automations, types, protocols, sessions, transports, library, engine, checked }, snapshot.path);
  snapshot.restored = restored;
  if (restored) {
    console.log(`[config] Restored from the configuration kept beside the database: ${restored.applied ? `${restored.applied.devices.added.length} devices, ${restored.applied.automations.added.length} automations` : 'nothing'}${restored.problems.length ? `; ${restored.problems.length} problems: ${restored.problems.join('; ')}` : ''}`);
    restoring = !restored.applied;
  }
}
snapshot.start();
try {
  if (!restoring || !startedFresh().fresh) snapshot.write();
} catch (error) {
  console.warn(`[config] The configuration could not be kept beside the database: ${(error as Error).message}`);
}

/*
  What the people using kraftverk are looking at, said by their apps — and
  what follows from it: a device someone looks at is read more often.
*/
const attention = new Attention();
const stopFreshness = keepWatchedFresh(attention, (device, until) => sessions.get(device)?.wantFresh?.(until));

const { app, websocket } = createApp({
  attention,
  snapshot,
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
  remote,
  gateway,
  events,
  bus,
  automations,
  engine,
  library,
  sampler,
  proxies,
  serverLog,
  startedAt,
});

// Everything is running: from here on, stopping also closes what was opened.
onStop(
  stopFreshness,
  () => snapshot.stop(),
  () => engine.stop(),
  () => sampler.stop(),
  () => changeLog.stop(),
  () => setup.stop(),
  () => nearby.stop(),
  () => sessions.closeAll(),
  () => transports.stopAll()
);

const saved = catalog.list().length;
console.log(
  `kraftverk API listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} ` +
    `(${transports.definitions().filter((definition) => transports.get(definition.id)).map((definition) => definition.id).join(' + ') || 'no transports running'}, ` +
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
export default { port: config.port, hostname: config.host, fetch: app.fetch, websocket, idleTimeout: 120 };
