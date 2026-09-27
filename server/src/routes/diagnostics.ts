import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { stationId } from '@kraftverk/device-sdk';
import { commandRefusal, describeCommand, describeRegisters, fromHex, parseFrame, toHex, type RegisterDump } from '@kraftverk/protocol';

import { BleHost, BleLink } from '../transport/ble.ts';
import { auditDevice, bindTarget, body, hardwareOr400, stationSession, type AppDeps } from './shared.ts';

/**
 * A baseline for the register diff.
 *
 * Snapshot, change one thing on the station (or in BrightEMS), then read again:
 * whatever moved is the register behind that control. This is how the map
 * gets confirmed on hardware it was not derived from.
 */
type Baseline = { at: string; input: number[]; holding: number[] };

/**
 * Baselines, one per station.
 *
 * There used to be one for the whole server: a snapshot taken on one station
 * and a dump read from another were diffed against each other, producing
 * convincing wrong answers in the one workflow meant to find the registers
 * that differ between models.
 *
 * Persisted, because the server restarts constantly during protocol work, and
 * losing the baseline mid-experiment throws away the comparison.
 */
class Baselines {
  #loaded: Promise<Map<string, Baseline>> | null = null;

  constructor(private file: string) {}

  #all(): Promise<Map<string, Baseline>> {
    this.#loaded ??= readFile(this.file, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as Record<string, Baseline> | Baseline;
        // The old single-baseline file belongs to no station in particular,
        // so it is not guessed onto one.
        if (Array.isArray((parsed as Baseline).input)) return new Map<string, Baseline>();
        return new Map(Object.entries(parsed as Record<string, Baseline>));
      })
      .catch(() => new Map<string, Baseline>());
    return this.#loaded;
  }

  async get(deviceId: string): Promise<Baseline | null> {
    return (await this.#all()).get(deviceId) ?? null;
  }

  async set(deviceId: string, baseline: Baseline): Promise<void> {
    const all = await this.#all();
    all.set(deviceId, baseline);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(Object.fromEntries(all)), 'utf8');
  }
}

/**
 * These exist to confirm the register map against real hardware. The
 * published map came from FOSSiBOT F2400/F3600 units; the P280 is the same
 * stack but a different machine, so verify before trusting a value.
 */
