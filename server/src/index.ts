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
import { recentAudit, secretsAreEncrypted } from './history/db.ts';
import { Sampler, series } from './history/sampler.ts';
import { PluginHost, type PluginInstance } from './plugins/host.ts';
import { DeviceDriver, ReadOnlyError } from './drivers/device.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import { describeMessage, DeviceBroker } from './mqtt/broker.ts';
import { BleTransport } from './transport/ble.ts';
import { MqttTransport } from './transport/mqtt.ts';
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
  transport: () =>
    LINK === 'ble' ? new BleTransport() : new MqttTransport(broker, MQTT_PORT, MQTT_HOST),
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
  const station = connections.station();
  if (station) await connections.bind(station.deviceId, DEVICE_ID).catch(() => undefined);
  else await connections.link().then((link) => link?.bind(DEVICE_ID)).catch(() => undefined);
}

/** The station session, or an honest 404. The global station routes end here. */
function stationOr404(): StationSession {
  const session = connections.station();
  if (!session) {
    throw new HTTPException(404, {
      message: 'No station has been added yet. Add one from Devices.',
    });
  }
  return session;
}

/** Register-level access, which only real hardware has. */
function hardwareOr400(): DeviceDriver {
  const session = connections.station();
  if (!session?.device) {
    throw new HTTPException(400, { message: 'Needs a hardware driver (STATION_DRIVER=device or ble)' });
  }
  return session.device;
}

const app = new Hono();

// The client polls /status; logging it would drown out everything useful.
app.use('*', async (c, next) => (c.req.path === '/api/status' ? next() : logger()(c, next)));

app.use(
  '/api/*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
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
    link: connections.station()?.driver.mode ?? (LINK === 'sim' ? 'simulator' : 'device'),
    transport: connections.transport?.kind,
    readOnly: connections.readOnly,
  };
  return c.json(info);
});

/*
  The global station routes. Every one of them now resolves through the single
  open session rather than a module-level driver, which is why they can answer
  "there is no station" instead of inventing one. They are deprecated: their
  replacements are the device-scoped `/api/devices/:id/...` routes, and they go
  when the app's global tabs do.
*/
api.get('/status', (c) => c.json(stationOr404().driver.status()));
api.get('/settings', (c) => c.json(stationOr404().driver.settings()));

api.patch('/settings', async (c) =>
  c.json(await stationOr404().driver.applySettings(await body(c, StationSettingsPatchSchema)))
);

api.post('/ports/:id', async (c) => {
  const { id } = z.object({ id: PortIdSchema }).parse(c.req.param());
  const { enabled } = await body(c, PortPatchSchema);
  return c.json(await stationOr404().driver.setPort(id, enabled));
});

/** Simulator-only: pretend the mains came or went. `/grid` belongs to the relay. */
api.post('/simulator/grid', async (c) => {
  const { driver } = stationOr404();
  if (!driver.setGridConnected) {
    throw new HTTPException(400, { message: 'Only the simulator can fake the grid connection' });
  }
  const { connected } = await body(c, z.object({ connected: z.boolean() }));
  return c.json(await driver.setGridConnected(connected));
});

// --- station transports ---------------------------------------------------
//
// Which stations the current transport can see, and which one we are bound to.
// This used to be `/api/devices`; that name now belongs to the unified device
// list, because "device" should mean "a thing you own", not "a station this
// particular radio noticed".

api.get('/station/transports', (c) => {
  const link = connections.transport;
  return c.json({
    transport: link?.kind ?? null,
    boundId: link?.boundId ?? null,
    connected: link?.connected ?? false,
    autoBind: AUTO_BIND,
    lastError: link instanceof BleTransport ? link.lastError : null,
    attempts: link instanceof BleTransport ? link.attempts : null,
    devices: (link?.discovered() ?? []).map((d) => ({ ...d, bound: d.id === link?.boundId })),
  });
});

/**
 * Binds the station a saved device points at.
 *
 * The choice used to go to `data/binding.json`, one per server. It now goes to
 * the device's own record, so a restart reconnects *that* device rather than
 * whatever the file last said. Binding with nothing saved yet is still allowed
 * and still deliberately transient: it is commissioning, which Milestone B
 * turns into a wizard that ends in a saved device.
 */
api.post('/station/bind', async (c) => {
  const link = await connections.link();
  if (!link) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  const { id } = await body(c, z.object({ id: z.string().min(1) }));

  const session = connections.station();
  if (session) await connections.bind(session.deviceId, id);
  else await link.bind(id);

  return c.json({
    deviceId: session?.deviceId ?? null,
    boundId: link.boundId,
    connected: link.connected,
  });
});

