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
import { loadBinding, saveBinding } from './binding.ts';
import { DeviceCatalog, STATION_MODELS } from './devices/catalog.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { recentAudit, secretsAreEncrypted } from './history/db.ts';
import { Sampler, series } from './history/sampler.ts';
import { PluginHost, type PluginInstance } from './plugins/host.ts';
import { DeviceDriver, ReadOnlyError } from './drivers/device.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import type { StationDriver } from './drivers/types.ts';
import { describeMessage, DeviceBroker } from './mqtt/broker.ts';
import { BleTransport } from './transport/ble.ts';
import { MqttTransport } from './transport/mqtt.ts';
import type { Transport } from './transport/types.ts';
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
let driver: StationDriver;
let transport: Transport | null = null;
let device: DeviceDriver | null = null;

if (DRIVER === 'device' || DRIVER === 'ble') {
  transport =
    DRIVER === 'ble' ? new BleTransport() : new MqttTransport(broker, MQTT_PORT, MQTT_HOST);

  try {
    await transport.start();
  } catch (error) {
    console.error(`Could not start the ${DRIVER} transport:`, error);
    throw error;
  }

  if (DRIVER === 'ble') {
    console.log('Scanning for Bluetooth stations…');
  } else {
    console.log(`MQTT broker listening on ${MQTT_HOST}:${MQTT_PORT}`);
    console.log('Point mqtt.sydpower.com at this machine so the station connects here.');
  }

  device = new DeviceDriver({ transport, readOnly: READ_ONLY });
  driver = device;

  if (READ_ONLY) {
    console.log('READ-ONLY: every write will be refused. Nothing can change on the station.');
  }

  // Restore the previous choice, else adopt the first station we see.
  const saved = await loadBinding();
  const preferred = DEVICE_ID ?? (saved?.kind === transport.kind ? saved.id : undefined);

  if (preferred) {
    try {
      await transport.bind(preferred);
      console.log(`Bound to ${preferred}`);
    } catch (error) {
      console.warn(`Could not bind ${preferred} yet:`, (error as Error).message);
    }
  }

  transport.onDiscovery((found) => {
    const label = found.likelyStation ? 'station' : 'device (not a station)';
    console.log(`Discovered ${found.kind} ${label}: ${found.name} (${found.id})`);

    const wanted = preferred && found.id.toUpperCase() === preferred.toUpperCase();
    // Never auto-connect to something we can't identify as a station.
    if (!transport!.boundId && (wanted || (AUTO_BIND && found.likelyStation))) {
      void transport!
        .bind(found.id)
        .then(async () => {
          console.log(`Auto-bound to ${found.id}`);
          device?.reset();
          await saveBinding({
            kind: transport!.kind,
            id: found.id,
            boundAt: new Date().toISOString(),
          });
        })
        .catch((error) => console.warn(`Auto-bind failed:`, (error as Error).message));
    }
  });
} else {
  driver = new SimulatorDriver();
}

await driver.start();

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
    link: driver.mode,
    transport: transport?.kind,
    readOnly: device?.readOnly ?? false,
  };
  return c.json(info);
});

api.get('/status', (c) => c.json(driver.status()));
api.get('/settings', (c) => c.json(driver.settings()));

api.patch('/settings', async (c) =>
  c.json(await driver.applySettings(await body(c, StationSettingsPatchSchema)))
);

api.post('/ports/:id', async (c) => {
  const { id } = z.object({ id: PortIdSchema }).parse(c.req.param());
  const { enabled } = await body(c, PortPatchSchema);
  return c.json(await driver.setPort(id, enabled));
});