export function diagnosticsRoutes({ config, connections, broker, serverLog }: AppDeps): Hono {
  const diag = new Hono();
  const baselines = new Baselines(config.baselineFile);

  /**
   * The broker, as the server sees it: whether it is running, whether the
   * server is connected to it, and which stations it holds. Null without MQTT.
   */
  const brokerView = () => {
    if (!broker) return null;
    const { supervisor, bus } = broker;
    const { state } = supervisor;
    return {
      status: state.status,
      error: state.error,
      pid: state.health?.pid ?? null,
      startedAt: state.health?.startedAt ?? null,
      build: state.health?.build ?? null,
      expectedBuild: state.expectedBuild,
      buildMatches: state.buildMatches,
      spawns: state.spawns,
      listen: state.health?.mqtt ?? { host: config.mqtt.host, port: config.mqtt.port, listening: false },
      serverConnected: bus.connected,
      serverConnectedAt: bus.connectedAt?.toISOString() ?? null,
      serverError: bus.connected ? null : bus.lastError,
      stations: bus.stations,
    };
  };

  diag.get('/link', (c) => {
    const linked = connections.hosts.flatMap(({ host }) => host.openIds());
    const seen = connections.hosts.flatMap(({ host }) => host.discovered());

    return c.json({
      driver: config.simulate ? 'simulator' : 'device',
      transports: connections.hosts.map(({ kind }) => kind),
      // Kept for older clients: true when the server has a live broker connection.
      brokerListening: broker?.bus.connected ?? false,
      mqtt: { host: config.mqtt.host, port: config.mqtt.port },
      broker: brokerView(),
      devices: seen.map((d) => ({ ...d, bound: linked.includes(stationId(d.id)) })),
      // Which stations are held, and by whom. No "the" station.
      linkedStations: connections.sessions
        .filter((session) => session.link)
        .map((session) => ({ deviceId: session.deviceId, stationId: session.link!.boundId })),
      configuredId: config.deviceId,
    });
  });

  /**
   * Frames in both directions, oldest first — the broker's record, not the
   * server's, so it includes what happened while the server was restarting.
   */
  diag.get('/traffic', async (c) => {
    if (!broker) return c.json([]);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(2000).default(100) })
      .parse({ limit: c.req.query('limit') ?? 100 });
    return c.json((await broker.admin<unknown[]>(`/traffic?limit=${limit}`)) ?? []);
  });

  /** Everything the broker reports about itself: clients, stations, counters, refusals. */
  diag.get('/broker', async (c) => {
    if (!broker) throw new HTTPException(404, { message: 'This server does not run the MQTT transport' });
    // `detail`, not spread in: the broker's own report has fields — `status`
    // among them — that would silently overwrite the server's view of it.
    return c.json({ ...brokerView(), detail: await broker.admin('/status') });
  });

  /**
   * The broker's journal: every connection, subscription, write and
   * disconnect, with the reason. `?level=debug` adds every poll and telemetry
   * frame; `?after=<seq>` continues from where the last call left off.
   */
  diag.get('/broker/journal', async (c) => {
    if (!broker) throw new HTTPException(404, { message: 'This server does not run the MQTT transport' });
    const query = new URLSearchParams(c.req.query()).toString();
    const journal = await broker.admin(`/journal${query ? `?${query}` : ''}`);
    if (!journal) throw new HTTPException(503, { message: broker.supervisor.state.error ?? 'The broker is not answering' });
    return c.json(journal);
  });

  /**
   * What the server has said lately — the same lines as its console, which in
   * a container nobody is watching. `?level=warn` for problems only. The full
   * record is in daily files, named here, for a shell on the server.
   */
  diag.get('/log', (c) => {
    const { limit, level } = z
      .object({
        limit: z.coerce.number().int().min(1).max(2000).default(500),
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
      .parse({ limit: c.req.query('limit') ?? 500, level: c.req.query('level') });
    return c.json({ dir: serverLog.dir, lines: serverLog.recent(limit, level) });
  });

  /** What the BLE GATT enumeration actually returned on the last connect. */
  diag.get('/gatt', (c) => {
    const ble = connections.hosts.find(({ kind }) => kind === 'ble')?.host;
    if (!(ble instanceof BleHost)) return c.json({ error: 'Not on the BLE transport' });
    return c.json({
      lastError: ble.lastError,
      attempts: ble.attempts,
      discovery: ble.lastDiscovery,
      // Per station, now that there can be several.
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
    });
  });

  diag.post('/snapshot', async (c) => {
    const deviceId = stationSession(connections, c.req.query('deviceId')).deviceId;
    const device = hardwareOr400(connections, deviceId);
    const [input, holding] = await Promise.all([device.readAllInput(), device.readAllHolding()]);
    const baseline = { at: new Date().toISOString(), input, holding };
    await baselines.set(deviceId, baseline);
    return c.json({ at: baseline.at, input: input.length, holding: holding.length });
  });

  /** Writes this station refused while read-only. Its own, not somebody else's. */
  diag.get('/blocked', (c) => c.json(hardwareOr400(connections, c.req.query('deviceId')).blockedWrites));

  /**
   * Read an arbitrary register range, and show it decoded as ASCII too.
   *
   * Strings the station stores — a WiFi SSID, say — would be packed two
   * characters per register and are invisible in a numeric dump. Reads only,
   * so probing outside the documented window cannot change anything.
   */
  diag.get('/scan', async (c) => {
    const device = hardwareOr400(connections, c.req.query('deviceId'));
    const { fn, start, count } = z
      .object({
        fn: z.coerce.number().int().refine((v) => v === 3 || v === 4, 'fn must be 3 or 4'),
        start: z.coerce.number().int().min(0).max(65535),
        count: z.coerce.number().int().min(1).max(125),
      })
      .parse({ fn: c.req.query('fn') ?? 3, start: c.req.query('start') ?? 0, count: c.req.query('count') ?? 40 });

    const values = await device.readRange(fn as 3 | 4, start, count).catch(() => [] as number[]);

    /** Two bytes per register, printable ASCII only. */
    const ascii = values
      .map((v) => {
        const ch = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
        return ch((v >> 8) & 0xff) + ch(v & 0xff);
      })
      .join('');

    return c.json({
      fn,
      start,
      count,
      ok: values.length > 0,
      values: values.map((raw, i) => ({ register: start + i, raw, hex: raw.toString(16).padStart(4, '0') })),
      ascii,
    });
  });

  /** Every register, raw and decoded, diffed against this station's own baseline. */
  diag.get('/registers', async (c) => {
    const deviceId = stationSession(connections, c.req.query('deviceId')).deviceId;
    const device = hardwareOr400(connections, deviceId);
    const [input, holding, baseline] = await Promise.all([
      device.readAllInput().catch(() => [] as number[]),
      device.readAllHolding().catch(() => [] as number[]),
      baselines.get(deviceId),
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
    if (!config.allowRawModbus) {
      throw new HTTPException(403, { message: 'Set ALLOW_RAW_MODBUS=1 to enable raw frames. Bad writes can brick the device.' });
    }
    const { hex, deviceId } = await body(c, z.object({ hex: z.string().max(512).regex(/^[0-9a-fA-F]+$/), deviceId: z.string().optional() }));

    // A raw frame goes down one station's link, so it has to name one.
    const target = bindTarget(connections, deviceId);
    const link = connections.get(target)?.link;
    if (!link?.boundId) throw new HTTPException(400, { message: 'No station bound' });

    const frame = fromHex(hex);
    // Raw frames skip the whitelist by design — reaching undocumented registers
    // is what they are for — but never this one rule, on either transport.
    const refusal = commandRefusal(frame);
    if (refusal) throw new HTTPException(400, { message: refusal });
    await link.send(frame);
    auditDevice(c, 'station.raw', target, `Sent a raw frame: ${describeCommand(frame)}`, { hex: toHex(frame) });
    return c.json({ sent: toHex(frame), to: link.boundId, parsedAsRequest: parseFrame(frame) });
  });

  return diag;
}
