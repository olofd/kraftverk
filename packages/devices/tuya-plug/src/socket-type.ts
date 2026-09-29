import {
  defineDeviceType,
  type BootBehaviour,
  type CapabilityImpl,
  type CapabilityName,
  type ConfigSchema,
  type ConnectionHealth,
  type DeviceContext,
  type DeviceSession,
  type DeviceType,
  type DeviceTypeMeta,
  type MetricSpec,
  type OpenConnection,
  type Reading,
} from '@kraftverk/device-sdk';
import { decodeSocket, linkOver, relayCandidates, tuyaIdentity, type Dps, type SocketProfile, type SocketReading } from '@kraftverk/protocol-tuya-local';

/**
 * A Tuya energy socket, as a device type: a relay and a meter, reached over the
 * home network with the Tuya local protocol.
 *
 * Every Tuya socket is the same device to kraftverk apart from its data layout,
 * so this builds a type from a profile — which is how the generic socket and the
 * ATORCH S1W are two types of ten lines each, and how the next plug is a profile
 * rather than code (docs/ATORCH-S1W.md §2).
 */

export type SocketTypeDefinition = {
  id: string;
  meta: Omit<DeviceTypeMeta, 'category' | 'icon'> & { icon?: string };
  /** The layouts this type knows. With more than one, setup asks which. */
  profiles: readonly SocketProfile[];
};

type SocketConfig = {
  profile: string;
  relayDp?: number;
  bootBehaviour: BootBehaviour;
  pollSeconds: number;
};

const TELEMETRY: MetricSpec[] = [
  { key: 'watts', label: 'Power', unit: 'W', kind: 'power', metric: 'power.draw', precision: 0, primary: true },
  { key: 'volts', label: 'Voltage', unit: 'V', kind: 'voltage', metric: 'voltage.ac', precision: 1 },
  { key: 'amps', label: 'Current', unit: 'A', kind: 'current', metric: 'current.ac', precision: 2 },
  { key: 'kwh', label: 'Energy', unit: 'kWh', kind: 'energy', metric: 'energy.total', precision: 2, stateClass: 'total_increasing' },
  { key: 'hz', label: 'Frequency', unit: 'Hz', kind: 'frequency', metric: 'frequency.ac', precision: 1 },
  { key: 'relay', label: 'Relay', unit: '', kind: 'state', metric: 'switch.on' },
];

const CAPABILITIES = ['switch', 'powerMeter'] as const;

