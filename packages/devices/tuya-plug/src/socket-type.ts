import {
  defineDeviceType,
  MAIN_PART,
  type AttributeSpec,
  type ConfigSchema,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type DeviceType,
  type DeviceTypeMeta,
  type EventSpec,
  type OpenConnection,
  type Reading,
  type SessionHealth,
  type ToolRun,
  type ToolSpec,
  type Value,
} from '@kraftverk/device-sdk';
import {
  datapointRaw,
  datapointValue,
  decodeSocket,
  encodeSocket,
  linkOver,
  relayDps,
  tuyaIdentity,
  type Dps,
  type ProfileDatapoint,
  type SocketProfile,
  type SocketReading,
} from '@kraftverk/protocol-tuya-local';

/**
 * A Tuya energy socket, as a device type: a relay and a meter, and whatever
 * settings and sensors its model adds, reached over the home network with the
 * Tuya local protocol.
 *
 * Every Tuya socket is the same device to kraftverk apart from its data layout,
 * so this builds a type from a profile — which is how the generic socket and a
 * named model are two types of a few lines each, and how the next plug is a
 * profile rather than code.
 */

export type SocketTypeDefinition = {
  id: string;
  meta: Omit<DeviceTypeMeta, 'category' | 'icon'> & { icon?: string };
  /** The layouts this type knows. With more than one, setup asks which. */
  profiles: readonly SocketProfile[];
};

type SocketConfig = {
  profile: string;
  pollSeconds: number;
};

const METER: Readonly<Record<keyof SocketProfile['metrics'], AttributeSpec>> = {
  watts: { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W', precision: 0 }, quantity: 'power', means: 'power.draw', category: 'primary' },
  volts: { key: 'volts', label: 'Voltage', value: { type: 'number', unit: 'V', precision: 1 }, quantity: 'voltage', means: 'voltage.ac' },
  amps: { key: 'amps', label: 'Current', value: { type: 'number', unit: 'A', precision: 2 }, quantity: 'current', means: 'current.ac' },
  kwh: { key: 'kwh', label: 'Energy', value: { type: 'number', unit: 'kWh', precision: 2 }, quantity: 'energy', means: 'energy.total', stateClass: 'total_increasing' },
  hz: { key: 'hz', label: 'Frequency', value: { type: 'number', unit: 'Hz', precision: 1 }, quantity: 'frequency', means: 'frequency.ac', category: 'diagnostic' },
  powerFactor: { key: 'powerFactor', label: 'Power factor', value: { type: 'number', precision: 2, min: 0, max: 1 }, category: 'diagnostic' },
};

const RELAY: AttributeSpec = {
  key: 'relay',
  label: 'Power',
  value: { type: 'boolean' },
  means: 'switch.on',
  consequence: 'Switches off whatever is plugged into it. If it feeds a station, the station then runs from its battery and solar.',
};

/** A profile datapoint as the attribute it is: the wire details left behind. */
const attributeOf = ({ dp: _dp, scale: _scale, wire: _wire, example: _example, raises: _raises, ...attribute }: ProfileDatapoint): AttributeSpec => attribute;

/** A socket: one part, a relay it switches, the meter its profile has, and the model's own datapoints. */
export function describeSocket(profile: SocketProfile): DeviceDescription {
  const events: EventSpec[] = [];
  for (const point of profile.datapoints ?? []) {
    if (!point.raises || point.value.type !== 'enum') continue;
    events.push({ id: point.raises.event, label: point.raises.label, level: point.raises.level, data: { reason: point.value } });
  }
  return {
    parts: [{ id: MAIN_PART, label: 'Socket', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] }],
    attributes: [
      ...(Object.keys(METER) as (keyof SocketProfile['metrics'])[]).filter((name) => profile.metrics[name]).map((name) => METER[name]),
      RELAY,
      ...(profile.datapoints ?? []).map(attributeOf),
    ],
    ...(events.length ? { events } : {}),
  };
}

const INTEGER = { type: 'number', integer: true } as const;

/** The plug's tools, as data: what the app draws and the contract checks. */
const TOOLS: Readonly<Record<string, ToolSpec>> = {
  datapoints: {
    label: 'Datapoints',
    description:
      'Every datapoint the plug reports, raw, beside what its layout makes of them. How a new plug’s layout is established: change one thing in the maker’s app, read again, see what moved.',
    writes: false,
    answer: {
      type: 'object',
      fields: {
        protocolVersion: { type: 'string' },
        profile: { type: 'string' },
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
      },
      required: ['protocolVersion', 'profile', 'raw', 'decoded'],
    },
  },
};

