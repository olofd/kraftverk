import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';

import pkg from '../package.json' with { type: 'json' };
import { loadBinding, saveBinding } from './binding.ts';
import { DeviceDriver, ReadOnlyError } from './drivers/device.ts';
import { SimulatorDriver } from './drivers/simulator.ts';
import type { StationDriver } from './drivers/types.ts';
import { describeMessage, DeviceBroker } from './mqtt/broker.ts';
import { BleTransport } from './transport/ble.ts';
import { MqttTransport } from './transport/mqtt.ts';
import type { Transport } from './transport/types.ts';
import { fromHex, parseFrame, toHex } from './protocol/modbus.ts';
import {
  HOLDING_NAMES,
  INPUT_NAMES,
  UnsafeWriteError,
  WRITABLE,
} from './protocol/registers.ts';
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
          await saveBinding({ kind: found.kind, id: found.id, boundAt: new Date().toISOString() });
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

api.post('/grid', async (c) => {
  if (!driver.setGridConnected) {
    throw new HTTPException(400, { message: 'Only the simulator can fake the grid connection' });
  }
  const { connected } = await body(c, z.object({ connected: z.boolean() }));
  return c.json(await driver.setGridConnected(connected));
});

// --- device discovery and binding ----------------------------------------

api.get('/devices', (c) =>
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

api.post('/devices/bind', async (c) => {
  if (!transport) throw new HTTPException(400, { message: 'Binding requires a hardware driver' });
  const { id } = await body(c, z.object({ id: z.string().min(1) }));

  await transport.bind(id);
  device?.reset();
  await saveBinding({ kind: transport.kind, id, boundAt: new Date().toISOString() });
  return c.json({ boundId: transport.boundId, connected: transport.connected });
});

api.post('/devices/unbind', async (c) => {
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

  const describe = (
    values: number[],
    names: Record<number, string>,
    writable: boolean,
    before: number[] | undefined
  ) =>
    values.map((raw, index) => {
      const previous = before?.[index];
      return {
        register: index,
        name: names[index] ?? null,
        raw,
        hex: raw.toString(16).padStart(4, '0'),
        asTenths: raw / 10,
        writable: writable ? (WRITABLE[index] ?? null) : null,
        previous: previous ?? null,
        changed: previous !== undefined && previous !== raw,
      };
    });

  return c.json({
    mac: device.mac,
    readOnly: device.readOnly,
    baselineAt: baseline?.at ?? null,
    input: describe(input, INPUT_NAMES, false, baseline?.input),
    holding: describe(holding, HOLDING_NAMES, true, baseline?.holding),
  });
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
