import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';

import { isActuator, validateConfig as validatePluginConfig } from '@kraftverk/plugin-sdk';

import pkg from '../package.json' with { type: 'json' };
import { ActionGateway, CONFIRMATION_PHRASE } from './actions/gateway.ts';
import { ConnectionManager, type LinkKind, type StationSession } from './connections/manager.ts';
import { DeviceCatalog, STATION_MODELS } from './devices/catalog.ts';
import { LegacyStationImport } from './devices/legacy.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { appState, audit, recentAudit, secretsAreEncrypted, setAppState } from './history/db.ts';
import { Sampler, series } from './history/sampler.ts';
import { PluginHost, type PluginInstance } from './plugins/host.ts';
import { DeviceDriver, ReadOnlyError } from './drivers/device.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import { describeMessage, DeviceBroker } from './mqtt/broker.ts';
import { BleHost, BleLink } from './transport/ble.ts';
import { MqttHost } from './transport/mqtt.ts';
import {
  describeRegisters,
  fromHex,
  parseFrame,
  toHex,
  UnsafeWriteError,
  type RegisterDump,
} from '@kraftverk/protocol';
import { PortIdSchema, PortPatchSchema, StationSettingsPatchSchema, type VersionInfo } from './types.ts';

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? '0.0.0.0';
const MQTT_PORT = Number(process.env.MQTT_PORT ?? 1883);
const MQTT_HOST = process.env.MQTT_HOST ?? '0.0.0.0';
/**
 * STATION_DRIVER:
 *   sim    - built-in simulator (default)
 *   device - real hardware over WiFi/MQTT
 *   ble    - real hardware over Bluetooth LE
 */
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const DRIVER = flag('driver') ?? process.env.STATION_DRIVER ?? 'sim';
/** Block every write. Use when bringing up an unfamiliar station. */
const READ_ONLY = process.argv.includes('--read-only') || process.env.READ_ONLY === '1';
/** Skip the device picker and bind this id (MQTT MAC or BLE peripheral id). */
const DEVICE_ID = flag('device') ?? process.env.DEVICE_ID ?? process.env.DEVICE_MAC;
/** Bind the first station discovered instead of waiting for a choice. */
const AUTO_BIND = process.env.AUTO_BIND !== '0';

/**
 * Which saved station the grid relay feeds.
 *
 * Stored, not derived. A rule like "the only station" is a fact that stops
 * being true the moment a second one is added, and what it decides here is
 * whether cutting mains is verified against the right machine.
 */
const RELAY_STATION_KEY = 'gridRelay.stationDeviceId';

const startedAt = new Date();

const broker = new DeviceBroker();

/**
 * What this process can reach, and what it is reaching right now.
 *
 * The link kind is a launch decision — the simulator, WiFi/MQTT or Bluetooth —
 * but *whose* link it is belongs to a saved device. The catalog says what you
 * own; the connection manager opens one session per saved station and is the
 * only thing that knows about live drivers and transports. No route reaches a
 * global `driver` any more: it asks for a device's session, and gets nothing
 * when that device has none.
 */
const LINK: LinkKind = DRIVER === 'ble' ? 'ble' : DRIVER === 'device' ? 'mqtt' : 'sim';

const catalog = new DeviceCatalog();

const connections = new ConnectionManager({
  kind: LINK,
  readOnly: READ_ONLY,
  autoBind: AUTO_BIND,
  host: () => (LINK === 'ble' ? new BleHost() : new MqttHost(broker, MQTT_PORT, MQTT_HOST)),
  simulator: () => new SimulatorDriver(),
  /*
    Where a device is reached is a property of that device. The old code kept it
    in `data/binding.json`, one per server, which is exactly why a second
    station could not be represented — so the answer is written back onto the
    record instead.
  */
  onBound: (deviceId, kind, boundId) => {
    catalog.update(deviceId, { config: { transport: kind, boundId } });
  },
  log: (message) => console.log(`[link] ${message}`),
});

const host = new PluginHost();
await host.discover();
await host.startEnabled();

const registry = new DeviceRegistry(catalog, host, connections);

if (LINK !== 'sim') {
  try {
    // Started before any session, because discovery has to work before there is
    // a device to bind: you cannot choose the station you have not found yet.
    await connections.link();
  } catch (error) {
    console.error(`Could not start the ${LINK} transport:`, error);
    throw error;
  }

  if (LINK === 'ble') {
    console.log('Scanning for Bluetooth stations…');
  } else {
    console.log(`MQTT broker listening on ${MQTT_HOST}:${MQTT_PORT}`);
    console.log('Point mqtt.sydpower.com at this machine so the station connects here.');
  }

  if (READ_ONLY) {
    console.log('READ-ONLY: every write will be refused. Nothing can change on the station.');
  }
}

/*
  Nothing is adopted at startup. Sessions are opened for the stations already in
  the catalog, and for nothing else — a blank installation opens no links at all.
*/
await connections.sync(catalog.list());