function configSchema(profiles: readonly SocketProfile[]): ConfigSchema {
  return {
    fields: {
      profile: {
        type: 'enum',
        title: 'Datapoint layout',
        description: 'Which datapoint is the relay, what scale each measurement is sent in, and which settings the plug has.',
        default: profiles[0]!.id,
        options: profiles.map((profile) => ({ value: profile.id, label: profile.label })),
      },
      pollSeconds: { type: 'number', title: 'Poll interval', default: 10, min: 2, max: 300, unit: 's', integer: true },
    },
  };
}

const profileOf = (profiles: readonly SocketProfile[], id: unknown): SocketProfile =>
  profiles.find((profile) => profile.id === id) ?? profiles[0]!;

/** Everything the plug has said, merged: a push carries only what changed. */
type State = { dps: Dps; at: string } | null;

function readingsOf(profile: SocketProfile, state: State): Reading[] {
  if (!state) return [];
  const { dps, at } = state;
  const reading = decodeSocket(profile, dps);
  const value = (v: number | boolean | undefined): Value => (v === undefined ? null : v);
  return [
    ...(Object.keys(profile.metrics) as (keyof SocketProfile['metrics'])[]).map((name) => ({ key: name, value: value(reading[name]), at })),
    { key: 'relay', value: value(reading.relayOn), at },
    ...(profile.datapoints ?? []).map((point) => ({ key: point.key, value: datapointValue(point, dps), at })),
  ];
}

const writable = (profile: SocketProfile) => new Map((profile.datapoints ?? []).filter((point) => point.access === 'write').map((point) => [point.key, point]));

/** The datapoints a patch of writable attributes is sent as. */
function dpsOf(profile: SocketProfile, patch: Readonly<Record<string, Value>>): Dps {
  const points = writable(profile);
  const dps: Dps = {};
  for (const [key, value] of Object.entries(patch)) {
    const point = points.get(key);
    if (!point) throw new Error(`The plug has no setting ${key}`);
    dps[String(point.dp)] = datapointRaw(point, value);
  }
  return dps;
}

/** The session over a plug — real, or simulated behind the same shape. */
function socketSession(options: {
  profile: SocketProfile;
  read: () => State;
  health: () => SessionHealth;
  send: (dps: Dps) => Promise<void>;
  identity: string | null;
  tools?: Readonly<Record<string, ToolRun>>;
  close: () => Promise<void>;
}): DeviceSession {
  const { profile } = options;
  const session: DeviceSession = {
    health: options.health,
    readings: () => readingsOf(profile, options.read()),
    async command(request) {
      if (request.capability !== 'switch' || request.command !== 'set' || typeof request.args.on !== 'boolean') {
        return { accepted: false, error: `A socket takes no ${request.capability}.${request.command}` };
      }
      try {
        await options.send(relayDps(profile.relay, request.args.on));
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    identity: () => ({ id: options.identity, name: null }),
    ...(options.tools ? { tools: options.tools } : {}),
    close: options.close,
  };
  if (writable(profile).size) {
    session.write = async (patch) => {
      await options.send(dpsOf(profile, patch));
      // What the plug reports now, not what was asked for: the gateway compares.
      const values = new Map(readingsOf(profile, options.read()).map((reading) => [reading.key, reading.value]));
      return Object.fromEntries(Object.keys(patch).map((key) => [key, values.get(key) ?? null]));
    };
  }
  return session;
}

/** Raises a profile's events as the datapoints that carry them change: a trip, a mode that cut the relay. */
function eventsFrom(profile: SocketProfile, ctx: DeviceContext<SocketConfig>) {
  const last = new Map<string, Value>();
  return (dps: Dps) => {
    for (const point of profile.datapoints ?? []) {
      if (!point.raises || dps[String(point.dp)] === undefined) continue;
      const value = datapointValue(point, dps);
      const before = last.get(point.key);
      last.set(point.key, value);
      // The first reading is what was already so, not something happening now.
      if (before === undefined || value === before || value === null || value === point.raises.clear) continue;
      ctx.event(point.raises.event, { reason: value });
    }
  };
}

async function realSession(ctx: DeviceContext<SocketConfig>, profiles: readonly SocketProfile[]): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (!connection) throw new Error('A plug session needs a connection');
  const profile = profileOf(profiles, ctx.config.profile);
  const raise = eventsFrom(profile, ctx);

  let state: State = null;
  let lastError: string | null = null;
  let lastOk: number | null = null;
  const pollMs = ctx.config.pollSeconds * 1000;

  const ingest = (dps: Dps) => {
    if (!Object.keys(dps).length) return;
    state = { dps: { ...state?.dps, ...dps }, at: new Date().toISOString() };
    lastOk = Date.now();
    lastError = null;
    raise(state.dps);
  };

  // A plug tells of every change it sees — at the plug, from its maker's app, its own
  // protection — and, with fast refresh on, its readings every second.
  const link = linkOver(connection, {
    log: (message) => ctx.log.info(message),
    onPush: (dps) => {
      ingest(dps);
      ctx.changed();
    },
  });

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
    profile,
    read: () => state,
    identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
    health: () => {
      const fresh = lastOk !== null && Date.now() - lastOk < pollMs * 2.5;
      return {
        status: fresh ? 'connected' : lastError ? (link.connected || connection.channel.connected ? 'error' : 'offline') : 'connecting',
        // Said for the page's header: the protocol version is the Datapoints tool's to show.
        detail: fresh ? 'Connected' : (lastError ?? 'Connecting'),
        lastReadingAt: state?.at ?? null,
      };
    },
    send: async (dps) => {
      if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
      ingest(await link.set(dps));
      // The answer to a set is often empty; what the plug reports now is the truth.
      await poll();
    },
    tools: { datapoints: async () => datapointsAnswer(link.version, profile, await link.status()) },
    close: () => link.close(),
  });
}

