import { defineDeviceType, identityOf, MAIN_PART, type Bridge, type DeviceContext, type DeviceSession, type Member, type OpenConnection, type SessionHealth } from '@kraftverk/device-sdk';

import type { ScooterLink, ScooterRaw, ScooterReport, ScooterSlow } from './link.ts';
import { accountIdentity, clientOver, NIU_API, NiuError, type NiuBatteryHealth, type NiuState, type NiuTotals, type NiuVehicle } from './protocol/index.ts';

import { SimulatedScooter } from './simulation.ts';

/**
 * A NIU account, as a device of its own (docs/PLAN-INTEGRATIONS.md §4.3): the
 * sign-in to NIU's cloud the NIU app uses, and a bridge to every scooter on
 * it. It signs in once — one account, one password, however many scooters —
 * asks NIU for each scooter someone has added, at that scooter's pace, and
 * hands each a link to what is its own (`./link.ts`): plain calls, and one
 * function it calls back when that has moved. A scooter is then a device
 * reached through it (`./scooter.ts`).
 */

type Config = Record<string, never>;

/** How often each scooter is asked about while charging or switched on: a charge moves about 1 % in 3–4 minutes. */
export const BUSY_EVERY_MS = 60_000;
/** Otherwise: an idle scooter's charge barely moves, and NIU is asked gently. */
export const IDLE_EVERY_MS = 10 * 60_000;
/** Its batteries' health and its totals change slowly. */
export const SLOW_EVERY_MS = 30 * 60_000;
/** Which scooters are on the account: a scooter bound or unbound in the NIU app is seen within this. */
export const LIST_EVERY_MS = 30 * 60_000;
/** How often the account looks at what is due. */
const TICK_MS = 30_000;

/** What NIU says of one scooter, from wherever it is said: NIU's cloud, or a simulation. */
type Source = {
  state(serial: string): Promise<NiuState>;
  slow(serial: string): Promise<{ batteries: NiuBatteryHealth[]; totals: NiuTotals | null }>;
  raw(serial: string): Promise<ScooterRaw>;
};

/** What the account keeps of each scooter on it, and who is linked to it. */
type Kept = {
  vehicle: NiuVehicle;
  report: ScooterReport | null;
  slow: ScooterSlow | null;
  error: string | null;
  askedAt: number;
  slowAt: number;
  /** What each linked session gave to be told its scooter moved. */
  linked: Set<() => void>;
};

const errorOf = (thrown: unknown) => (thrown instanceof NiuError ? thrown.message : `NIU could not be reached: ${(thrown as Error).message}`);

/**
 * The scooters on an account, and a link to each — the account's bridge,
 * real or simulated alike: only where the figures come from differs.
 */
export class Scooters implements Bridge<ScooterLink> {
  #kept = new Map<string, Kept>();

  constructor(private readonly source: Source) {}

  members(): Member[] {
    return [...this.#kept.values()].map(({ vehicle }) => ({ key: vehicle.serial, name: vehicle.name, model: vehicle.model, identity: identityOf('niu-cloud', vehicle.serial), typeId: null }));
  }

  /** The account's list, as NIU gives it: scooters bound since are added, those unbound go. */
  listed(vehicles: readonly NiuVehicle[]): void {
    for (const vehicle of vehicles) {
      const kept = this.#kept.get(vehicle.serial);
      if (kept) kept.vehicle = vehicle;
      else this.#kept.set(vehicle.serial, { vehicle, report: null, slow: null, error: null, askedAt: 0, slowAt: 0, linked: new Set() });
    }
    for (const serial of [...this.#kept.keys()]) if (!vehicles.some((vehicle) => vehicle.serial === serial)) this.#kept.delete(serial);
  }

  /** Asks NIU about each scooter someone is linked to, when it is due; one that fails says why, and the others carry on. */
  async poll(now = Date.now()): Promise<void> {
    await Promise.all([...this.#kept.keys()].map((serial) => this.#pollOne(serial, now)));
  }

  /** Every scooter someone is linked to says the account could not ask: signed out, or NIU not answering. */
  failed(error: string): void {
    for (const kept of this.#kept.values()) this.#moved(kept, { error });
  }

  async link(serial: string, changed: () => void): Promise<ScooterLink> {
    const kept = this.#kept.get(serial);
    if (!kept) throw new Error('That scooter is no longer on the NIU account');
    kept.linked.add(changed);
    // Linked: asked about now, not at its next turn.
    kept.askedAt = 0;
    kept.slowAt = 0;
    void this.#pollOne(serial, Date.now());
    return {
      vehicle: () => kept.vehicle,
      report: () => kept.report,
      slow: () => kept.slow,
      error: () => kept.error,
      ask: async () => {
        try {
          const report = { state: await this.source.state(serial), answeredAt: new Date().toISOString() };
          kept.askedAt = Date.now();
          this.#moved(kept, { report, error: null });
          return report;
        } catch (thrown) {
          const error = errorOf(thrown);
          this.#moved(kept, { error });
          throw new Error(error);
        }
      },
      raw: () => this.source.raw(serial),
      close: () => void kept.linked.delete(changed),
    };
  }

  /** What the account now knows of a scooter, kept, and each linked session told. */
  #moved(kept: Kept, news: Partial<Pick<Kept, 'report' | 'slow' | 'error'>>): void {
    Object.assign(kept, news);
    for (const changed of kept.linked) changed();
  }

  async #pollOne(serial: string, now: number): Promise<void> {
    const kept = this.#kept.get(serial);
    if (!kept || !kept.linked.size) return;
    const busy = kept.report?.state.charging === true || kept.report?.state.poweredOn === true;
    try {
      if (now - kept.askedAt >= (busy ? BUSY_EVERY_MS : IDLE_EVERY_MS)) {
        kept.askedAt = now;
        this.#moved(kept, { report: { state: await this.source.state(serial), answeredAt: new Date().toISOString() }, error: null });
      }
      if (now - kept.slowAt >= SLOW_EVERY_MS) {
        kept.slowAt = now;
        const { batteries, totals } = await this.source.slow(serial);
        this.#moved(kept, { slow: { batteries, totals, at: new Date().toISOString() } });
      }
    } catch (thrown) {
      this.#moved(kept, { error: errorOf(thrown) });
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
      return { from, state: data, batteries, totals };
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
    raw: async (serial) => ({ from: 'simulated', state: scooter(serial).state(), batteries: scooter(serial).batteries(), totals: scooter(serial).totals() }),
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