if (DEVICE_ID) {
  /*
    `--device=` names a *station*, so it also has to name the saved device that
    should hold it. `--for=` is that; without it the flag can only be honoured
    when there is exactly one saved station, and rather than quietly picking one
    it says what it did and why.
  */
  const forDevice = flag('for') ?? process.env.DEVICE_FOR;
  const stations = connections.sessions.filter((session) => session.kind !== 'sim');
  const target = forDevice ?? (stations.length === 1 ? stations[0]!.deviceId : null);

  if (!target) {
    console.log(
      stations.length === 0
        ? `[link] --device=${DEVICE_ID} ignored: no station has been added yet`
        : `[link] --device=${DEVICE_ID} ignored: ${stations.length} stations are saved. ` +
            `Add --for=<saved device id> to say which one should hold it.`
    );
  } else {
    await connections.bind(target, DEVICE_ID).catch((error: unknown) => {
      console.log(`[link] --device=${DEVICE_ID} could not be bound: ${(error as Error).message}`);
    });
  }
}

/**
 * The saved station a request names, or a 404.
 *
 * There is no inference here, deliberately — not even "when there is only one".
 * A route that guesses correctly while you own one device is a route that
 * guesses *wrongly* the day you own two, and it does so silently, having worked
 * fine for months. Every caller says which device it means.
 */
function stationSession(deviceId: string | undefined): StationSession {
  if (!deviceId) {
    throw new HTTPException(400, { message: 'Name the device with deviceId' });
  }

  const session = connections.get(decodeURIComponent(deviceId));
  if (!session) {
    throw new HTTPException(404, { message: 'No such device, or it has no open session' });
  }
  return session;
}

/** Register-level access, which only real hardware has. Always by device id. */
function hardwareOr400(c: Context): DeviceDriver {
  const session = stationSession(c.req.query('deviceId'));
  if (!session.device) {
    throw new HTTPException(400, {
      message: 'That device has no hardware link (STATION_DRIVER=device or ble)',
    });
  }
  return session.device;
}

const app = new Hono();

// The client polls /status; logging it would drown out everything useful.
app.use('*', async (c, next) => (c.req.path === '/api/status' ? next() : logger()(c, next)));

/**
 * Which browsers may talk to this server.
 *
 * It used to reflect whatever origin asked. That is the same as no policy at
 * all: this server has no authentication, it is on the user's LAN, and one of
 * its routes switches mains power — so any page in any tab could have listed
 * the devices and thrown the relay, because the browser was being told the
 * answer was fine to read.
 *
 * Loopback and private ranges are allowed because that is where this app
 * legitimately runs: Metro on `localhost:8081`, and the same app opened from a
 * phone on the house network. Anything else has to be named in
 * `ALLOWED_ORIGINS`, which is the escape hatch for a real deployment rather
 * than a hole left open by default.
 *
 * Requests with no `Origin` at all — curl, the native app — are not CORS
 * requests and are unaffected.
 */
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/;

const allowOrigin = (origin: string): string | null => {
  if (EXTRA_ORIGINS.includes(origin) || EXTRA_ORIGINS.includes('*')) return origin;
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname) ? origin : null;
  } catch {
    return null; // not a URL we can reason about, so not one we trust
  }
};

app.use(
  '/api/*',
  cors({
    origin: (origin) => allowOrigin(origin),
    // DELETE was missing, and it is the method behind "Forget this device".
    // The preflight said GET,POST,PATCH,OPTIONS, so every browser blocked the
    // request — and the app, which never caught the failure, showed nothing.
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  })
);

/**
 * Parses and validates a JSON body.
 *
 * Deliberately not @hono/zod-validator: that package hoists to the workspace
 * root where it binds to the zod v3 an Expo dependency pulls in, while this
 * package is on zod v4. Validating inline keeps one zod and full type inference.
 */
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  });
  return schema.parse(raw);
}

const api = new Hono();

api.get('/health', (c) => c.json({ ok: true }));

