import {
  defineDeviceType,
  MAIN_PART,
  type ConfigSchema,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type DeviceType,
  type DeviceTypeMeta,
  type OpenConnection,
  type Reading,
  type SessionHealth,
  type ToolRun,
  type ToolSpec,
} from '@kraftverk/device-sdk';
import { decodeSocket, encodeSocket, linkOver, relayCandidates, tuyaIdentity, type Dps, type SocketProfile, type SocketReading } from '@kraftverk/protocol-tuya-local';

/**
 * A Tuya energy socket, as a device type: a relay and a meter, reached over the
 * home network with the Tuya local protocol.
 *
 * Every Tuya socket is the same device to kraftverk apart from its data layout,
 * so this builds a type from a profile — which is how the generic socket and a
 * named model are two types of ten lines each, and how the next plug is a profile
 * rather than code (docs/ATORCH-S1W.md §2).
 */

export type SocketTypeDefinition = {
  id: string;
  meta: Omit<DeviceTypeMeta, 'category' | 'icon'> & { icon?: string };
  /** The layouts this type knows. With more than one, setup asks which. */
  profiles: readonly SocketProfile[];
};

/**
 * What the relay does when power returns after a cut. A plug that feeds a
 * station's charger and comes back off can strand a flat battery with no way
 * to charge, so this is recorded from a real power-cut test, and `unknown` is
 * a value, not an omission.
 */
type BootBehaviour = 'on' | 'off' | 'last' | 'unknown';

type SocketConfig = {
  profile: string;
  relayDp?: number;
  bootBehaviour: BootBehaviour;
  pollSeconds: number;
};

/** A socket: one part, a relay it switches and a meter on what flows through it. */
const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Socket', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] }],
  attributes: [
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W', precision: 0 }, quantity: 'power', means: 'power.draw', category: 'primary' },
    { key: 'volts', label: 'Voltage', value: { type: 'number', unit: 'V', precision: 1 }, quantity: 'voltage', means: 'voltage.ac' },
    { key: 'amps', label: 'Current', value: { type: 'number', unit: 'A', precision: 2 }, quantity: 'current', means: 'current.ac' },
    { key: 'kwh', label: 'Energy', value: { type: 'number', unit: 'kWh', precision: 2 }, quantity: 'energy', means: 'energy.total', stateClass: 'total_increasing' },
    { key: 'hz', label: 'Frequency', value: { type: 'number', unit: 'Hz', precision: 1 }, quantity: 'frequency', means: 'frequency.ac', category: 'diagnostic' },
    {
      key: 'relay',
      label: 'Power',
      value: { type: 'boolean' },
      means: 'switch.on',
      consequence: 'Switches off whatever is plugged into it. If it feeds a station, the station then runs from its battery and solar.',
    },
  ],
};

const INTEGER = { type: 'number', integer: true } as const;

/** The plug's tools, as data: what the app draws and the contract checks. */
const TOOLS: Readonly<Record<string, ToolSpec>> = {
  datapoints: {
    label: 'Datapoints',
    description:
      'Every datapoint the plug reports, raw, with what its layout makes of them and which on/offs could be the relay. How a new plug’s layout is established: flip it at the wall, read again, see what moved.',
    writes: false,
    answer: {
      type: 'object',
      fields: {
        protocolVersion: { type: 'string' },
        profile: { type: 'string' },
        relayDp: INTEGER,
        raw: {
          type: 'list',
          of: {
            type: 'object',
            fields: { dp: INTEGER, kind: { type: 'enum', options: [{ value: 'boolean', label: 'On/off' }, { value: 'number', label: 'Number' }, { value: 'string', label: 'Text' }] }, value: { type: 'string' } },
            required: ['dp', 'kind', 'value'],
          },
        },
        decoded: {
          type: 'object',
          fields: {
            relayOn: { type: 'boolean' },
            watts: { type: 'number', unit: 'W' },
            volts: { type: 'number', unit: 'V' },
            amps: { type: 'number', unit: 'A' },
            kwh: { type: 'number', unit: 'kWh' },
            hz: { type: 'number', unit: 'Hz' },
            powerFactor: { type: 'number' },
          },
        },
        relayCandidates: { type: 'list', of: INTEGER },
      },
      required: ['protocolVersion', 'profile', 'relayDp', 'raw', 'decoded', 'relayCandidates'],
    },
  },
};

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

