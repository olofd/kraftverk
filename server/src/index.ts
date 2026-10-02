import { changesConfiguration, createHub, DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '@kraftverk/hub';

import { createApp } from './app.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { loadConfig } from './config.ts';
import { keepConsole } from './log.ts';
import { audit, auditLog, closeDb, db, onAudit, startedFresh, transportStore } from './platform/database.ts';
import { scopedHttp } from './platform/http.ts';
import { discoverDeviceTypes, discoverProtocols, discoverTransports } from './platform/packages.ts';
import { serverSealing } from './platform/sealing.ts';
import { serverSecrets } from './platform/secrets.ts';
import { ConfigSnapshot } from './platform/snapshot.ts';

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
await discoverProtocols(protocols);

const transports = new TransportHost({
  platform: 'server',
  context: {
    env: config.env,
    log: (level, message) => console[level === 'info' ? 'log' : level](message),
    audit: (entry) => audit({ at: new Date().toISOString(), ...entry }),
  },
  store: transportStore,
});
await discoverTransports(transports);

const types = new DeviceTypeRegistry();
await discoverDeviceTypes(types);
types.checkConnections({ protocol: (id) => protocols.get(id), transport: (id) => transports.definition(id) });

console.log(
  `[devices] Installed: ${types.all().map((type) => type.id).join(', ') || 'no device types'}; ` +
    `protocols ${protocols.all().map((protocol) => protocol.id).join(', ') || 'none'}; ` +
    `transports ${transports.definitions().map((definition) => definition.id).join(', ') || 'none'}`
);

/*
  The home: its stores over the server's database, a session for every
  device it holds, the gateway, the engine, history, setup, what is near,
  attention and its configuration — all of it the hub's (@kraftverk/hub),
  handed what only the server can give it.
*/
const hub = createHub({
  database: db(),
  audit: auditLog(),
  secrets: serverSecrets,
  sealing: serverSealing,
  installed: { types, protocols, transports },
  readOnly: () => config.readOnly,
  allowRawFrames: config.allowRawFrames,
  http: scopedHttp,
  owner: 'server',
});

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

/*
  Every installed transport an installed device type uses starts now, before
  any session: finding a device has to work before there is one to open. MQTT
  attaches to the broker that is already running — its devices have been
  connected to it all along — or starts one. One that cannot run here,
  Bluetooth in a container, is reported and left out. Then a session for
  every device, sampling, and the engine, whose triggers' state and runs are
  in the database: a restart continues them, and ends as interrupted a run it
  cut short.
*/
await hub.start();

/** The web container, the one proxy whose "home-network entrance" stamp is believed. */
const proxies = new ProxyDirectory(config.trustedProxies);
proxies.start();

/*
  The configuration kept beside the database (docs/CONFIG.md): written now,
  and again after every change to it, so a database set aside for a new
  schema leaves a home to restore.
*/
const snapshot = new ConfigSnapshot(hub.configuration);
/*
  A database started afresh this run — a new schema set the old one aside —
  is restored from the configuration kept beside it, before anything is
  written over that. A restore with problems leaves the kept file as it is
  until something changes; it is copied aside first in any case.
*/
let restoring = true;
if (startedFresh().fresh) {
  const restored = await snapshot.restore();
  if (restored) {
    console.log(`[config] Restored from the configuration kept beside the database: ${restored.applied ? `${restored.applied.devices.added.length} devices, ${restored.applied.automations.added.length} automations` : 'nothing'}${restored.problems.length ? `; ${restored.problems.length} problems: ${restored.problems.join('; ')}` : ''}`);
    restoring = !restored.applied;
  }
}
// Each change to the configuration writes it again, a moment later.
const stopSnapshot = onAudit((entry) => {
  if (changesConfiguration(entry.kind)) snapshot.schedule();
});
try {
  if (!restoring || !startedFresh().fresh) await snapshot.write();
} catch (error) {
  console.warn(`[config] The configuration could not be kept beside the database: ${(error as Error).message}`);
}

const { app, websocket } = createApp({ hub, snapshot, config, proxies, serverLog, startedAt });

// Everything is running: from here on, stopping also closes what was opened.
onStop(stopSnapshot, () => snapshot.stop(), () => hub.stop());

const saved = hub.catalog.list().length;
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
