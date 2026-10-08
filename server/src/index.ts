import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { scaledClock } from '@kraftverk/device-sdk';
import { changesConfiguration, createHub, passphraseSealing, TransportHost } from '@kraftverk/hub';

import { AuditLog, transportStore } from '@kraftverk/store';

import { createApp } from './app.ts';
import { Accounts } from './auth/accounts.ts';
import { keepLoginsPeople } from './auth/family.ts';
import { ProxyDirectory } from './auth/trust.ts';
import { besideDatabase, loadConfig } from './config.ts';
import { keepConsole } from './log.ts';
import { openDatabase, openNodeDatabase } from './platform/database.ts';
import { scopedHttp } from './platform/http.ts';
import { MapRegions } from './platform/map/regions.ts';
import { TileStore } from './platform/map/tiles.ts';
import { installedFromDisk } from './platform/packages.ts';
import { thisNode } from './platform/node.ts';
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
  The database, opened once — a new one when it was made by another schema,
  the old one set aside — and its timeline: handed to everything below that
  keeps or records anything.
*/
const { database, fresh } = openDatabase(config.databaseFile);
const audit = new AuditLog(database);
// Who may sign in here: the node's own, beside the family's, and never reset with it.
const nodeDatabase = openNodeDatabase(besideDatabase(config, 'node.db')).database;

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
        database.close();
        nodeDatabase.close();
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

/** What is installed, found on disk: the transports this host starts, the protocols and the device types. */
const transports = new TransportHost({
  platform: 'system',
  context: {
    env: config.env,
    log: (level, message) => console[level === 'info' ? 'log' : level](message),
    audit: (entry) => audit.record({ at: new Date().toISOString(), ...entry }),
  },
  store: (id) => transportStore(database, id),
});
const installed = await installedFromDisk(transports);

/*
  The home: its stores over the server's database, a session for every
  device it holds, the gateway, the engine, history, setup, what is near,
  attention and its configuration — all of it the hub's (@kraftverk/hub),
  handed what only the server can give it.
*/
const hub = createHub({
  database,
  audit,
  secrets: serverSecrets(config.secretKey),
  sealing: passphraseSealing,
  installed,
  readOnly: () => config.readOnly,
  readOnlyReason: 'The server is in read-only mode',
  allowRawFrames: config.allowRawFrames,
  // Real time — or, for a test of simulated devices on a read-only server, faster: the hub refuses it otherwise.
  clock: scaledClock(config.clockRate),
  http: scopedHttp,
  node: thisNode(database, besideDatabase(config, 'node-id')),
});
if (config.clockRate > 1) console.log(`CLOCK: the home's time runs ${config.clockRate} times real time.`);

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
// Every login's person in the family: one a family started again from its kept file no longer has — or one the console added — is made again.
const accounts = new Accounts(nodeDatabase);
keepLoginsPeople(hub, accounts);

/** The web container, the one proxy whose "home-network entrance" stamp is believed. */
const proxies = new ProxyDirectory(config.trustedProxies);
proxies.start();

/*
  The configuration kept beside the database (docs/CONFIG.md): a database
  started afresh is restored from it, and it is written again after every
  change, so a database set aside for a new schema leaves a home to restore.
*/
const snapshot = new ConfigSnapshot(hub.configuration, besideDatabase(config, 'config', 'kraftverk.yaml'));

/*
  The map (docs/PLAN-MAPS.md): the world fetched at the first start, regions
  downloaded when asked, and detail fetched as someone looks — all in the
  data folder beside the database, served under /api/map.
*/
const mapDir = besideDatabase(config, 'map');
mkdirSync(mapDir, { recursive: true });
let regions: MapRegions | null = null;
const tiles = new TileStore(join(mapDir, 'cache.db'), () => regions?.buildUrl() ?? null);
regions = new MapRegions({ dir: mapDir, tool: config.pmtiles, tiles });
void regions.start().catch((error: unknown) => console.warn(`[map] not started: ${(error as Error).message}`));
await snapshot.begin(fresh);
const stopSnapshot = audit.onRecord((entry) => {
  if (changesConfiguration(entry.kind)) snapshot.schedule();
});

const { app, websocket } = createApp({ hub, accounts, snapshot, config, proxies, serverLog, startedAt, map: { tiles, regions } });

// Everything is running: from here on, stopping also closes what was opened.
onStop(stopSnapshot, () => snapshot.stop(), () => hub.stop(), () => tiles.close());

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
