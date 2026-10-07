import {
  channelOf,
  defineDeviceType,
  directOf,
  MAIN_PART,
  needsSignIn,
  type AttributeSpec,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type DeviceType,
  type OpenConnection,
  type Part,
  type Reading,
  type SessionHealth,
  type Value,
} from '@kraftverk/device-sdk';

import { SHELLY_WAYS } from './ways.ts';
import { merged, shellyIdentity, ShellyRpc, switchesOf, type DeviceInfo, type DeviceStatus, type SwitchStatus } from './protocol/index.ts';

/*
  A Shelly that switches (Gen2 and later): a plug, a relay, a pro's
  channels. It describes itself from what it reports — each `switch:<n>`
  component an outlet that switches, with the meter it has where it has
  one — so one type covers a Plus Plug S, a Plus 1PM and a Pro 4PM alike,
  until a product's own package says more of it. Kept current by what the
  device tells of every change over its WebSocket; asked once a minute too,
  so a silence is noticed.

  Ported from Home Assistant's `shelly` integration — its switch and its
  sensors for a switch component — and aioshelly (Apache-2.0; NOTICE).
*/

type ShellyConfig = Record<string, never>;

/** How often it is asked for all it says, beside what it tells of itself. */
const ASK_EVERY_MS = 60_000;

/** One switch component's part: `switch.0`. */
const partOf = (id: number) => `switch.${id}`;

/** The attributes of one switch: its relay, and the meter it has. */
function attributesOf(status: SwitchStatus): AttributeSpec[] {
  const part = partOf(status.id);
  const key = (name: string) => `${part}.${name}`;
  const attributes: AttributeSpec[] = [
    {
      key: key('on'),
      part,
      // "Switch", not "Power": power is what it draws.
      label: 'Switch',
      value: { type: 'boolean' },
      means: 'on',
      consequence: 'Switches off whatever it feeds.',
    },
  ];
  if (status.apower !== undefined) attributes.push({ key: key('power'), part, label: 'Power', value: { type: 'number', unit: 'W', precision: 1 }, means: 'power', category: 'primary' });
  if (status.voltage !== undefined) attributes.push({ key: key('voltage'), part, label: 'Voltage', value: { type: 'number', unit: 'V', precision: 1 }, means: 'voltage' });
  if (status.current !== undefined) attributes.push({ key: key('current'), part, label: 'Current', value: { type: 'number', unit: 'A', precision: 3 }, means: 'current' });
  if (status.freq !== undefined) attributes.push({ key: key('frequency'), part, label: 'Frequency', value: { type: 'number', unit: 'Hz', precision: 1 }, means: 'frequency', category: 'diagnostic' });
  if (status.aenergy?.total !== undefined) attributes.push({ key: key('energy'), part, label: 'Energy', value: { type: 'number', unit: 'kWh', precision: 3 }, means: 'energy', stateClass: 'total_increasing' });
  // The switch's own temperature, inside it: not the air's, so no meaning of the air's.
  if (status.temperature?.tC !== undefined) attributes.push({ key: key('temperature'), part, label: 'Its temperature', value: { type: 'number', unit: '°C', precision: 1 }, quantity: 'temperature', category: 'diagnostic' });
  return attributes;
}

/** What it is, from its switches: the device, and an outlet for each. */
export function describeShelly(switches: readonly SwitchStatus[]): DeviceDescription {
  const parts: Part[] = [
    { id: MAIN_PART, label: 'Shelly', kind: 'device' },
    ...switches.map((status): Part => ({ id: partOf(status.id), label: switches.length > 1 ? `Output ${status.id + 1}` : 'Output', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] })),
  ];
  return {
    parts,
    attributes: [
      ...switches.flatMap(attributesOf),
      { key: 'signal', label: 'Wi-Fi signal', value: { type: 'number', unit: 'dBm' }, quantity: 'signal', category: 'diagnostic' },
    ],
  };
}

/** What a plug with a meter is, until the device says: what the catalogue lists. */
const TYPICAL: SwitchStatus = { id: 0, output: false, apower: 0, voltage: 230, current: 0, aenergy: { total: 0 } };