/** Simulator-only: pretend the mains came or went. `/grid` belongs to the relay. */
api.post('/simulator/grid', async (c) => {
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

api.get('/station/transports', (c) =>
  c.json({
    transport: transport?.kind ?? null,
    boundId: transport?.boundId ?? null,
    connected: transport?.connected ?? false,
    autoBind: AUTO_BIND,
    lastError: transport instanceof BleTransport ? transport.lastError : null,
    attempts: transport instanceof BleTransport ? transport.attempts : null,
    devices: (transport?.discovered() ?? []).map((d) => ({
      ...d,
      bound: d.id === transport?.boundId,
    })),
  })
);

api.post('/station/bind', async (c) => {
  if (!transport) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  const { id } = await body(c, z.object({ id: z.string().min(1) }));

  await transport.bind(id);
  device?.reset();
  await saveBinding({ kind: transport.kind, id, boundAt: new Date().toISOString() });
  return c.json({ boundId: transport.boundId, connected: transport.connected });
});

api.post('/station/unbind', async (c) => {
  if (!transport) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  await transport.unbind();
  device?.reset();
  await saveBinding(null);
  return c.json({ boundId: null, connected: false });
});

// --- diagnostics ----------------------------------------------------------
//
// These exist to confirm the register map against real hardware. The published
// map came from FOSSiBOT F2400/F3600 units; the P280 is the same stack but a
// different machine, so verify before trusting a value.

const diag = new Hono();

diag.get('/link', (c) =>
  c.json({
    driver: driver.mode,
    transport: transport?.kind ?? null,
    brokerListening: broker.listening,
    mqtt: { host: MQTT_HOST, port: MQTT_PORT },
    devices: (transport?.discovered() ?? []).map((d) => ({
      ...d,
      bound: d.id === transport?.boundId,
    })),
    boundId: transport?.boundId ?? null,
    connected: transport?.connected ?? false,
    configuredId: DEVICE_ID ?? null,
  })
);

diag.get('/traffic', (c) => c.json(broker.recentMessages.map(describeMessage)));

/** What the BLE GATT enumeration actually returned on the last connect. */
diag.get('/gatt', (c) =>
  c.json(
    transport instanceof BleTransport
      ? {
          lastError: transport.lastError,
          attempts: transport.attempts,
          discovery: transport.lastDiscovery,
        }
      : { error: 'Not on the BLE transport' }
  )
);

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
  if (!device) throw new HTTPException(400, { message: 'Needs a hardware driver' });
  const [input, holding] = await Promise.all([device.readAllInput(), device.readAllHolding()]);
  baseline = { at: new Date().toISOString(), input, holding };
  await mkdir(dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(baseline), 'utf8');
  return c.json({ at: baseline.at, input: input.length, holding: holding.length });
});

diag.get('/blocked', (c) => c.json(device?.blockedWrites ?? []));

/**
 * Read an arbitrary register range, and show it decoded as ASCII too.
 *
 * Strings the station stores — a WiFi SSID, say — would be packed two
 * characters per register and are invisible in a numeric dump. Reads only, so
 * probing outside the documented window cannot change anything.
 */
diag.get('/scan', async (c) => {
  if (!device) throw new HTTPException(400, { message: 'Needs a hardware driver' });

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
  if (!device) {
    throw new HTTPException(400, {
      message: 'Register dumps require STATION_DRIVER=device or ble',
    });
  }
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
  if (!transport?.boundId) throw new HTTPException(400, { message: 'No device bound' });

  const frame = fromHex(hex);
  await transport.send(frame);
  return c.json({
    sent: toHex(frame),
    to: transport.boundId,
    parsedAsRequest: parseFrame(frame),
  });
});

// --- extensions -----------------------------------------------------------
//
// Plugins provide signals and offer capabilities; they never actuate. Every
// relay command goes through the action gateway, which checks the grant, the
// policy and the freshness of the data, then proves the physical effect
// happened. See docs/PLUGIN-ARCHITECTURE.md.

const host = new PluginHost();
await host.discover();
await host.startEnabled();

const gateway = new ActionGateway({
  host,
  readStation: () => driver.status(),
  isReadOnly: () => device?.readOnly ?? false,
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

const catalog = new DeviceCatalog();
const registry = new DeviceRegistry(catalog, host, () => driver);
registry.adoptStation();

const sampler = new Sampler(registry);
sampler.start();

api.get('/devices', async (c) => c.json({ devices: await registry.all() }));

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

  // One station for now: the driver holds a single link, so a second entry
  // would be a promise the server cannot keep.
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

  // The station's own ports are core business and keep their existing path.
  if (found.record.driver === 'core.station') {
    const port = PortIdSchema.parse(controlId);
    return c.json(await driver.setPort(port, value === true));
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

const linkLabel = transport ? `${driver.mode}/${transport.kind}` : driver.mode;
console.log(
  `Aferiy API listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (link: ${linkLabel})`
);

export default { port: PORT, hostname: HOST, fetch: app.fetch };