/** What was read, as the readings report it. */
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
  read: () => State;
  health: () => SessionHealth;
  set: (on: boolean) => Promise<void>;
  identity: string | null;
  tools?: Readonly<Record<string, ToolRun>>;
  close: () => Promise<void>;
}): DeviceSession {
  return {
    health: options.health,
    readings: () => readingsOf(options.read()),
    async command(request) {
      if (request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean') {
        return { accepted: false, error: `A socket takes no ${request.capability}.${request.command}` };
      }
      try {
        await options.set(request.args.on);
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    identity: () => ({ id: options.identity, name: null }),
    ...(options.tools ? { tools: options.tools } : {}),
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
    read: () => state,
    identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
    health: () => {
      const fresh = lastOk !== null && Date.now() - lastOk < pollMs * 2.5;
      return {
        status: fresh ? 'connected' : lastError ? (link.connected || connection.channel.connected ? 'error' : 'offline') : 'connecting',
        detail: fresh ? `Answering, Tuya ${link.version}` : (lastError ?? 'Connecting'),
        lastReadingAt: state?.at ?? null,
      };
    },
    set: async (on) => {
      if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
      const dps = await link.set({ [String(relayDp)]: on });
      if (Object.keys(dps).length) ingest(dps);
      else await poll();
    },
    tools: { datapoints: async () => datapointsAnswer(link.version, profile, relayDp, await link.status()) },
    close: () => link.close(),
  });
}

/** A plug that is not there: a relay, and a load that draws while it is on. */
/** What the datapoints tool answers: every datapoint raw, what the profile makes of them, and which on/offs could be the relay. */
function datapointsAnswer(protocolVersion: string, profile: SocketProfile, relayDp: number, dps: Dps) {
  const decoded = decodeSocket(profile, dps, relayDp);
  return {
    protocolVersion,
    profile: profile.id,
    relayDp,
    raw: Object.entries(dps).map(([dp, value]) => ({ dp: Number(dp), kind: typeof value, value: String(value) })),
    decoded: Object.fromEntries(Object.entries(decoded).map(([name, value]) => [name, value ?? null])),
    relayCandidates: relayCandidates(dps),
  };
}

function simulatedSession(ctx: DeviceContext<SocketConfig>, profiles: readonly SocketProfile[]): DeviceSession {
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
  const reading = () => ({ relayOn: on, watts: on ? watts : 0, volts: 230, amps: on ? Math.round((watts / 230) * 100) / 100 : 0, kwh: Math.round(kwh * 1000) / 1000, hz: 50 });
  const profile = profileOf(profiles, ctx.config.profile);
  const relayDp = ctx.config.relayDp ?? profile.relay.dp;
  return socketSession({
    read: () => ({ reading: reading(), at }),
    identity: 'tuya-local:SIMULATED',
    // Its datapoints as a plug of its profile would send them: the tool answers as it does for a real one.
    tools: { datapoints: async () => datapointsAnswer('simulated', profile, relayDp, encodeSocket(profile, reading(), relayDp)) },
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
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
    kind: 'hardware',
    meta: { icon: 'power', ...definition.meta, category: 'smart-plug' },
    config: configSchema(profiles),
    describe: () => DESCRIPTION,
    tools: TOOLS,
    connections: [
      {
        id: 'lan',
        label: 'Home network',
        description: 'Straight to the plug on your home network, with no cloud. Needs its local key, once.',
        protocol: 'tuya-local',
        transport: 'lan',
        // The local key comes from the Tuya cloud account the plug is paired with, once.
        reach: 'cloud-at-setup',
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
     * says. When it is not — a model whose relay is datapoint 131, not 1 — the
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
    createSimulator: async (ctx) => simulatedSession(ctx, profiles),
  });
}