/** What the datapoints tool answers: every datapoint raw, and what the profile makes of them. */
function datapointsAnswer(protocolVersion: string, profile: SocketProfile, dps: Dps) {
  const decoded = decodeSocket(profile, dps);
  return {
    protocolVersion,
    profile: profile.id,
    raw: Object.entries(dps).map(([dp, value]) => ({ dp: Number(dp), kind: typeof value, value: String(value) })),
    decoded: Object.fromEntries(Object.entries(decoded).map(([name, value]) => [name, value ?? null])),
  };
}

/** A plug that is not there: a relay, a load that draws while it is on, and settings that keep what they are told. */
function simulatedSession(ctx: DeviceContext<SocketConfig>, profiles: readonly SocketProfile[]): DeviceSession {
  const profile = profileOf(profiles, ctx.config.profile);
  let on = ctx.store.get<boolean>('simulator.on') ?? true;
  let kwh = ctx.store.get<number>('simulator.kwh') ?? 0;
  const values: Record<string, Value> = ctx.store.get<Record<string, Value>>('simulator.values') ?? {};
  let at = new Date().toISOString();
  const watts = 240;
  ctx.schedule(1000, () => {
    at = new Date().toISOString();
    if (on) {
      kwh += watts / 3_600_000;
      ctx.store.set('simulator.kwh', kwh);
    }
  });
  const reading = (): SocketReading => ({
    relayOn: on,
    watts: on ? watts : 0,
    volts: 230,
    amps: on ? Math.round((watts / 230) * 100) / 100 : 0,
    kwh: Math.round(kwh * 1000) / 1000,
    hz: 50,
    powerFactor: on ? 0.98 : 0,
  });
  // Its datapoints as a plug of its profile would send them, so it reads exactly as a real one.
  const dps = () => encodeSocket(profile, reading(), values);
  return socketSession({
    profile,
    read: () => ({ dps: dps(), at }),
    identity: 'tuya-local:SIMULATED',
    tools: { datapoints: async () => datapointsAnswer('simulated', profile, dps()) },
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    send: async (sent) => {
      const relay = String(profile.relay.dp);
      if (sent[relay] !== undefined) {
        on = sent[relay] === (profile.relay.on ?? true);
        ctx.store.set('simulator.on', on);
      }
      for (const point of profile.datapoints ?? []) {
        const raw = sent[String(point.dp)];
        if (raw !== undefined) values[point.key] = datapointValue(point, { [String(point.dp)]: raw });
      }
      ctx.store.set('simulator.values', values);
      at = new Date().toISOString();
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
    describe: (config) => describeSocket(profileOf(profiles, config.profile)),
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
                description: 'The layout decides which datapoint is the relay and which settings the plug has. The check step reads it back.',
                schema: { fields: { profile: configSchema(profiles).fields.profile! } },
              },
            ]
          : [],
    },

    /** Reads the plug once: who it is, and what its layout makes of it. */
    async identify(connection: OpenConnection, ctx) {
      const profile = profileOf(profiles, ctx.config.profile);
      const link = linkOver(connection, { log: (message) => ctx.log.info(message) });
      try {
        const reading = decodeSocket(profile, await link.status());
        const relay = reading.relayOn === undefined ? 'the relay could not be read' : `the relay is ${reading.relayOn ? 'on' : 'off'}`;
        const drawing = reading.watts === undefined ? '' : `, drawing ${Math.round(reading.watts)} W`;
        return {
          identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
          // A socket does not say what model it is; the layout is the person's choice.
          model: null,
          summary: `Answering, Tuya ${link.version}: ${relay}${drawing}.`,
        };
      } finally {
        await link.close();
      }
    },

    createSession: (ctx) => realSession(ctx, profiles),
    createSimulator: async (ctx) => simulatedSession(ctx, profiles),
  });
}
