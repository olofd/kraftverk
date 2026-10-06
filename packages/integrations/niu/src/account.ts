import {
  defineDeviceType,
  identityOf,
  MAIN_PART,
  type BridgeHost,
  type ChannelMessage,
  type DeviceContext,
  type DeviceSession,
  type Member,
  type MessageChannel,
  type OpenConnection,
  type SessionHealth,
} from '@kraftverk/device-sdk';
import {
  accountIdentity,
  ASK,
  clientOver,
  decodeMessage,
  encodeMessage,
  NIU_API,
  NiuError,
  SAID,
  type MemberAsk,
  type MemberSaid,
  type NiuBatteryHealth,
  type NiuState,
  type NiuTotals,
  type NiuVehicle,
} from './protocol/index.ts';

import { SimulatedScooter } from './simulation.ts';

/**
 * A NIU account, as a device of its own (docs/PLAN-INTEGRATIONS.md §4.3): the
 * sign-in to NIU's cloud the NIU app uses, and a bridge to every scooter on
 * it. It signs in once — one account, one password, however many scooters —
 * asks NIU for each scooter someone has added, at that scooter's pace, and
 * tells each what is its own over a channel of its own. A scooter is then a
 * device reached through it (`./scooter.ts`).
 */

type Config = Record<string, never>;

/** How often each scooter is asked about while charging or switched on: a charge moves about 1 % in 3–4 minutes. */
const BUSY_EVERY_MS = 60_000;
/** Otherwise: an idle scooter's charge barely moves, and NIU is asked gently. */
const IDLE_EVERY_MS = 10 * 60_000;
/** Its batteries' health and its totals change slowly. */
const SLOW_EVERY_MS = 30 * 60_000;
/** Which scooters are on the account: a scooter bound or unbound in the NIU app is seen within this. */
const LIST_EVERY_MS = 30 * 60_000;
/** How often the account looks at what is due. */
const TICK_MS = 30_000;

/** What NIU says of one scooter, from wherever it is said: NIU's cloud, or a simulation. */
type Source = {
  state(serial: string): Promise<NiuState>;
  slow(serial: string): Promise<{ batteries: NiuBatteryHealth[]; totals: NiuTotals | null }>;
  raw(serial: string): Promise<Extract<MemberSaid, { kind: 'raw' }>>;
};

/** What the account keeps of each scooter on it, and who is listening. */
type Kept = {
  vehicle: NiuVehicle;
  said: Partial<Record<'state' | 'slow' | 'error', MemberSaid>>;
  askedAt: number;
  slowAt: number;
  listeners: Set<(message: MemberSaid) => void>;
};

const errorOf = (thrown: unknown) => (thrown instanceof NiuError ? thrown.message : `NIU could not be reached: ${(thrown as Error).message}`);

/**
 * The scooters on an account, and a channel to each — the account's bridge,
 * real or simulated alike: only where the figures come from differs.
 */
export class Scooters implements BridgeHost {
  #kept = new Map<string, Kept>();
  #changed = new Set<() => void>();

  constructor(private readonly source: Source) {}

