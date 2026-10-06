import {
  defineDeviceType,
  MAIN_PART,
  type Bridge,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type Member,
  type OpenConnection,
  type SessionHealth,
} from '@kraftverk/device-sdk';

import type { ZigbeeLink } from './link.ts';
import { linkOver, tuyaIdentity, zigbeeIdentity, type Dps } from './protocol/index.ts';

/**
 * A Tuya Zigbee gateway, as a device of its own (docs/PLAN-INTEGRATIONS.md
 * §4.3): on the home network, spoken to with its own key, and a bridge to the
 * Zigbee devices paired with it. One conversation with the gateway serves
 * every device behind it — each named in what is asked of it by its Zigbee
 * address, and each handed a link (`./link.ts`) to read and switch it by.
 *
 * Who is behind it is what the gateway says — it reports which of its
 * devices it can reach — and what has been linked to it, kept between runs.
 */

type Config = Record<string, never>;

/** How often the gateway is made sure of: a conversation that dropped is opened again. */
const KEEP_EVERY_MS = 30_000;

/** What a gateway's conversation offers the bridge: the same for a real gateway and a simulated one. */
type Wire = {
  status(cid: string): Promise<Dps>;
  refresh(dps: readonly number[], cid: string): Promise<void>;
  set(dps: Dps, cid: string): Promise<Dps>;
  connected(): boolean;
  version(): string;
};

/** What the gateway keeps of each device behind it. */
type Kept = { online: boolean | null; linked: Set<{ changed: () => void; pushes: Dps[] }> };

/**
 * The devices behind a gateway, and a link to each: its bridge, real or
 * simulated alike — only the wire differs. Known by what the gateway says of
 * them and what has been linked to them, kept in the gateway's own store.
 */
export class ZigbeeDevices implements Bridge<ZigbeeLink> {
  #kept = new Map<string, Kept>();

  constructor(
    private readonly wire: Wire,
    private readonly store: DeviceContext['store'],
    private readonly changed: () => void
  ) {
    for (const cid of store.get<string[]>('members') ?? []) this.#keep(cid);
  }

  members(): Member[] {
    return [...this.#kept.keys()].map((cid) => ({ key: cid, name: null, model: null, identity: zigbeeIdentity(cid), typeId: null }));
  }

  /** Every device known behind it, by Zigbee address: what a gateway on 3.3 is proven by asking about. */
  keys(): string[] {
    return [...this.#kept.keys()];
  }

  /** The gateway said it can, or cannot, reach a device: one it had not said of is behind it now. */
  presence(cid: string, online: boolean): void {
    const kept = this.#keep(cid);
    kept.online = online;
    this.#tell(kept);
  }

  /** The gateway passed on what a device pushed. */
  pushed(cid: string, dps: Dps): void {
    const kept = this.#keep(cid);
    // A device that pushes is there, whatever the gateway last said.
    kept.online = true;
    for (const linked of kept.linked) linked.pushes.push(dps);
    this.#tell(kept);
  }

  async link(cid: string, changed: () => void): Promise<ZigbeeLink> {
    const key = cid.toLowerCase();
    const kept = this.#keep(key);
    const linked = { changed, pushes: [] as Dps[] };
    kept.linked.add(linked);
    return {
      status: () => this.wire.status(key),
      refresh: (dps) => this.wire.refresh(dps, key),
      set: (dps) => this.wire.set(dps, key),
      takePushes: () => linked.pushes.splice(0),
      online: () => kept.online,
      connected: () => this.wire.connected(),
      version: () => this.wire.version(),
      close: () => void kept.linked.delete(linked),
    };
  }

  #keep(cid: string): Kept {
    let kept = this.#kept.get(cid);
    if (!kept) {
      kept = { online: null, linked: new Set() };
      this.#kept.set(cid, kept);
      this.store.set('members', [...this.#kept.keys()]);
      // Who is behind it changed: its holder reads its members again.
      this.changed();
    }
    return kept;
  }

  #tell(kept: Kept): void {
    for (const linked of kept.linked) linked.changed();
  }
}

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Gateway', kind: 'device', icon: 'share-2' }],
  attributes: [{ key: 'devices', label: 'Zigbee devices', value: { type: 'number', integer: true }, category: 'diagnostic' }],
};

/** A gateway's session, over whatever wire: its health, how many devices are behind it, and its bridge. */
function session(devices: ZigbeeDevices, health: () => SessionHealth, identity: string | null, close: () => Promise<void>): DeviceSession {
  return {
    health,
    readings: () => [{ key: 'devices', value: devices.keys().length, at: new Date().toISOString() }],
    info: () => ({ manufacturer: 'Tuya' }),
    identity: () => ({ id: identity, name: null }),
    command: async () => ({ accepted: false, error: 'A gateway takes no commands: the devices behind it are devices of their own' }),
    bridge: devices,
    close,
  };
}

const deviceIdOf = (connection: OpenConnection | null): string | null => {
  const id = String(connection?.config.deviceId ?? '');
  return id ? id : null;
};

/** A gateway on the home network: one conversation, kept open, for every device behind it. */
async function gatewaySession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (!connection) throw new Error('A gateway is reached on the home network');
  // Declared before the link, which tells it what it hears; given the link's calls once it is made.
  let devices: ZigbeeDevices | null = null;
  const tuya = linkOver(connection, {
    log: (message) => ctx.log.info(message),
    gateway: { members: () => devices?.keys() ?? [] },
    onPush: (dps, cid) => {
      if (cid) devices?.pushed(cid, dps);
    },
    onPresence: (cid, online) => devices?.presence(cid, online),
  });
  devices = new ZigbeeDevices(
    {
      status: (cid) => tuya.status(cid),
      refresh: (dps, cid) => tuya.refresh(dps, cid),
      set: (dps, cid) => tuya.set(dps, cid),
      connected: () => tuya.connected,
      version: () => tuya.version,
    },
    ctx.store,
    () => ctx.changed()
  );
  const known = devices;