api.post('/station/unbind', async (c) => {
  const link = await connections.link();
  if (!link) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });

  const session = connections.station();
  if (session) await connections.unbind(session.deviceId);
  else await link.unbind();

  return c.json({ deviceId: session?.deviceId ?? null, boundId: null, connected: false });
});

// --- diagnostics ----------------------------------------------------------
//
// These exist to confirm the register map against real hardware. The published
// map came from FOSSiBOT F2400/F3600 units; the P280 is the same stack but a
// different machine, so verify before trusting a value.

const diag = new Hono();

diag.get('/link', (c) => {
  const link = connections.transport;
  return c.json({
    driver: connections.station()?.driver.mode ?? (LINK === 'sim' ? 'simulator' : 'device'),
    transport: link?.kind ?? null,
    brokerListening: broker.listening,
    mqtt: { host: MQTT_HOST, port: MQTT_PORT },
    devices: (link?.discovered() ?? []).map((d) => ({ ...d, bound: d.id === link?.boundId })),
    boundId: link?.boundId ?? null,
    connected: link?.connected ?? false,
    configuredId: DEVICE_ID ?? null,
  });
});

diag.get('/traffic', (c) => c.json(broker.recentMessages.map(describeMessage)));

/** What the BLE GATT enumeration actually returned on the last connect. */
diag.get('/gatt', (c) => {
  const link = connections.transport;
  return c.json(
    link instanceof BleTransport
      ? { lastError: link.lastError, attempts: link.attempts, discovery: link.lastDiscovery }
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

const BASELINE_FILE = resolve(import.meta.dirname, '../data/baseline.json');

/**
 * Persisted, because the server restarts constantly during protocol work —
 * `--hot` reloads on every edit — and losing the baseline mid-experiment throws
 * away the comparison you were in the middle of making.
 */
let baseline: Baseline | null = await readFile(BASELINE_FILE, 'utf8')
  .then((raw) => JSON.parse(raw) as Baseline)
  .catch(() => null);

diag.post('/snapshot', async (c) => {
  const device = hardwareOr400();
  const [input, holding] = await Promise.all([device.readAllInput(), device.readAllHolding()]);
  baseline = { at: new Date().toISOString(), input, holding };
  await mkdir(dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(baseline), 'utf8');
  return c.json({ at: baseline.at, input: input.length, holding: holding.length });
});

diag.get('/blocked', (c) => c.json(connections.station()?.device?.blockedWrites ?? []));

/**
 * Read an arbitrary register range, and show it decoded as ASCII too.
 *
 * Strings the station stores — a WiFi SSID, say — would be packed two
 * characters per register and are invisible in a numeric dump. Reads only, so
 * probing outside the documented window cannot change anything.
 */
diag.get('/scan', async (c) => {
  const device = hardwareOr400();

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
  const device = hardwareOr400();
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
  const { hex } = await body(c, z.object({ hex: z.string().regex(/^[0-9a-fA-F]+$/) }));
  const link = connections.transport;
  if (!link?.boundId) throw new HTTPException(400, { message: 'No device bound' });

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
  readStation: () => connections.station()?.driver.status() ?? null,
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
  return c.json({
    provider: host.activeProvider('gridRelay'),
    granted: (() => {
      const id = host.activeProvider('gridRelay');
      return id ? host.isGranted(id, 'gridRelay.switch') : false;
    })(),
    state,
  });
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

api.get('/audit', (c) => c.json(recentAudit(Number(c.req.query('limit') ?? 100))));

// --- devices --------------------------------------------------------------
//
// One list of the things you own: the station, and whatever the installed
// drivers provide. Described identically, so the app has one card, one detail
// screen and one chart for all of them.

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

  // One station for now: this process holds one link, so a second entry would
  // be a promise the server cannot keep. The manager would refuse it honestly;
  // refusing to create it at all is clearer until the wizard can offer a choice.
  if (input.type === 'power-station' && catalog.find((record) => record.type === 'power-station')) {
    throw new HTTPException(409, { message: 'A power station is already added' });
  }

  const record = catalog.add({
    type: input.type,
    driver: input.driver,
    name: input.name,
    model: input.model ?? null,
    config: input.config,
  });

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

  if (!catalog.update(id, changes)) throw new HTTPException(404, { message: 'No such device' });
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
  if (!catalog.get(id)) throw new HTTPException(404, { message: 'No such device' });

  catalog.remove(id);
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