  members(): Member[] {
    return [...this.#kept.values()].map(({ vehicle }) => ({ key: vehicle.serial, name: vehicle.name, model: vehicle.model, identity: identityOf('niu-cloud', vehicle.serial), typeId: null }));
  }

  onMembersChange(listener: () => void): () => void {
    this.#changed.add(listener);
    return () => this.#changed.delete(listener);
  }

  /** The account's list, as NIU gives it: scooters bound since are added, those unbound go. */
  listed(vehicles: readonly NiuVehicle[]): void {
    const before = [...this.#kept.keys()].sort().join();
    for (const vehicle of vehicles) {
      const kept = this.#kept.get(vehicle.serial);
      if (kept) kept.vehicle = vehicle;
      else this.#kept.set(vehicle.serial, { vehicle, said: {}, askedAt: 0, slowAt: 0, listeners: new Set() });
    }
    for (const serial of [...this.#kept.keys()]) if (!vehicles.some((vehicle) => vehicle.serial === serial)) this.#kept.delete(serial);
    if ([...this.#kept.keys()].sort().join() !== before) for (const listener of this.#changed) listener();
  }

  /** Asks NIU about each scooter someone listens to, when it is due; one that fails is told why, and the others carry on. */
  async poll(now = Date.now()): Promise<void> {
    await Promise.all([...this.#kept.keys()].map((serial) => this.#pollOne(serial, now)));
  }

  /** Every scooter someone listens to is told the account could not ask: signed out, or NIU not answering. */
  failed(error: string): void {
    for (const kept of this.#kept.values()) this.#say(kept, { kind: 'error', error });
  }

  async open(serial: string): Promise<MessageChannel> {
    const kept = this.#kept.get(serial);
    if (!kept) throw new Error('That scooter is no longer on the NIU account');
    const own = new Set<(message: ChannelMessage) => void>();
    const hear = (said: MemberSaid) => {
      const message: ChannelMessage = { topic: SAID, payload: encodeMessage(said), at: new Date().toISOString() };
      for (const listener of own) listener(message);
    };
    kept.listeners.add(hear);
    // Opened: asked about now, not at its next turn.
    kept.askedAt = 0;
    kept.slowAt = 0;
    void this.#pollOne(serial, Date.now());
    return {
      kind: 'messages',
      get connected() {
        return kept.said.error === undefined;
      },
      onConnectedChange: () => () => {},
      publish: async (topic, payload) => {
        if (topic !== ASK) return;
        const asked = decodeMessage<MemberAsk>(payload);
        if (asked.kind === 'raw') hear(await this.source.raw(serial).catch((thrown: unknown): MemberSaid => ({ kind: 'error', error: errorOf(thrown) })));
      },
      subscribe: (filter, listener) => {
        if (filter !== SAID) return () => {};
        own.add(listener);
        // What it knows already, at once: which scooter, and its last figures.
        queueMicrotask(() => {
          hear({ kind: 'vehicle', vehicle: kept.vehicle });
          for (const said of Object.values(kept.said)) if (said) hear(said);
        });
        return () => own.delete(listener);
      },
      close: async () => {
        own.clear();
        kept.listeners.delete(hear);
      },
    };
  }

  #say(kept: Kept, said: MemberSaid): void {
    if (said.kind === 'state' || said.kind === 'slow' || said.kind === 'error') kept.said[said.kind] = said;
    if (said.kind === 'state') delete kept.said.error;
    for (const listener of kept.listeners) listener(said);
  }

  async #pollOne(serial: string, now: number): Promise<void> {
    const kept = this.#kept.get(serial);
    if (!kept || !kept.listeners.size) return;
    const last = kept.said.state?.kind === 'state' ? kept.said.state.state : null;
    const busy = last?.charging === true || last?.poweredOn === true;
    try {
      if (now - kept.askedAt >= (busy ? BUSY_EVERY_MS : IDLE_EVERY_MS)) {
        kept.askedAt = now;
        this.#say(kept, { kind: 'state', state: await this.source.state(serial), answeredAt: new Date().toISOString() });
      }
      if (now - kept.slowAt >= SLOW_EVERY_MS) {
        kept.slowAt = now;
        const { batteries, totals } = await this.source.slow(serial);
        this.#say(kept, { kind: 'slow', batteries, totals, at: new Date().toISOString() });
      }
    } catch (thrown) {
      this.#say(kept, { kind: 'error', error: errorOf(thrown) });
    }
  }
}

const DESCRIPTION = {
  parts: [{ id: MAIN_PART, label: 'Account', kind: 'device' as const, icon: 'user' }],
  attributes: [{ key: 'scooters', label: 'Scooters on it', value: { type: 'number' as const, integer: true }, category: 'diagnostic' as const }],
};

/** The account's own session, over whatever its scooters are asked from, kept current on its own schedule. */
function session(ctx: DeviceContext<Config>, scooters: Scooters, list: () => Promise<NiuVehicle[]>, identity: string | null, via: string): DeviceSession {
  let listedAt = 0;
  let at: string | null = null;
  let error: string | null = null;
  const tick = async () => {
    try {
      if (Date.now() - listedAt >= LIST_EVERY_MS) {
        scooters.listed(await list());
        listedAt = Date.now();
      }
      await scooters.poll();
      at = new Date().toISOString();
      error = null;
    } catch (thrown) {
      error = errorOf(thrown);
      scooters.failed(error);
      ctx.log.warn(error);
    }
    ctx.changed();
  };
  ctx.schedule(TICK_MS, tick);
  void tick();
  return {
    health(): SessionHealth {
      if (error) return { status: 'error', detail: error, lastReadingAt: at };
      if (!at) return { status: 'connecting', detail: `Signing in ${via}`, lastReadingAt: null };
      const count = scooters.members().length;
      return { status: 'connected', detail: `${count === 1 ? '1 scooter' : `${count} scooters`} · ${via}`, lastReadingAt: at };
    },
    readings: () => (at ? [{ key: 'scooters', value: scooters.members().length, at }] : []),
    info: () => ({ manufacturer: 'NIU' }),
    identity: () => ({ id: identity, name: null }),
    command: async () => ({ accepted: false, error: 'An account takes no commands: its scooters are devices of their own' }),
    bridge: scooters,
    close: async () => undefined,
  };
}

/** NIU's cloud, signed into with the account: the figures each scooter on it is told. */
async function accountSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  if (!ctx.connection) throw new Error('A NIU account is reached through NIU’s cloud');
  const { client, account } = clientOver(ctx.connection);
  const scooters = new Scooters({
    state: (serial) => client.state(serial),
    slow: async (serial) => ({ batteries: await client.batteries(serial), totals: await client.totals(serial) }),
    raw: async (serial) => {
      const [{ data, from }, batteries, totals] = await Promise.all([
        client.stateRaw(serial),
        client.batteriesRaw(serial).catch((thrown: unknown) => ({ error: (thrown as Error).message })),
        client.totalsRaw(serial).catch((thrown: unknown) => ({ error: (thrown as Error).message })),
      ]);
      return { kind: 'raw', from, state: data, batteries, totals };
    },
  });
  return session(ctx, scooters, () => client.scooters(), accountIdentity(account), 'through NIU’s cloud');
}

/** An account with two scooters that are not there: each charging and riding by itself, told to whoever adds it. */
function simulatedAccount(ctx: DeviceContext<Config>): DeviceSession {
  const fleet = new Map([
    ['SIMULATED-NIU-1', { vehicle: { serial: 'SIMULATED-NIU-1', name: 'Scooter one', model: 'UQi-GT Citi Black (Matte)' }, scooter: new SimulatedScooter({ soc: 55, charging: true }) }],
    ['SIMULATED-NIU-2', { vehicle: { serial: 'SIMULATED-NIU-2', name: 'Scooter two', model: 'NIU scooter' }, scooter: new SimulatedScooter({ soc: 72, charging: false, odometer: 912.3 }) }],
  ]);
  const scooter = (serial: string) => {
    const found = fleet.get(serial)?.scooter;
    if (!found) throw new Error('No such scooter on the simulated account');
    return found;
  };
  ctx.schedule(60_000, () => {
    for (const { scooter: each } of fleet.values()) each.step();
  });
  const scooters = new Scooters({
    state: async (serial) => scooter(serial).state(),
    slow: async (serial) => ({ batteries: scooter(serial).batteries(), totals: scooter(serial).totals() }),
    raw: async (serial) => ({ kind: 'raw', from: 'simulated', state: scooter(serial).state(), batteries: scooter(serial).batteries(), totals: scooter(serial).totals() }),
  });
  return session(ctx, scooters, async () => [...fleet.values()].map(({ vehicle }) => vehicle), null, 'simulated: two scooters charging and riding by themselves');
}

export default defineDeviceType<Config>({
  id: 'niu.account',
  kind: 'account',
  meta: {
    name: 'NIU account',
    brand: 'NIU',
    category: 'account',
    icon: 'user',
    description: 'The account you use in the NIU app: signed in once, it finds every scooter on it, each added as a device of its own and read through it.',
    support: 'experimental',
    supportNote: 'Signs in the way the NIU app does, as others found it.',
  },
  config: { fields: {} },
  bridge: { fallback: 'niu.scooter' },
  describe: () => DESCRIPTION,
  connections: [
    {
      id: 'cloud',
      label: 'NIU’s cloud',
      description: 'Through NIU’s servers, with the account you use in the NIU app. Needs the internet: its scooters report to NIU over the mobile network.',
      protocol: 'niu-cloud',
      transport: 'https',
      address: NIU_API,
      reach: 'cloud',
      // NIU's cloud answers no browser's page: from a server or a phone, never a browser — a fact, apart from what it needs.
      platforms: ['system', 'native'],
      needs: { trusted: 'your NIU password stays at home' },
    },
  ],

  async identify(connection: OpenConnection) {
    const { client, account } = clientOver(connection);
    const scooters = await client.scooters();
    const names = scooters.map((scooter) => scooter.name ?? scooter.model ?? scooter.serial);
    return {
      identity: accountIdentity(account),
      model: null,
      summary: scooters.length ? `Signed in: ${names.join(', ')} ${scooters.length === 1 ? 'is' : 'are'} on it.` : 'Signed in, but there is no scooter on this account. Is it bound to it in the NIU app?',
      info: { manufacturer: 'NIU' },
    };
  },

  createSession: accountSession,
  createSimulator: async (ctx) => simulatedAccount(ctx),
});