function configSchema(profiles: readonly SocketProfile[]): ConfigSchema {
  return {
    fields: {
      profile: {
        type: 'enum',
        title: 'Datapoint layout',
        description: 'Which datapoint is the relay, and what scale each measurement is sent in.',
        default: profiles[0]!.id,
        options: profiles.map((profile) => ({ value: profile.id, label: profile.label })),
      },
      relayDp: {
        type: 'number',
        title: 'Relay datapoint',
        description: 'When the plug’s relay is not on the layout’s usual datapoint. The check step works it out when it can.',
        integer: true,
        min: 1,
        max: 255,
      },
      bootBehaviour: {
        type: 'enum',
        title: 'After a power cut the relay comes back',
        description:
          'Establish this with a real power-cut test. A plug that comes back off can strand a flat station with no way to charge, so automation will not rely on one that is unknown.',
        default: 'unknown',
        options: [
          { value: 'unknown', label: 'Not tested yet' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
          { value: 'last', label: 'Last state' },
        ],
      },
      pollSeconds: { type: 'number', title: 'Poll interval', default: 10, min: 2, max: 300, unit: 's', integer: true },
    },
  };
}

const profileOf = (profiles: readonly SocketProfile[], id: unknown): SocketProfile =>
  profiles.find((profile) => profile.id === id) ?? profiles[0]!;

/** What was read, as the readings and capabilities report it. */
type State = { reading: SocketReading; at: string } | null;

function readingsOf(state: State): Reading[] {
  if (!state) return [];
  const { reading, at } = state;
  const value = (v: number | undefined) => (v === undefined ? null : v);
  return [
    { key: 'watts', value: value(reading.watts), at },
    { key: 'volts', value: value(reading.volts), at },
    { key: 'amps', value: value(reading.amps), at },
    { key: 'kwh', value: value(reading.kwh), at },
    { key: 'hz', value: value(reading.hz), at },
    { key: 'relay', value: reading.relayOn ?? null, at },
  ];
}

/** The session over a plug — real, or simulated behind the same shape. */
function socketSession(options: {
  bootBehaviour: BootBehaviour;
  read: () => State;
  health: () => ConnectionHealth;
  set: (on: boolean) => Promise<void>;
  identity: string | null;
  advanced?: DeviceSession['advanced'];
  close: () => Promise<void>;
}): DeviceSession {
  const switchImpl: CapabilityImpl['switch'] = {
    state: () => {
      const state = options.read();
      return state && state.reading.relayOn !== undefined ? { on: state.reading.relayOn, at: state.at } : null;
    },
    set: async (on) => {
      try {
        await options.set(on);
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    bootBehaviour: () => options.bootBehaviour,
  };
  const meter: CapabilityImpl['powerMeter'] = {
    read: () => {
      const state = options.read();
      if (!state) return null;
      const { reading, at } = state;
      return { watts: reading.watts ?? null, volts: reading.volts ?? null, amps: reading.amps ?? null, kwh: reading.kwh ?? null, hz: reading.hz ?? null, powerFactor: reading.powerFactor ?? null, at };
    },
  };
  const offered: Partial<CapabilityImpl> = { switch: switchImpl, powerMeter: meter };

  return {
    health: options.health,
    readings: () => readingsOf(options.read()),
    capability<N extends CapabilityName>(name: N) {
      return (offered[name] as CapabilityImpl[N] | undefined) ?? null;
    },
    identity: () => ({ id: options.identity, name: null }),
    advanced: options.advanced,
    close: options.close,
  };
}

async function realSession(ctx: DeviceContext<SocketConfig>, profiles: readonly SocketProfile[]): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (!connection) throw new Error('A plug session needs a connection');
  const profile = profileOf(profiles, ctx.config.profile);
  const relayDp = ctx.config.relayDp ?? profile.relay.dp;
  const link = linkOver(connection, (message) => ctx.log.info(message));

  let state: State = null;
  let lastRaw: Dps = {};
  let lastError: string | null = null;
  let lastOk: number | null = null;
  const pollMs = ctx.config.pollSeconds * 1000;

  const ingest = (dps: Dps) => {
    if (!Object.keys(dps).length) return;
    lastRaw = { ...lastRaw, ...dps };
    state = { reading: decodeSocket(profile, lastRaw, relayDp), at: new Date().toISOString() };
    lastOk = Date.now();
    lastError = null;
  };

  const poll = async () => {
    try {
      const dps = await link.status();
      // An empty reply is not a reading: recording it would refresh the
      // freshness clock with nothing behind it.
      if (!Object.keys(dps).length) throw new Error('The plug answered with no datapoints');
      ingest(dps);
    } catch (error) {
      // The last reading is left alone rather than zeroed: its time says how
      // old it is, and a stale value that says so beats an invented zero.
      lastError = (error as Error).message;
    }
  };
  ctx.schedule(pollMs, poll);
  // Not awaited: a plug that is unplugged must not stop its session opening.
  void poll();

  return socketSession({
    bootBehaviour: ctx.config.bootBehaviour,
    read: () => state,
    identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
    health: () => {
      const fresh = lastOk !== null && Date.now() - lastOk < pollMs * 2.5;
      return {
        status: fresh ? 'connected' : lastError ? (link.connected || connection.channel.connected ? 'error' : 'offline') : 'connecting',
        detail: fresh ? `Answering, Tuya ${link.version}` : (lastError ?? 'Connecting'),
        owner: 'server',
        transport: connection.transport,
        lastReadingAt: state?.at ?? null,
      };
    },
    set: async (on) => {
      if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
      ctx.emit({ level: 'info', message: `Relay ${on ? 'on' : 'off'}` });
      const dps = await link.set({ [String(relayDp)]: on });
      if (Object.keys(dps).length) ingest(dps);
      else await poll();
    },
    advanced: {
      /**
       * Every datapoint the plug reports, raw, with what the layout makes of
       * them and which booleans could be the relay. How a new plug's layout is
       * established: flip it at the wall, read again, see what moved.
       */
      datapoints: {
        writes: false,
        async run() {
          const dps = await link.status();
          return {
            protocolVersion: link.version,
            profile: profile.id,
            relayDp,
            raw: dps,
            decoded: decodeSocket(profile, dps, relayDp),
            relayCandidates: relayCandidates(dps),
          };
        },
      },
    },
    close: () => link.close(),
  });
}

/** A plug that is not there: a relay, and a load that draws while it is on. */
function simulatedSession(ctx: DeviceContext<SocketConfig>): DeviceSession {
  let on = ctx.store.get<boolean>('simulator.on') ?? true;
  let kwh = ctx.store.get<number>('simulator.kwh') ?? 0;
  let at = new Date().toISOString();
  const watts = 240;
  ctx.schedule(1000, () => {
    at = new Date().toISOString();
    if (on) {
      kwh += watts / 3_600_000;
      ctx.store.set('simulator.kwh', kwh);
    }
  });
  return socketSession({
    bootBehaviour: ctx.config.bootBehaviour,
    read: () => ({ reading: { relayOn: on, watts: on ? watts : 0, volts: 230, amps: on ? Math.round((watts / 230) * 100) / 100 : 0, kwh: Math.round(kwh * 1000) / 1000, hz: 50 }, at }),
    identity: 'tuya-local:SIMULATED',
    health: () => ({ status: 'connected', detail: 'Simulated', owner: 'server', transport: 'sim', lastReadingAt: at }),
    set: async (next) => {
      on = next;
      at = new Date().toISOString();
      ctx.store.set('simulator.on', on);
    },
    close: async () => undefined,
  });
}

export function defineTuyaSocket(definition: SocketTypeDefinition): DeviceType<SocketConfig> {
  const { profiles } = definition;
  return defineDeviceType<SocketConfig>({
    id: definition.id,
    apiVersion: '3',
    kind: 'hardware',
    meta: { icon: 'power', ...definition.meta, category: 'smart-plug' },
    capabilities: CAPABILITIES,
    telemetry: TELEMETRY,
    controls: [
      {
        id: 'relay',
        label: 'Power',
        kind: 'switch',
        capability: 'switch',
        measurementKey: 'relay',
        dangerous: true,
        consequence: 'Switches off whatever is plugged into it. If it feeds a station, the station then runs from its battery and solar.',
      },
    ],
    config: configSchema(profiles),
    connections: [
      {
        id: 'lan',
        label: 'Home network',
        description: 'Straight to the plug on your home network, with no cloud. Needs its local key, once.',
        protocol: 'tuya-local',
        transport: 'lan',
      },
    ],
    setup: {
      steps:
        profiles.length > 1
          ? [
              {
                id: 'layout',
                kind: 'form',
                target: 'device',
                title: 'Which socket is it?',
                description: 'The layout decides which datapoint is the relay. The check step tells you if it looks wrong.',
                schema: { fields: { profile: configSchema(profiles).fields.profile! } },
              },
            ]
          : [],
    },

    /**
     * Reads the plug once: who it is, and whether the relay is where the layout
     * says. When it is not — the ATORCH's datapoint 1 or 131 question — the
     * boolean that is there becomes the relay datapoint, and the check says so.
     */
    async identify(connection: OpenConnection, ctx) {
      const profile = profileOf(profiles, ctx.config.profile);
      const link = linkOver(connection, (message) => ctx.log.info(message));
      try {
        const dps = await link.status();
        const candidates = relayCandidates(dps);
        const relayDp = typeof dps[String(profile.relay.dp)] === 'boolean' ? profile.relay.dp : (candidates[0] ?? profile.relay.dp);
        const reading = decodeSocket(profile, dps, relayDp);
        const relay = reading.relayOn === undefined ? 'the relay could not be read' : `the relay is ${reading.relayOn ? 'on' : 'off'}`;
        const drawing = reading.watts === undefined ? '' : `, drawing ${Math.round(reading.watts)} W`;
        const moved = relayDp !== profile.relay.dp ? ` Its relay is datapoint ${relayDp}, not ${profile.relay.dp}.` : '';
        return {
          identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
          // A socket does not say what model it is; the layout is a guess the
          // relay check above confirms or corrects.
          model: null,
          summary: `Answering, Tuya ${link.version}: ${relay}${drawing}.${moved}`,
          ...(relayDp !== profile.relay.dp ? { config: { relayDp } } : {}),
        };
      } finally {
        await link.close();
      }
    },

    createSession: (ctx) => realSession(ctx, profiles),
    createSimulator: async (ctx) => simulatedSession(ctx),
  });
}
