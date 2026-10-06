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
  cidOfAddress,
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
} from './protocol/index.ts';

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
  /**
   * `gateway`: a Zigbee socket, reached through the Tuya gateway it is paired
   * with — on the home network, with the gateway's key — rather than straight
   * to a plug on Wi-Fi. Its address is the gateway's, `#` its Zigbee address.
   */
  reached?: 'directly' | 'gateway';
  /** How often it is read, by default. A Zigbee socket is asked through its gateway, which asks it over Zigbee: less often. */
  pollSeconds?: number;
};

/** How each way in is offered. */
const METHODS = {
  directly: {
    label: 'Home network',
    description: 'Straight to the plug on your home network, with no cloud. Needs its local key, once.',
  },
  gateway: {
    label: 'Its Zigbee gateway',
    description:
      'Through the Tuya gateway it is paired with, on your home network, with no cloud. Needs the gateway’s key, once: signing in with Smart Life brings it with the plug.',
  },
} as const;

type SocketConfig = {
  profile: string;
  pollSeconds: number;
};

const METER: Readonly<Record<keyof SocketProfile['metrics'], AttributeSpec>> = {
  watts: { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W', precision: 0 }, quantity: 'power', means: 'power', category: 'primary' },
  volts: { key: 'volts', label: 'Voltage', value: { type: 'number', unit: 'V', precision: 1 }, quantity: 'voltage', means: 'voltage' },
  amps: { key: 'amps', label: 'Current', value: { type: 'number', unit: 'A', precision: 2 }, quantity: 'current', means: 'current' },
  kwh: { key: 'kwh', label: 'Energy', value: { type: 'number', unit: 'kWh', precision: 2 }, quantity: 'energy', means: 'energy', stateClass: 'total_increasing' },
  hz: { key: 'hz', label: 'Frequency', value: { type: 'number', unit: 'Hz', precision: 1 }, quantity: 'frequency', means: 'frequency', category: 'diagnostic' },
  powerFactor: { key: 'powerFactor', label: 'Power factor', value: { type: 'number', precision: 2, min: 0, max: 1 }, category: 'diagnostic' },
};

const RELAY: AttributeSpec = {
  key: 'relay',
  // "Switch", not "Power": power is what it draws.
  label: 'Switch',
  value: { type: 'boolean' },
  means: 'on',
  // What it feeds, when a link says so, the app adds from the link.
  consequence: 'Switches off whatever is plugged into it.',
};

/**
 * Live readings, for a plug whose profile has a fast refresh: wanted or not,
 * and until when. The wish is the session's — one for every screen and every
 * person — so switching it off switches it off, and no screen turns it back on.
 */
const LIVE: readonly AttributeSpec[] = [
  {
    key: 'live',
    label: 'Live readings',
    description: 'A reading every second instead of every few. It stays on for a quarter of an hour at a time, and a screen that shows it keeps it on while it is open.',
    value: { type: 'boolean' },
    access: 'write',
    category: 'diagnostic',
    history: false,
  },
  { key: 'liveUntil', label: 'Live until', value: { type: 'timestamp' }, category: 'diagnostic', history: false },
];

/** How long live readings stay wanted after they are asked for: long enough to change something and watch it land. */
const LIVE_LEASE_MS = 15 * 60_000;

/** While someone waits on its readings (`wantFresh`): asked this often… */
const FRESH_EVERY_MS = 2_000;
/** …for at most this long a time, whatever was asked. */
const FRESH_AT_MOST_MS = 5 * 60_000;

/**
 * Behind a gateway: how long a value the plug pushed outranks the gateway's
 * memory. A query is answered from memory at once, and that memory can lag a
 * push by a moment — a relay just switched on read back as off.
 */
const PUSH_OUTRANKS_MEMORY_MS = 5_000;

/** A profile datapoint as the attribute it is: the wire details left behind. */
const attributeOf = ({ dp: _dp, scale: _scale, wire: _wire, example: _example, raises: _raises, ...attribute }: ProfileDatapoint): AttributeSpec => attribute;

/** A socket: one part, a relay it switches, the meter its profile has, and the model's own datapoints. */
function describeSocket(profile: SocketProfile): DeviceDescription {
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
      ...(profile.refresh ? LIVE : []),
    ],
    ...(events.length ? { events } : {}),
  };
}