/** Its readings, from all it has said: each switch's, and its Wi-Fi's. */
function readingsOf(status: DeviceStatus, at: string): Reading[] {
  const value = (v: number | boolean | null | undefined): Value => (v === undefined ? null : v);
  return [
    ...switchesOf(status).flatMap((each) => {
      const key = (name: string) => `${partOf(each.id)}.${name}`;
      return [
        { key: key('on'), value: value(each.output), at },
        ...(each.apower !== undefined ? [{ key: key('power'), value: each.apower, at }] : []),
        ...(each.voltage !== undefined ? [{ key: key('voltage'), value: each.voltage, at }] : []),
        ...(each.current !== undefined ? [{ key: key('current'), value: each.current, at }] : []),
        ...(each.freq !== undefined ? [{ key: key('frequency'), value: each.freq, at }] : []),
        // Wh, as it counts; kWh, as energy is kept.
        ...(each.aenergy?.total !== undefined ? [{ key: key('energy'), value: Math.round(each.aenergy.total) / 1000, at }] : []),
        ...(each.temperature?.tC !== undefined ? [{ key: key('temperature'), value: value(each.temperature.tC), at }] : []),
      ];
    }),
    { key: 'signal', value: value((status.wifi as { rssi?: number } | undefined)?.rssi), at },
  ];
}

/** The switch a command is for: by its part. */
const switchOfPart = (part: string): number | null => {
  const id = /^switch\.(\d+)$/.exec(part)?.[1];
  return id === undefined ? null : Number(id);
};

/** The RPC to a device, over its connection, signed with its password if it has one. */
function rpcOver(connection: OpenConnection, options: { onNotification?: ConstructorParameters<typeof ShellyRpc>[1]['onNotification']; onOpen?: (open: boolean) => void } = {}): ShellyRpc {
  const direct = directOf(connection, 'A Shelly is reached on the home network');
  return new ShellyRpc(channelOf(connection, 'bytes', 'A Shelly is reached over TCP'), {
    host: direct.address,
    password: () => direct.secrets.get('password') || null,
    ...options,
  });
}