  let at: string | null = null;
  let error: string | null = null;
  const keep = async () => {
    try {
      await tuya.open();
      at = new Date().toISOString();
      error = null;
    } catch (thrown) {
      error = (thrown as Error).message;
    }
    ctx.changed();
  };
  ctx.schedule(KEEP_EVERY_MS, keep);
  // Not awaited: a gateway that is unplugged must not stop its session opening.
  void keep();

  return session(
    known,
    () => {
      if (tuya.connected) return { status: 'connected', detail: `${known.keys().length === 1 ? '1 Zigbee device' : `${known.keys().length} Zigbee devices`} · Tuya ${tuya.version}`, lastReadingAt: at };
      if (error) return { status: 'error', detail: error, lastReadingAt: at };
      return { status: 'connecting', detail: 'Connecting', lastReadingAt: at };
    },
    deviceIdOf(ctx.connection) ? tuyaIdentity(deviceIdOf(ctx.connection)!) : null,
    () => tuya.close()
  );
}

/** A Zigbee device that is not there, behind a simulated gateway: a plug's relay and meter, as raw datapoints. */
type SimulatedDevice = { dps: Dps };

/** A gateway with two Zigbee plugs behind it that are not there: each switches, and draws while it is on. */
function simulatedGateway(ctx: DeviceContext<Config>): DeviceSession {
  const fleet = new Map<string, SimulatedDevice>([
    ['a4c1380000000001', { dps: { '1': true, '17': 1234, '18': 430, '19': 990, '20': 2301 } }],
    ['a4c1380000000002', { dps: { '1': false, '17': 87, '18': 0, '19': 0, '20': 2298 } }],
  ]);
  const device = (cid: string) => {
    const found = fleet.get(cid);
    if (!found) throw new Error(`the gateway answered, but says nothing of ${cid}: is it paired with this gateway?`);
    return found;
  };
  let devices: ZigbeeDevices | null = null;
  devices = new ZigbeeDevices(
    {
      status: async (cid) => ({ ...device(cid).dps }),
      refresh: async (_dps, cid) => {
        devices?.pushed(cid, { ...device(cid).dps });
      },
      set: async (dps, cid) => {
        const found = device(cid);
        Object.assign(found.dps, dps);
        // Switched off, nothing flows; on, it draws again.
        if (dps['1'] !== undefined) Object.assign(found.dps, dps['1'] ? { '18': 430, '19': 990 } : { '18': 0, '19': 0 });
        queueMicrotask(() => devices?.pushed(cid, { ...found.dps }));
        return {};
      },
      connected: () => true,
      version: () => 'simulated',
    },
    ctx.store,
    () => ctx.changed()
  );
  for (const cid of fleet.keys()) devices.presence(cid, true);
  const at = new Date().toISOString();
  return session(devices, () => ({ status: 'connected', detail: 'Simulated: two Zigbee plugs behind it', lastReadingAt: at }), null, async () => undefined);
}

export default defineDeviceType<Config>({
  id: 'tuya.gateway',
  kind: 'hardware',
  meta: {
    name: 'Tuya Zigbee gateway',
    brand: 'Tuya',
    category: 'gateway',
    icon: 'share-2',
    description: 'A Tuya or Smart Life Zigbee gateway on your home network: spoken to with its own key and no cloud, and through it every Zigbee plug paired with it.',
    support: 'experimental',
    supportNote: 'Mapped on an RSH GW018-DM, Tuya 3.4; other Tuya Zigbee gateways speak the same way.',
  },
  config: { fields: {} },
  // A device behind it that no package claims: the integration's generic socket.
  bridge: { fallback: 'tuya.plug' },
  describe: () => DESCRIPTION,
  connections: [
    {
      id: 'lan',
      label: 'Home network',
      description: 'Straight to the gateway on your home network, with no cloud. Needs its local key, once: signing in with Smart Life brings it.',
      protocol: 'tuya-local',
      transport: 'lan',
      reach: 'cloud-at-setup',
    },
  ],

  /** Talks to it once: its key proven, and the version it speaks. */
  async identify(connection, ctx) {
    const tuya = linkOver(connection, { log: (message) => ctx.log.info(message), gateway: { members: () => [] } });
    try {
      await tuya.open();
      const id = deviceIdOf(connection);
      return {
        identity: id ? tuyaIdentity(id) : null,
        model: null,
        summary: `Answering, Tuya ${tuya.version}: the Zigbee devices paired with it are found through it.`,
        info: { manufacturer: 'Tuya' },
      };
    } finally {
      await tuya.close();
    }
  },

  createSession: gatewaySession,
  createSimulator: async (ctx) => simulatedGateway(ctx),
});