const INTEGER = { type: 'number', integer: true } as const;

/** The plug's tools, as data: what the app draws and the contract checks — the datapoints, and each profile's buttons. */
const toolsOf = (profiles: readonly SocketProfile[]): Readonly<Record<string, ToolSpec>> => ({
  ...TOOLS,
  ...Object.fromEntries(
    profiles.flatMap((profile) => profile.buttons ?? []).map((button) => [
      button.id,
      { label: button.label, description: button.description, writes: true, answer: { type: 'boolean' }, ...(button.confirm ? { confirm: button.confirm } : {}) } satisfies ToolSpec,
    ])
  ),
});

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

function configSchema(profiles: readonly SocketProfile[], pollSeconds = 10): ConfigSchema {
  return {
    fields: {
      profile: {
        type: 'enum',
        title: 'Datapoint layout',
        description: 'Which datapoint is the relay, what scale each measurement is sent in, and which settings the plug has.',
        default: profiles[0]!.id,
        options: profiles.map((profile) => ({ value: profile.id, label: profile.label })),
      },
      pollSeconds: { type: 'number', title: 'Poll interval', default: pollSeconds, min: 2, max: 300, unit: 's', integer: true },
    },
  };
}

const profileOf = (profiles: readonly SocketProfile[], id: unknown): SocketProfile =>
  profiles.find((profile) => profile.id === id) ?? profiles[0]!;

/**
 * Everything the plug has said, merged: a push carries only what changed.
 * `measuredAt`: behind a gateway, when the plug itself last measured each
 * metric's datapoint — pushed it, or a changed value came — by datapoint; a
 * gateway answering from its memory says nothing new of what flows now.
 */
type State = { dps: Dps; at: string; measuredAt?: Readonly<Record<string, string>> } | null;

function readingsOf(profile: SocketProfile, state: State, live: Live | null): Reading[] {
  if (!state) return [];
  const { dps, at } = state;
  // A metric as old as its measurement: behind a gateway, not refreshed by the gateway's memory of it.
  const measured = (name: keyof SocketProfile['metrics']) => state.measuredAt?.[String(profile.metrics[name]?.dp)] ?? at;
  const reading = decodeSocket(profile, dps);
  const value = (v: number | boolean | undefined): Value => (v === undefined ? null : v);
  const until = live?.until() ?? 0;
  /*
    Its relay open, nothing flows through its meter: no power, no current. A
    plug behind a gateway pushes the relay when it is switched off, but not
    the load falling to nothing — and the gateway answers from its memory of
    the last load (269 W on a plug switched off minutes before) until
    something has the plug measure again.
  */
  const open = reading.relayOn === false;
  const drawn = (name: keyof SocketProfile['metrics']) => open && (name === 'watts' || name === 'amps');
  return [
    ...(Object.keys(profile.metrics) as (keyof SocketProfile['metrics'])[]).map((name) => ({ key: name, value: drawn(name) ? 0 : value(reading[name]), at: drawn(name) ? at : measured(name) })),
    { key: 'relay', value: value(reading.relayOn), at },
    ...(profile.datapoints ?? []).map((point) => ({ key: point.key, value: datapointValue(point, dps), at })),
    ...(live
      ? [
          { key: 'live', value: until > Date.now(), at },
          { key: 'liveUntil', value: until > Date.now() ? new Date(until).toISOString() : null, at },
        ]
      : []),
  ];
}