async function realSession(ctx: DeviceContext<ShellyConfig>): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (!connection) throw new Error('A Shelly session needs a connection');
  let status: DeviceStatus = {};
  let info: DeviceInfo | null = null;
  let at = new Date(ctx.clock.now()).toISOString();
  let lastOk: number | null = null;
  let lastError: Error | null = null;

  // All it has said, and when: its description follows from it, so one that gained an output describes it.
  const took = (next: DeviceStatus) => {
    status = next;
    at = new Date(ctx.clock.now()).toISOString();
    lastOk = Date.now();
    lastError = null;
    ctx.changed();
  };

  const rpc = rpcOver(connection, {
    // What it tells of every change: merged into all it said, as aioshelly does.
    onNotification: (notification) => {
      if (notification.method === 'NotifyStatus') took(merged(status, notification.params));
      else if (notification.method === 'NotifyFullStatus') took(notification.params);
    },
    onOpen: (open) => {
      if (open) void ask();
      else ctx.changed();
    },
  });

  const ask = async () => {
    try {
      info ??= await rpc.call<DeviceInfo>('Shelly.GetDeviceInfo');
      took(await rpc.call<DeviceStatus>('Shelly.GetStatus'));
    } catch (error) {
      lastError = error as Error;
      ctx.changed();
    }
  };
  ctx.schedule(ASK_EVERY_MS, ask);
  // Not awaited: a Shelly that is unplugged must not stop its session opening.
  void ask();

  return {
    health(): SessionHealth {
      if (lastError && needsSignIn(lastError)) return { status: 'needs-you', detail: lastError.message, lastReadingAt: lastOk ? at : null };
      const fresh = rpc.open && lastOk !== null && Date.now() - lastOk < ASK_EVERY_MS * 2.5;
      if (fresh) return { status: 'connected', detail: 'Connected', lastReadingAt: at };
      return { status: lastOk === null && !lastError ? 'connecting' : 'offline', detail: lastError?.message ?? (rpc.open ? 'Connecting' : 'Not answering on the home network'), lastReadingAt: lastOk ? at : null };
    },
    readings: () => readingsOf(status, at),
    // What it is, as it says: its switches, once it has said them.
    description: () => (switchesOf(status).length ? describeShelly(switchesOf(status)) : null),
    info: () => (info ? { manufacturer: 'Shelly', model: info.model, firmware: { main: info.ver } } : null),
    identity: () => ({ id: info ? shellyIdentity(info.mac) : null, name: info?.name ?? null }),
    async command(request) {
      const id = switchOfPart(request.part);
      if (request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean' || id === null) {
        return { accepted: false, error: `A Shelly takes no ${request.capability}.${request.command} on ${request.part}` };
      }
      if (ctx.readOnly) return { accepted: false, error: 'Every hardware write is refused: this holder is read-only' };
      try {
        await rpc.call('Switch.Set', { id, on: request.args.on });
        // What it reports now, not what was asked: it tells of the change too, a moment later.
        took(merged(status, { [`switch:${id}`]: await rpc.call<SwitchStatus>('Switch.GetStatus', { id }) }));
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    close: () => rpc.close(),
  };
}

/** A Shelly that is not there: one switch with a meter, drawing while it is on. */
function simulatedSession(ctx: DeviceContext<ShellyConfig>): DeviceSession {
  let on = ctx.store.get<boolean>('simulator.on') ?? true;
  let wh = ctx.store.get<number>('simulator.wh') ?? 0;
  let at = new Date(ctx.clock.now()).toISOString();
  const watts = 60;
  ctx.schedule(1000, () => {
    at = new Date(ctx.clock.now()).toISOString();
    if (on) {
      wh += watts / 3600;
      ctx.store.set('simulator.wh', wh);
    }
  });
  const status = (): DeviceStatus => ({
    'switch:0': { id: 0, output: on, apower: on ? watts : 0, voltage: 230, current: on ? Math.round((watts / 230) * 1000) / 1000 : 0, freq: 50, aenergy: { total: Math.round(wh * 1000) / 1000 }, temperature: { tC: 38 } },
    wifi: { rssi: -55 },
  });
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    readings: () => readingsOf(status(), at),
    description: () => describeShelly(switchesOf(status())),
    info: () => ({ manufacturer: 'Shelly', model: 'Simulated', firmware: { main: 'simulated' } }),
    identity: () => ({ id: shellyIdentity('000000000000'), name: null }),
    async command(request) {
      if (request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean' || switchOfPart(request.part) !== 0) {
        return { accepted: false, error: `A Shelly takes no ${request.capability}.${request.command} on ${request.part}` };
      }
      on = request.args.on;
      ctx.store.set('simulator.on', on);
      at = new Date(ctx.clock.now()).toISOString();
      ctx.changed();
      return { accepted: true };
    },
    close: async () => undefined,
  };
}

const shellySwitch: DeviceType<ShellyConfig> = defineDeviceType<ShellyConfig>({
  id: 'shelly.switch',
  kind: 'hardware',
  meta: {
    name: 'Shelly switch',
    brand: 'Shelly',
    category: 'relay',
    icon: 'toggle-right',
    description: 'A Shelly that switches — a plug, a relay, a Pro’s outputs — Gen2 and later, on your home network with no cloud. Each output with the meter it has.',
    support: 'experimental',
    supportNote: 'Ported from Home Assistant’s Shelly integration; not yet checked against a real Shelly.',
  },
  config: { fields: {} },
  connections: SHELLY_WAYS,
  describe: () => describeShelly([TYPICAL]),

  /** Reads it once: who it is, and — asking its status — whether its password, if it has one, is right. */
  async identify(connection) {
    const rpc = rpcOver(connection);
    try {
      const info = await rpc.call<DeviceInfo>('Shelly.GetDeviceInfo');
      if (!(info.gen >= 2)) throw new Error('This Shelly is of the first generation, which is reached another way: not yet supported');
      const switches = switchesOf(await rpc.call<DeviceStatus>('Shelly.GetStatus'));
      const states = switches.map((each) => `${switches.length > 1 ? `output ${each.id + 1} ` : ''}${each.output ? 'on' : 'off'}${each.apower !== undefined ? `, drawing ${Math.round(each.apower)} W` : ''}`);
      return {
        identity: shellyIdentity(info.mac),
        model: info.app,
        summary: `A Shelly ${info.app} (${info.model}), firmware ${info.ver}${states.length ? `: ${states.join('; ')}` : ', with no outputs it switches'}.`,
      };
    } finally {
      await rpc.close();
    }
  },

  createSession: (ctx) => realSession(ctx),
  createSimulator: async (ctx) => simulatedSession(ctx),
});

export default shellySwitch;