api.get('/version', (c) => {
  const info: VersionInfo = {
    name: pkg.name,
    version: pkg.version,
    runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.versions.node}`,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    // A launch decision, not a property of whichever session opened first.
    link: LINK === 'sim' ? 'simulator' : 'device',
    transport: connections.transport?.kind,
    readOnly: connections.readOnly,
  };
  return c.json(info);
});

/*
  `/status`, `/settings`, `/ports/:id` and `/simulator/grid` were here.

  They resolved "the station" — the first open session — which is a question
  with no correct answer once a server can hold several. Nothing in the app
  called them; the device-scoped `/api/devices/:id/...` routes replaced them.
  Keeping them would have meant keeping a way to read and *write* a station
  nobody named.

  The simulator's grid toggle went with them and returns under a device id when
  something needs it again.
*/

// --- station transports ---------------------------------------------------
//
// Which stations the current transport can see, and which one we are bound to.
// This used to be `/api/devices`; that name now belongs to the unified device
// list, because "device" should mean "a thing you own", not "a station this
// particular radio noticed".

api.get('/station/transports', (c) => {
  const host = connections.transport;
  const linked = host?.openIds() ?? [];

  /*
    `boundId` and `connected` used to be here, describing "the" session — which
    meant the first one. A screen that renders them is a screen that shows one
    station's state under a heading that implies it is the only one. `links` is
    the whole answer: one entry per saved station, each naming its device.
  */
  return c.json({
    transport: host?.kind ?? null,
    autoBind: AUTO_BIND,
    lastError: host instanceof BleHost ? host.lastError : null,
    attempts: host instanceof BleHost ? host.attempts : null,
    links: connections.sessions
      .filter((session) => session.kind !== 'sim')
      .map((session) => ({
        deviceId: session.deviceId,
        name: catalog.get(session.deviceId)?.name ?? session.deviceId,
        stationId: session.link?.boundId ?? null,
        connected: session.link?.connected ?? false,
        refusal: connections.refusal(session.deviceId),
      })),
    devices: (host?.discovered() ?? []).map((d) => ({ ...d, bound: linked.includes(d.id) })),
  });
});

/**
 * Binds a saved device to a station.
 *
 * The choice goes to the device's own record, so a restart reconnects *that*
 * device rather than whatever a shared file last said. `deviceId` is optional
 * only for the single-station case the Station link screen still assumes; with
 * more than one saved station it is required, because "the station" has stopped
 * being a thing the server can guess.
 *
 * Binding with nothing saved at all is no longer possible. It used to bind the
 * one transport transiently, which meant something when the transport *was* the
 * link; now a link belongs to a saved device, and a link nothing polls would be
 * a connection held for no reason — while taking the station away from the app.
 */
/** Which saved device a bind acts on. Named, never inferred. */
const bindTarget = (deviceId: string | undefined): string => stationSession(deviceId).deviceId;

api.post('/station/bind', async (c) => {
  const host = await connections.link();
  if (!host) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  const { id, deviceId } = await body(
    c,
    z.object({ id: z.string().min(1), deviceId: z.string().optional() })
  );

  const target = bindTarget(deviceId);
  await connections.bind(target, id);
  const session = connections.get(target);

  return c.json({
    deviceId: target,
    boundId: session?.link?.boundId ?? null,
    connected: session?.link?.connected ?? false,
  });
});

api.post('/station/unbind', async (c) => {
  const host = await connections.link();
  if (!host) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  const { deviceId } = await body(c, z.object({ deviceId: z.string().optional() }).catch({}));

  const target = bindTarget(deviceId);
  await connections.unbind(target);

  return c.json({ deviceId: target, boundId: null, connected: false });
});

// --- diagnostics ----------------------------------------------------------
//
// These exist to confirm the register map against real hardware. The published
// map came from FOSSiBOT F2400/F3600 units; the P280 is the same stack but a
// different machine, so verify before trusting a value.

const diag = new Hono();

diag.get('/link', (c) => {
  const host = connections.transport;
  const linked = host?.openIds() ?? [];

  return c.json({
    driver: LINK === 'sim' ? 'simulator' : 'device',
    transport: host?.kind ?? null,
    brokerListening: broker.listening,
    mqtt: { host: MQTT_HOST, port: MQTT_PORT },
    devices: (host?.discovered() ?? []).map((d) => ({ ...d, bound: linked.includes(d.id) })),
    // Which stations are held, and by whom. No "the" station: that word was
    // what let a diagnostic describe one machine while implying all of them.
    linkedStations: connections.sessions
      .filter((session) => session.link)
      .map((session) => ({ deviceId: session.deviceId, stationId: session.link!.boundId })),
    configuredId: DEVICE_ID ?? null,
  });
});

diag.get('/traffic', (c) => c.json(broker.recentMessages.map(describeMessage)));

/** What the BLE GATT enumeration actually returned on the last connect. */
diag.get('/gatt', (c) => {
  const host = connections.transport;
  return c.json(
    host instanceof BleHost
      ? {
          lastError: host.lastError,
          attempts: host.attempts,
          discovery: host.lastDiscovery,
          // Per station, now that there can be several. The three above are the
          // most recent across all of them, which is what this route used to
          // mean when "all of them" was one.
          links: connections.sessions
            .filter((session) => session.link instanceof BleLink)
            .map((session) => {
              const link = session.link as BleLink;
              return {
                deviceId: session.deviceId,
                stationId: link.boundId,
                connected: link.connected,
                lastError: link.lastError,
                attempts: link.attempts,
                discovery: link.lastDiscovery,
              };
            }),
        }
      : { error: 'Not on the BLE transport' }
  );
});

/**
 * Baseline for the register diff.
 *
 * Snapshot, change one thing on the station (or in BrightEMS), then read again:
 * whatever moved is the register behind that control. This is how the map gets
 * confirmed on hardware it was not derived from.
 */
type Baseline = { at: string; input: number[]; holding: number[] };

/**
 * Overridable for the same reason `KRAFTVERK_DB` is: in a container the source
 * tree is a read-only image layer, and a baseline written there would vanish on
 * the next restart — silently, halfway through the one workflow whose whole
 * point is comparing against something taken earlier.
 */
const BASELINE_FILE =
  process.env.KRAFTVERK_BASELINE_FILE || resolve(import.meta.dirname, '../data/baseline.json');

/**
 * Persisted, because the server restarts constantly during protocol work —
 * `--hot` reloads on every edit — and losing the baseline mid-experiment throws
 * away the comparison you were in the middle of making.
 */
let baseline: Baseline | null = await readFile(BASELINE_FILE, 'utf8')
  .then((raw) => JSON.parse(raw) as Baseline)
  .catch(() => null);

diag.post('/snapshot', async (c) => {
  const device = hardwareOr400(c);
  const [input, holding] = await Promise.all([device.readAllInput(), device.readAllHolding()]);
  baseline = { at: new Date().toISOString(), input, holding };
  await mkdir(dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(baseline), 'utf8');
  return c.json({ at: baseline.at, input: input.length, holding: holding.length });
});

/** Writes this station refused while read-only. Its own, not somebody else's. */
diag.get('/blocked', (c) => c.json(hardwareOr400(c).blockedWrites));

/**
 * Read an arbitrary register range, and show it decoded as ASCII too.
 *
 * Strings the station stores — a WiFi SSID, say — would be packed two
 * characters per register and are invisible in a numeric dump. Reads only, so
 * probing outside the documented window cannot change anything.
 */
diag.get('/scan', async (c) => {
  const device = hardwareOr400(c);

  const { fn, start, count } = z
    .object({
      fn: z.coerce.number().int().refine((v) => v === 3 || v === 4, 'fn must be 3 or 4'),
      start: z.coerce.number().int().min(0).max(65535),
      count: z.coerce.number().int().min(1).max(125),
    })
    .parse({
      fn: c.req.query('fn') ?? 3,
      start: c.req.query('start') ?? 0,
      count: c.req.query('count') ?? 40,
    });

  const values = await device.readRange(fn as 3 | 4, start, count).catch(() => [] as number[]);

  /** Two bytes per register, printable ASCII only. */
  const ascii = values
    .map((v) => {
      const hi = (v >> 8) & 0xff;
      const lo = v & 0xff;
      const ch = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
      return ch(hi) + ch(lo);
    })
    .join('');

  return c.json({
    fn,
    start,
    count,
    ok: values.length > 0,
    values: values.map((raw, i) => ({
      register: start + i,
      raw,
      hex: raw.toString(16).padStart(4, '0'),
    })),
    ascii,
  });
});

/** Every input register, raw and decoded, with the documented name where known. */
diag.get('/registers', async (c) => {
  const device = hardwareOr400(c);
  const [input, holding] = await Promise.all([
    device.readAllInput().catch(() => [] as number[]),
    device.readAllHolding().catch(() => [] as number[]),
  ]);

  // Shared with the app's own Bluetooth link, so a dump means the same thing
  // however it was taken.
  const dump: RegisterDump = {
    mac: device.mac,
    readOnly: device.readOnly,
    baselineAt: baseline?.at ?? null,
    input: describeRegisters(input, 'input', baseline?.input),
    holding: describeRegisters(holding, 'holding', baseline?.holding),
  };

  return c.json(dump);
});

/**
 * Escape hatch for protocol work: send an arbitrary frame.
 *
 * Deliberately gated behind ALLOW_RAW_MODBUS because writing an undocumented
 * register can permanently damage the station.
 */
diag.post('/raw', async (c) => {
  if (process.env.ALLOW_RAW_MODBUS !== '1') {
    throw new HTTPException(403, {
      message: 'Set ALLOW_RAW_MODBUS=1 to enable raw frames. Bad writes can brick the device.',
    });
  }
  const { hex, deviceId } = await body(
    c,
    z.object({ hex: z.string().regex(/^[0-9a-fA-F]+$/), deviceId: z.string().optional() })
  );

  // A raw frame goes down one station's link, so it has to name one. With a
  // single station it is still inferred; with several, guessing which unit
  // receives an undocumented write is exactly the wrong thing to do.
  const link = connections.get(bindTarget(deviceId))?.link;
  if (!link?.boundId) throw new HTTPException(400, { message: 'No station bound' });

  const frame = fromHex(hex);
  await link.send(frame);
  return c.json({
    sent: toHex(frame),
    to: link.boundId,
    parsedAsRequest: parseFrame(frame),
  });
});

// --- extensions -----------------------------------------------------------
//
// Plugins provide signals and offer capabilities; they never actuate. Every
// relay command goes through the action gateway, which checks the grant, the
// policy and the freshness of the data, then proves the physical effect
// happened. See docs/PLUGIN-ARCHITECTURE.md.

const gateway = new ActionGateway({
  host,
  /*
    Which station the relay is proved against — by recorded id, never by
    whichever session happens to be open.

    The gateway's second proof is *the* station's AC input agreeing that mains
    came or went. Read from the wrong station it proves nothing, and would
    happily report `verified` because some other station has power while the one
    this plug feeds sat dark. So the pairing is a stored `SavedDeviceId`
    (`RELAY_STATION_KEY`), and if the station it names is gone or has no
    session, the answer is "I cannot verify" rather than a substitute.
  */
  readStation: () => {
    const deviceId = appState(RELAY_STATION_KEY);
    if (!deviceId) {
      return {
        status: null,
        reason:
          'No station is paired with the grid relay, so switching it cannot be verified. ' +
          'Pair one with POST /api/grid/station.',
      };
    }

    const session = connections.get(deviceId);
    if (!session) {
      return {
        status: null,
        reason: `The station paired with the relay (${deviceId}) has no open session.`,
      };
    }
    return { status: session.driver.status() };
  },
  isReadOnly: () => connections.readOnly,
});

const plugins = new Hono();

const describePlugin = (instance: PluginInstance) => {
  const health = host.health(instance.manifest.id);
  return {
    id: instance.manifest.id,
    name: instance.manifest.name,
    description: instance.manifest.description,
    version: instance.manifest.version,
    kind: instance.manifest.kind,
    icon: instance.manifest.ui.icon,
    capabilities: instance.manifest.capabilities,
    setupActions: instance.manifest.setupActions ?? [],
    /*
      Lifecycle and liveness are different questions — a plugin can have started
      cleanly and still be unable to reach its device. Report the liveness one,
      because "healthy" beside a failed health check is exactly the green light
      over stale data the brief warns about.
    */
    status: instance.status === 'healthy' ? health.status : instance.status,
    enabled: host.enabled(instance.manifest.id),
    health,
    grants: host.grants(instance.manifest.id),
    error: instance.error ?? health.detail ?? null,
  };
};

plugins.get('/', (c) =>
  c.json({
    secretsEncrypted: secretsAreEncrypted(),
    activeProviders: { gridRelay: host.activeProvider('gridRelay') },
    plugins: host.all.map(describePlugin),
  })
);

plugins.get('/:id/config', (c) => {
  const instance = host.instance(c.req.param('id'));
  if (!instance) throw new HTTPException(404, { message: 'No such plugin' });

  return c.json({
    id: instance.manifest.id,
    schema: instance.manifest.configSchema,
    // Secrets are never returned — only whether each one has been set.
    values: host.configOf(instance.manifest.id),
    secretsSet: host.secretsSet(instance.manifest.id),
    enabled: host.enabled(instance.manifest.id),
  });
});

plugins.patch('/:id/config', async (c) => {
  const id = c.req.param('id');
  if (!host.instance(id)) throw new HTTPException(404, { message: 'No such plugin' });

  await host.setConfig(id, await body(c, z.record(z.string(), z.unknown())));
  if (host.enabled(id)) await host.restart(id);

  return c.json({ ok: true, status: host.instance(id)?.status, health: host.health(id) });
});

plugins.post('/:id/enable', async (c) => {
  const id = c.req.param('id');
  // Every sibling route checks this; this one did not, so enabling a plugin
  // that is not installed answered 500 rather than "no such plugin".
  if (!host.instance(id)) throw new HTTPException(404, { message: 'No such plugin' });

  const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
  await host.setEnabled(id, enabled);
  return c.json({ ok: true, status: host.instance(id)?.status, health: host.health(id) });
});

/** Side-effect-free probe. For the Tuya plugin this dumps every datapoint. */
plugins.post('/:id/test', async (c) => {
  const instance = host.instance(c.req.param('id'));
  if (!instance) throw new HTTPException(404, { message: 'No such plugin' });
  if (!instance.plugin.test) return c.json({ ok: false, detail: 'This plugin offers no test' });

  return c.json(await instance.plugin.test());
});

/**
 * Runs a commissioning helper the plugin declared in its manifest.
 *
 * Generic on purpose: this route knows nothing about Tuya, or about what the
 * action does. It validates the input against the schema the plugin published,
 * runs it with a timeout, and hands back the result — so a weather plugin's
 * "find my location" works through the identical path and the identical screen.
 *
 * Runs on a stopped plugin: getting to a working configuration is the point.
 */
plugins.post('/:id/setup/:action', async (c) => {
  const instance = host.instance(c.req.param('id'));
  if (!instance) throw new HTTPException(404, { message: 'No such plugin' });

  const actionId = c.req.param('action');
  const action = instance.manifest.setupActions?.find((candidate) => candidate.id === actionId);
  if (!action || !instance.plugin.runSetupAction) {
    throw new HTTPException(404, { message: `No setup action "${actionId}"` });
  }

  const input = await body(c, z.record(z.string(), z.unknown()));
  if (action.input) {
    const validated = validatePluginConfig(action.input, input);
    if (!validated.ok) {
      return c.json({ ok: false, detail: validated.issues.map((i) => i.message).join('; ') }, 400);
    }
  }

  // A network scan legitimately takes tens of seconds; a hung cloud call must
  // not take the route with it.
  const result = await Promise.race([
    instance.plugin.runSetupAction(actionId, input as Record<string, string | number | boolean>),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The setup action timed out')), 90_000)
    ),
  ]).catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  }));

  return c.json(result);
});

plugins.post('/:id/grants', async (c) => {
  const id = c.req.param('id');
  const instance = host.instance(id);
  if (!instance) throw new HTTPException(404, { message: 'No such plugin' });

  const { capability, granted, confirmation } = await body(
    c,
    z.object({
      capability: z.string(),
      granted: z.boolean(),
      confirmation: z.string().optional(),
    })
  );

  const name = capability as (typeof instance.manifest.capabilities)[number];
  if (!instance.manifest.capabilities.includes(name)) {
    throw new HTTPException(400, { message: `${id} does not offer ${capability}` });
  }
  // Granting something that can move a physical switch is a two-step act.
  if (granted && isActuator(name) && confirmation !== CONFIRMATION_PHRASE) {
    throw new HTTPException(400, {
      message: `Granting ${capability} controls mains power and needs confirmation`,
    });
  }

  host.setGrant(id, name, granted);
  return c.json({ ok: true, grants: host.grants(id) });
});

plugins.post('/:id/provider', async (c) => {
  const id = c.req.param('id');
  if (!host.instance(id)) throw new HTTPException(404, { message: 'No such plugin' });
  host.setActiveProvider('gridRelay', id);
  return c.json({ ok: true, activeProvider: host.activeProvider('gridRelay') });
});

api.route('/plugins', plugins);

// --- the grid relay -------------------------------------------------------

api.get('/grid', async (c) => {
  const state = await gateway.state();
  // `app_state` stores '' for "cleared"; the API should say null.
  const stationId = appState(RELAY_STATION_KEY) || null;
  return c.json({
    provider: host.activeProvider('gridRelay'),
    granted: (() => {
      const id = host.activeProvider('gridRelay');
      return id ? host.isGranted(id, 'gridRelay.switch') : false;
    })(),
    /** The station this relay feeds, by saved-device id. Null until paired. */
    stationDeviceId: stationId,
    stationPresent: stationId ? connections.get(stationId) !== null : false,
    state,
  });
});

/**
 * Records which station this relay actually feeds.
 *
 * The pairing is a `SavedDeviceId` on disk rather than a rule evaluated at
 * switch time, because "the only station" is a fact that silently stops being
 * true the day a second one is added — and the thing it decides is whether
 * cutting mains gets verified against the right machine.
 */
api.post('/grid/station', async (c) => {
  const { deviceId } = await body(c, z.object({ deviceId: z.string().min(1).nullable() }));

  if (deviceId === null) {
    setAppState(RELAY_STATION_KEY, '');
    auditDevice('relay.unpaired', '', 'The grid relay is no longer paired with a station');
    return c.json({ stationDeviceId: null });
  }

  const record = catalog.get(deviceId);
  if (!record) throw new HTTPException(404, { message: 'No such device' });
  if (record.type !== 'power-station') {
    throw new HTTPException(400, { message: 'A relay is paired with a power station' });
  }

  setAppState(RELAY_STATION_KEY, record.id);
  auditDevice('relay.paired', record.id, `The grid relay now feeds "${record.name}"`);
  return c.json({ stationDeviceId: record.id });
});

api.post('/grid/relay', async (c) => {
  const { on, reason, confirmation } = await body(
    c,
    z.object({
      on: z.boolean(),
      reason: z.string().min(1).max(200).default('Requested from the app'),
      confirmation: z.string().optional(),
    })
  );

  const result = await gateway.execute({ desired: on, reason, actor: 'user', confirmation });
  return c.json(result, result.outcome === 'refused' ? 409 : 200);
});

api.get('/audit', (c) => {
  // `Number(c.req.query('limit'))` was passed straight to SQL, so `?limit=abc`
  // bound NaN and the route answered 500 "Internal server error" — the one
  // query parameter on the server that was not validated like the rest.
  const { limit } = z
    .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
    .parse({ limit: c.req.query('limit') ?? 100 });

  return c.json(recentAudit(limit));
});

// --- devices --------------------------------------------------------------
//
// One list of the things you own: the station, and whatever the installed
// drivers provide. Described identically, so the app has one card, one detail
// screen and one chart for all of them.

/**
 * Records what happened to the catalog.
 *
 * The audit timeline covered plugins and every physical action, and the legacy
 * import wrote itself down — but adding, renaming and *forgetting* a device
 * wrote nothing at all. Forgetting is the destructive one: it takes the
 * device's entire recorded history with it, in a transaction, with no trace
 * that it ever existed. A device that vanishes with no entry anywhere is a
 * device nobody can account for afterwards, which is exactly the situation this
 * line was written in.
 */
const auditDevice = (kind: string, id: string, summary: string, detail?: unknown) =>
  audit({ at: new Date().toISOString(), kind, actor: 'user', resource: id, summary, detail });

/*
  Nothing is adopted at startup. A device exists because someone added it, and
  a fresh installation is a blank canvas — see docs/DEVICE-FIRST-REFACTOR.md.
  The one exception is offered rather than taken: a station bound before the
  catalog existed can be imported, once, by the user.
*/
const legacyStation = new LegacyStationImport({
  catalog,
  transport: () => connections.transport?.kind ?? null,
  // What the radio calls the station it found, rather than a placeholder.
  stationName: (boundId) =>
    connections.transport?.discovered().find((d) => d.id.toUpperCase() === boundId.toUpperCase())
      ?.name ?? 'Power station',
});

const sampler = new Sampler(registry);
sampler.start();

api.get('/devices', async (c) => c.json({ devices: await registry.all() }));

// --- the legacy station import --------------------------------------------

api.get('/migration/station', async (c) => c.json(await legacyStation.offer()));

api.post('/migration/station/import', async (c) => {
  const { name } = await body(c, z.object({ name: z.string().min(1).max(60).optional() }));
  const record = await legacyStation.accept(name);
  if (!record) throw new HTTPException(409, { message: 'There is no station to import' });

  // The imported station gets its link straight away, as an added one does.
  await connections.sync(catalog.list());
  return c.json(await registry.find(record.id));
});

api.post('/migration/station/dismiss', (c) => {
  legacyStation.dismiss();
  return c.json({ ok: true });
});

/** What can be added, and what each one needs. Drives the add-device wizard. */
api.get('/device-types', (c) =>
  c.json({
    types: [
      {
        id: 'power-station',
        label: 'Power station',
        description: 'A Sydpower-stack station: AFERIY, FOSSiBOT, Eco Play, ABOK.',
        icon: 'zap',
        driver: 'core.station',
        models: STATION_MODELS,
        available: true,
        note: 'The server talks to it over WiFi or Bluetooth.',
      },
      ...host.all
        .filter((instance) => instance.manifest.kind === 'grid-relay')
        .map((instance) => ({
          id: instance.manifest.id,
          label: instance.manifest.name,
          description: instance.manifest.description,
          icon: instance.manifest.ui.icon,
          driver: instance.manifest.id,
          models: [],
          available: true,
          note: instance.manifest.setupActions?.length
            ? 'Finds it on your network and fetches what it needs.'
            : undefined,
        })),
    ],
  })
);

api.post('/devices', async (c) => {
  const input = await body(
    c,
    z.object({
      type: z.enum(['power-station', 'smart-plug']),
      driver: z.string().min(1),
      name: z.string().min(1).max(60),
      model: z.string().nullish(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
  );

  /*
    A second station used to be refused here, because the server held one link
    and a second entry would have been a promise it could not keep. It can keep
    it now: `TransportHost` carries a link per saved station, so adding another
    one is a row, not a conflict.
  */

  const record = catalog.add({
    type: input.type,
    driver: input.driver,
    name: input.name,
    model: input.model ?? null,
    config: input.config,
  });

  auditDevice('device.added', record.id, `Added "${record.name}" (${record.driver})`, {
    type: record.type,
    model: record.model,
  });

  /*
    Pair the relay with the first station added, and record the id.

    This is the one moment the answer is unambiguous, so it is the moment to
    write it down — rather than re-deriving "the only station" at every switch,
    which would quietly become the wrong station the day a second is added. The
    user can repoint it with POST /api/grid/station.
  */
  if (record.type === 'power-station' && !appState(RELAY_STATION_KEY)) {
    setAppState(RELAY_STATION_KEY, record.id);
    auditDevice('relay.paired', record.id, `The grid relay is assumed to feed "${record.name}"`);
  }

  // Adding a station opens its link, rather than waiting for a restart.
  await connections.sync(catalog.list());
  return c.json(await registry.find(record.id));
});

api.get('/devices/:id', async (c) => {
  const found = await registry.find(decodeURIComponent(c.req.param('id')));
  if (!found) throw new HTTPException(404, { message: 'No such device' });
  return c.json(found);
});

api.patch('/devices/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const changes = await body(
    c,
    z.object({
      name: z.string().min(1).max(60).optional(),
      model: z.string().nullish(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
  );

  const before = catalog.get(id);
  const updated = catalog.update(id, changes);
  if (!before || !updated) throw new HTTPException(404, { message: 'No such device' });

  // The rename is worth naming both sides of: "Living room" in a log is useless
  // if you cannot tell what it used to be called.
  if (updated.name !== before.name) {
    auditDevice('device.renamed', id, `Renamed "${before.name}" to "${updated.name}"`);
  }
  if (updated.model !== before.model) {
    auditDevice('device.remodelled', id, `${updated.name} is now a ${updated.model ?? 'unknown model'}`);
  }

  return c.json(await registry.find(id));
});

// --- one P280, by device id -----------------------------------------------
//
// The station's rich telemetry does not fit the generic `Reading[]` shape: the
// energy-flow view needs ports, firmware, link state and a dozen quantities in
// their model's own units. So it is served under the device's namespace, and
// the server checks the device really is a station before answering.
//
// This is what replaced the global `/api/status`: the same data, but for a
// device the caller named, from that device's own session.

/** Resolves a saved station and its live session, or explains which is missing. */
function stationDevice(c: Context): StationSession {
  const id = decodeURIComponent(c.req.param('id') ?? '');
  const record = catalog.get(id);
  if (!record) throw new HTTPException(404, { message: 'No such device' });
  if (record.driver !== 'core.station') {
    throw new HTTPException(400, { message: 'That device is not a power station' });
  }

  const session = connections.get(id);
  if (!session) {
    throw new HTTPException(409, {
      message: connections.refusal(id) ?? 'The server is not holding a link to that device',
    });
  }
  return session;
}

api.get('/devices/:id/p280/state', (c) => {
  const session = stationDevice(c);
  return c.json({
    status: session.driver.status(),
    settings: session.driver.settings(),
    // Facts about *this* connection, which used to be read off a global
    // `/api/version` that described the whole server.
    readOnly: connections.readOnly,
    link: session.kind,
  });
});

api.patch('/devices/:id/p280/settings', async (c) => {
  const session = stationDevice(c);
  // The same schema the global route used, so the register-68 guard and every
  // other bound still stand on the device-scoped path.
  const patch = await body(c, StationSettingsPatchSchema);
  return c.json(await session.driver.applySettings(patch));
});

/**
 * A device's own settings: what it remembers, not how we reach it.
 *
 * The schema comes from the device, so the app renders the P280's charge limit
 * and a future plug's timers through the same code — and a setting that can
 * damage the hardware is marked as such by the device rather than known by the
 * app.
 */
api.get('/devices/:id/settings', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const found = await registry.find(id);
  if (!found) throw new HTTPException(404, { message: 'No such device' });
  if (!found.settings) return c.json({ schema: null, values: {}, dangerous: [] });

  return c.json({
    schema: found.settings.schema,
    dangerous: found.settings.dangerous ?? [],
    values: registry.readSettings(found.record),
  });
});

api.patch('/devices/:id/settings', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const found = await registry.find(id);
  if (!found?.settings) throw new HTTPException(404, { message: 'That device has no settings' });

  const patch = await body(c, z.record(z.string(), z.unknown()));
  const validated = validatePluginConfig(found.settings.schema, {
    ...registry.readSettings(found.record),
    ...patch,
  });
  if (!validated.ok) {
    return c.json({ error: 'Validation failed', issues: validated.issues }, 400);
  }

  // Only what was asked for is sent: applying the full set would rewrite every
  // register on the station to change one of them.
  const values = await registry.writeSettings(
    found.record,
    Object.fromEntries(Object.keys(patch).map((key) => [key, validated.value[key]]))
  );
  return c.json({ values });
});

api.delete('/devices/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const record = catalog.get(id);
  if (!record) throw new HTTPException(404, { message: 'No such device' });

  // Written before the delete, so the entry survives even if the transaction
  // does not — and so the record's own details are still there to describe.
  auditDevice('device.forgotten', id, `Forgot "${record.name}" and everything it had recorded`, {
    type: record.type,
    driver: record.driver,
    model: record.model,
    addedAt: record.addedAt,
  });

  catalog.remove(id);

  // A pairing that points at a device you no longer own is worse than none:
  // the gateway would go looking for a session that can never appear.
  if (appState(RELAY_STATION_KEY) === id) {
    setAppState(RELAY_STATION_KEY, '');
    auditDevice('relay.unpaired', id, 'The station the grid relay fed was forgotten');
  }

  // Forgetting a device closes its link. Leaving a session open for a record
  // that no longer exists is how a deleted device keeps polling the hardware.
  await connections.sync(catalog.list());
  return c.json({ ok: true });
});

/**
 * One measurement over time.
 *
 * Thinned server-side: a fortnight of minute samples is far more points than a
 * phone-sized chart can show, and sending them all would only make the device
 * do arithmetic it cannot display.
 */
api.get('/devices/:id/history', (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  // An unknown device answered 200 with an empty series, which is indis-
  // tinguishable from a device that simply has not recorded anything yet.
  if (!catalog.get(id)) throw new HTTPException(404, { message: 'No such device' });

  const { key, hours, points } = z
    .object({
      key: z.string().min(1),
      hours: z.coerce.number().min(0.5).max(24 * 14).default(24),
      points: z.coerce.number().int().min(20).max(1000).default(240),
    })
    .parse({
      key: c.req.query('key'),
      hours: c.req.query('hours') ?? 24,
      points: c.req.query('points') ?? 240,
    });

  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);

  return c.json({
    deviceId: id,
    key,
    from: from.toISOString(),
    to: to.toISOString(),
    points: series(id, key, from.toISOString(), to.toISOString(), points),
  });
});

/**
 * Invokes a device control.
 *
 * Anything physical goes through the action gateway, so a control on a device
 * screen has exactly the authority a manual switch does — no more.
 */
api.post('/devices/:id/control/:control', async (c) => {
  const deviceId = decodeURIComponent(c.req.param('id'));
  const controlId = c.req.param('control');
  const found = await registry.find(deviceId);
  if (!found) throw new HTTPException(404, { message: 'No such device' });

  const control = found.controls.find((candidate) => candidate.id === controlId);
  if (!control) throw new HTTPException(404, { message: 'No such control' });

  const { value, confirmation } = await body(
    c,
    z.object({ value: z.union([z.boolean(), z.number(), z.string()]), confirmation: z.string().optional() })
  );

  // The station's own ports are core business and keep their existing path —
  // but through *this device's* session, not a global driver.
  if (found.record.driver === 'core.station') {
    const session = connections.get(deviceId);
    if (!session) {
      throw new HTTPException(409, {
        message: connections.refusal(deviceId) ?? 'The server is not holding a link to that device',
      });
    }
    const port = PortIdSchema.parse(controlId);
    return c.json(await session.driver.setPort(port, value === true));
  }

  if (control.capability === 'gridRelay.switch') {
    const result = await gateway.execute({
      desired: value === true,
      reason: `${control.label} switched from the device screen`,
      actor: 'user',
      confirmation,
    });
    return c.json(result, result.outcome === 'refused' ? 409 : 200);
  }

  throw new HTTPException(400, { message: `${control.capability} cannot be invoked yet` });
});

api.route('/diagnostics', diag);
app.route('/api', api);

app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof UnsafeWriteError) return c.json({ error: err.message }, 400);
  if (err instanceof ReadOnlyError) return c.json({ error: err.message, readOnly: true }, 423);
  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'Validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400
    );
  }
  console.error('[server]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

const open = connections.sessions.length;
console.log(
  `Aferiy API listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} ` +
    `(link: ${LINK}, ${open === 1 ? '1 station open' : `${open} stations open`})`
);

export default { port: PORT, hostname: HOST, fetch: app.fetch };