/** Live readings, as a session keeps them: wanted until a time, and kept on until then. */
type Live = {
  until(): number;
  set(on: boolean): Promise<void>;
  /** What the plug said: a lapse it reports is renewed at once while live readings are wanted. */
  heard(dps: Dps): void;
};

/**
 * The fast refresh, kept on for as long as it is wanted. The plug turns it off
 * itself after a few minutes; while it is wanted, the session turns it back on
 * — when the plug says it lapsed, and on a timer in case the plug says
 * nothing. Unwanted, it is left to lapse, or turned off at once when asked.
 *
 * Kept by the session, not by any screen: one wish, which a person switching
 * it off ends everywhere. The wish itself arrives through the gateway, as a
 * write of `live`; turning the refresh back on is the session keeping its
 * readings flowing, like its heartbeat, and switches nothing a person uses.
 */
function liveOf(ctx: DeviceContext<SocketConfig>, refresh: NonNullable<SocketProfile['refresh']>, send: (dps: Dps) => Promise<void>, raw: () => Dps): Live {
  const dp = String(refresh.dp);
  let until = ctx.store.get<number>('live.until') ?? 0;
  const wanted = () => until > Date.now();
  // One renewal at a time, and not again straight after: the read that follows
  // a renewal may still show the lapse, and must not set off another.
  let renewing = false;
  let renewedAt = 0;
  const renew = () => {
    if (!wanted() || raw()[dp] === true || ctx.readOnly || renewing || Date.now() - renewedAt < 10_000) return;
    renewing = true;
    renewedAt = Date.now();
    send({ [dp]: true })
      .catch((error: unknown) => ctx.log.warn(`live readings: ${(error as Error).message}`))
      .finally(() => {
        renewing = false;
      });
  };
  // Often enough that a lapse is noticed within the plug's own refresh; the plug usually says so first.
  ctx.schedule(Math.min(30_000, refresh.lapsesAfterMs / 4), () => {
    if (until && !wanted()) {
      until = 0;
      ctx.store.set('live.until', 0);
      ctx.changed();
    }
    renew();
  });
  return {
    until: () => until,
    heard(dps) {
      if (dps[dp] === false) renew();
    },
    async set(on) {
      until = on ? Date.now() + LIVE_LEASE_MS : 0;
      ctx.store.set('live.until', until);
      await send({ [dp]: on });
      ctx.changed();
    },
  };
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
  /** Live readings, for a profile with a fast refresh. */
  live: Live | null;
  identity: string | null;
  tools?: Readonly<Record<string, ToolRun>>;
  /** Someone waits on its readings until then: a real plug is asked more often. */
  wantFresh?: (until: number) => void;
  close: () => Promise<void>;
}): DeviceSession {
  const { profile, live } = options;
  // A button is pressed by writing true to it: the plug acts, and says so.
  const buttons = Object.fromEntries(
    (profile.buttons ?? []).map((button): [string, ToolRun] => [
      button.id,
      async () => {
        await options.send({ [String(button.dp)]: true });
        return true;
      },
    ])
  );
  const session: DeviceSession = {
    health: options.health,
    readings: () => readingsOf(profile, options.read(), live),
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
    tools: { ...options.tools, ...buttons },
    ...(options.wantFresh ? { wantFresh: options.wantFresh } : {}),
    close: options.close,
  };
  if (writable(profile).size || live) {
    session.write = async (patch) => {
      const { live: wanted, ...settings } = patch;
      if (wanted !== undefined) {
        if (!live) throw new Error('This plug has no live readings');
        await live.set(wanted === true);
      }
      if (Object.keys(settings).length) await options.send(dpsOf(profile, settings));
      // What the plug reports now, not what was asked for: the gateway compares.
      const values = new Map(readingsOf(profile, options.read(), live).map((reading) => [reading.key, reading.value]));
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

  // Declared before it is defined: live readings send through it, and it reads what live readings heard.
  let live: Live | null = null;
  const behindGateway = cidOfAddress(connection.address) !== null;
  /** When the plug itself last said each datapoint. */
  const pushedAt = new Map<string, number>();
  /**
   * When the plug last measured each metric, behind a gateway: what it pushed,
   * or what an answer changed. The same value answered again is the gateway's
   * memory — after the gateway or the plug lost power, kept for as long as
   * nothing has the plug measure again (README.md) — so it does not make an
   * old measurement new.
   */
  const measuredAt: Record<string, string> = {};
  const metricDps = new Set(Object.values(profile.metrics).map((metric) => String(metric.dp)));
  /*
    What the meter reads at once — power, current, voltage, all but the
    energy count, which the plug pushes on its own. Behind a gateway a push
    of any of them is the plug having measured them all: the gateway pushes
    only what changed, so the rest measured the same. (A plug drawing nothing
    pushed its current flickering 0–30 mA every 2 s, and its 0 W stood
    "as of" half an hour before.)
  */
  const meterDps = new Set(
    (Object.entries(profile.metrics) as [keyof SocketProfile['metrics'], { dp: number } | undefined][])
      .filter(([name, metric]) => metric && name !== 'kwh')
      .map(([, metric]) => String(metric!.dp))
  );
  const ingest = (dps: Dps, pushed = false) => {
    if (!Object.keys(dps).length) return;
    const now = new Date().toISOString();
    if (behindGateway) {
      for (const [dp, value] of Object.entries(dps)) if (metricDps.has(dp) && (pushed || state?.dps[dp] !== value || !measuredAt[dp])) measuredAt[dp] = now;
      if (pushed && Object.keys(dps).some((dp) => meterDps.has(dp))) for (const dp of meterDps) measuredAt[dp] = now;
    }
    state = { dps: { ...state?.dps, ...dps }, at: now, ...(behindGateway ? { measuredAt: { ...measuredAt } } : {}) };
    lastOk = Date.now();
    lastError = null;
    raise(state.dps);
    live?.heard(dps);
  };

  // A plug tells of every change it sees — at the plug, from its maker's app, its own
  // protection — and, with fast refresh on, its readings every second.
  // Behind a gateway: the gateway saying it cannot reach the plug.
  let unreachable = false;
  const link = linkOver(connection, {
    log: (message) => ctx.log.info(message),
    onPush: (dps) => {
      unreachable = false;
      for (const dp of Object.keys(dps)) pushedAt.set(dp, Date.now());
      ingest(dps, true);
      ctx.changed();
    },
    onPresence: (online) => {
      unreachable = !online;
      ctx.changed();
    },
  });

  const metricsAsked = [...metricDps].map(Number);
  const poll = async () => {
    try {
      const dps = await link.status();
      /*
        Behind a gateway the answer is its memory, and the plug measures only
        when asked — a Zigbee plug's power stays what it was until then, for
        hours (README.md). So it is asked, after the answer: what changed comes
        as a push a moment later, dated as measured.
      */
      if (behindGateway) await link.refresh(metricsAsked);
      // An empty reply is not a reading: recording it would refresh the
      // freshness clock with nothing behind it.
      if (!Object.keys(dps).length) throw new Error('The plug answered with no datapoints');
      // Behind a gateway that says it cannot reach the plug, the answer is the gateway's memory, not the
      // plug's word: not taken, so its readings age as a silent plug's do. Its own pushes end that.
      if (unreachable) return;
      // What the plug pushed a moment ago is newer than the gateway's memory of it.
      if (behindGateway) for (const dp of Object.keys(dps)) if (Date.now() - (pushedAt.get(dp) ?? 0) < PUSH_OUTRANKS_MEMORY_MS) delete dps[dp];
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

  // Someone waits on its readings: asked every couple of seconds until then — never for long.
  let freshUntil = 0;
  ctx.schedule(FRESH_EVERY_MS, () => {
    if (Date.now() < freshUntil) void poll();
  });
  const wantFresh = (until: number) => {
    freshUntil = Math.max(freshUntil, Math.min(until, Date.now() + FRESH_AT_MOST_MS));
  };

  const send = async (dps: Dps) => {
    if (ctx.readOnly) throw new Error('Every hardware write is refused: this holder is read-only');
    ingest(await link.set(dps));
    // The answer to a set is often empty; what the plug reports now is the truth. Behind a gateway the plug
    // pushes it within a moment, and asking at once would only bring the gateway's memory of before.
    if (!behindGateway) await poll();
  };
  live = profile.refresh ? liveOf(ctx, profile.refresh, send, () => state?.dps ?? {}) : null;

  return socketSession({
    profile,
    read: () => state,
    live,
    identity: tuyaIdentity(String(connection.config.deviceId ?? '')),
    health: () => {
      if (unreachable) return { status: 'offline', detail: 'Its gateway cannot reach it: is it plugged in?', lastReadingAt: state?.at ?? null };
      const fresh = lastOk !== null && Date.now() - lastOk < pollMs * 2.5;
      return {
        status: fresh ? 'connected' : lastError ? (link.connected || connection.channel.connected ? 'error' : 'offline') : 'connecting',
        // Said for the page's header: the protocol version is the Datapoints tool's to show.
        detail: fresh ? 'Connected' : (lastError ?? 'Connecting'),
        lastReadingAt: state?.at ?? null,
      };
    },
    send,
    wantFresh,
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
  let at = new Date(ctx.clock.now()).toISOString();
  const watts = 240;
  ctx.schedule(1000, () => {
    at = new Date(ctx.clock.now()).toISOString();
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
  // A simulated fast refresh never lapses: it is on while it is wanted.
  let refreshing = false;
  const send = async (sent: Dps) => {
    const relay = String(profile.relay.dp);
    if (sent[relay] !== undefined) {
      on = sent[relay] === (profile.relay.on ?? true);
      ctx.store.set('simulator.on', on);
    }
    if (profile.refresh && sent[String(profile.refresh.dp)] !== undefined) refreshing = sent[String(profile.refresh.dp)] === true;
    for (const point of profile.datapoints ?? []) {
      const raw = sent[String(point.dp)];
      if (raw !== undefined) values[point.key] = datapointValue(point, { [String(point.dp)]: raw });
    }
    ctx.store.set('simulator.values', values);
    at = new Date(ctx.clock.now()).toISOString();
  };
  const live = profile.refresh ? liveOf(ctx, profile.refresh, send, () => ({ [String(profile.refresh!.dp)]: refreshing })) : null;
  return socketSession({
    profile,
    read: () => ({ dps: dps(), at }),
    live,
    identity: 'tuya-local:SIMULATED',
    tools: { datapoints: async () => datapointsAnswer('simulated', profile, dps()) },
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    send,
    close: async () => undefined,
  });
}

export function defineTuyaSocket(definition: SocketTypeDefinition): DeviceType<SocketConfig> {
  const { profiles } = definition;
  const reached = definition.reached ?? 'directly';
  return defineDeviceType<SocketConfig>({
    id: definition.id,
    kind: 'hardware',
    meta: { icon: 'power', ...definition.meta, category: 'smart-plug' },
    config: configSchema(profiles, definition.pollSeconds),
    describe: (config) => describeSocket(profileOf(profiles, config.profile)),
    tools: toolsOf(profiles),
    connections: [
      {
        id: 'lan',
        ...METHODS[reached],
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
          summary: `Answering${reached === 'gateway' ? ' through its gateway' : ''}, Tuya ${link.version}: ${relay}${drawing}.`,
        };
      } finally {
        await link.close();
      }
    },

    createSession: (ctx) => realSession(ctx, profiles),
    createSimulator: async (ctx) => simulatedSession(ctx, profiles),
  });
}
