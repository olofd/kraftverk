import {
  channelOf,
  defineDeviceType,
  directOf,
  distanceBetween,
  identityOf,
  MAIN_PART,
  needsSignIn,
  NotReachable,
  type Bridge,
  type DeviceContext,
  type DeviceSession,
  type Member,
  type OpenConnection,
  type SessionHealth,
} from '@kraftverk/device-sdk';

import type { FindMyLink } from './link.ts';
import { simulatedFamily } from './simulation.ts';
import { ICLOUD_WAYS } from './ways.ts';
import { accountIdentity, AppleRefused, FindMy, IcloudAuth, stateOf, trustUntil, type FoundDevice, type IcloudAccount } from './protocol/index.ts';

/**
 * An iCloud account, as a device of its own (docs/PLAN-INTEGRATIONS.md §4.3):
 * an Apple ID signed into as icloud.com is, and a bridge to every device in
 * its Find My — its family's included. It signs in once, asks Find My for
 * every device at once, and hands each device someone added a link to what
 * is its own (`./link.ts`). A device is then reached through it
 * (`./device.ts`).
 *
 * How often it asks follows Home Assistant's iCloud account: often while
 * someone is moving, rarely while everyone is still — asking has every
 * device located afresh, which costs their batteries.
 */

type Config = Record<string, never>;

/** While a device someone added is moving: a phone on its way home is seen within this. */
export const MOVING_EVERY_MS = 2 * 60_000;
/** While everyone is still, or nobody is added: asking locates every device, which costs batteries. */
export const STILL_EVERY_MS = 15 * 60_000;
/** A device that moved stays "moving" this long after it last did: a stop at a red light is not arriving. */
const MOVING_FOR_MS = 10 * 60_000;
/** How far a device must have gone, beyond how sure its position is, to have moved. */
const MOVED_METRES = 200;
/** At or below this charge, a moving device is asked half as often, as Home Assistant does. */
const LOW_BATTERY = 33;
/** While someone looks at a device of the account: where it is, every minute. Only its own page asks this, never the home screen. */
export const WATCHED_EVERY_MS = 60_000;
/** A person's "Locate now", or a page just opened, asks at once — unless the last ask is younger than this. */
const LOCATE_AGAIN_MS = 60_000;
/** How often the account looks at what is due: often enough for "every minute" to be about a minute. */
const TICK_MS = 15_000;
/** How soon an ask that failed is tried again, when Apple says nothing of when. */
const RETRY_MS = 60_000;

/** What Find My says, from wherever it is said: Apple, or a simulation. */
export type FindMySource = {
  devices(): Promise<FoundDevice[]>;
  playSound(id: string): Promise<void>;
  lostMode(id: string, options: { text: string; phone: string; passcode?: string }): Promise<void>;
};

const errorOf = (thrown: unknown) => (thrown instanceof AppleRefused || needsSignIn(thrown) ? (thrown as Error).message : `iCloud could not be reached: ${(thrown as Error).message}`);

/**
 * Find My's devices on an account, and a link to each — the account's
 * bridge, real or simulated alike: only where the devices come from differs.
 */
export class Family implements Bridge<FindMyLink> {
  #devices = new Map<string, FoundDevice>();
  #linked = new Map<string, Set<() => void>>();
  #answeredAt: string | null = null;
  #fetchedAt = 0;
  #error: string | null = null;
  #movingUntil = 0;
  /** The ask out now, when one is. */
  #asking: Promise<void> | null = null;
  /** Until when someone is looking at a device of it: asked every minute meanwhile. */
  #watchedUntil = 0;

  constructor(private readonly source: FindMySource) {}

  members(): Member[] {
    return [...this.#devices.values()].map((device) => ({ key: device.id, name: device.name, model: device.model, identity: identityOf('icloud-web', device.id), typeId: null, about: null, joining: false }));
  }

  /** How long until Find My is asked again: every minute while someone looks at a device, soon while one someone added moves, rarely otherwise. */
  interval(): number {
    if (Date.now() < this.#watchedUntil) return WATCHED_EVERY_MS;
    if (Date.now() >= this.#movingUntil) return STILL_EVERY_MS;
    const low = [...this.#linked.keys()].some((id) => {
      const battery = this.#devices.get(id)?.battery;
      return battery !== null && battery !== undefined && battery <= LOW_BATTERY;
    });
    return low ? MOVING_EVERY_MS * 2 : MOVING_EVERY_MS;
  }

  /**
   * Asks Find My when it is due, or now. One ask at a time: asked again while
   * one is out, the answer to that one is waited for. One that fails says why
   * to every device, and is tried at its next turn.
   */
  async poll(now = Date.now(), force = false): Promise<void> {
    if (this.#asking) return this.#asking;
    if (!force && now - this.#fetchedAt < this.interval()) return;
    this.#fetchedAt = now;
    this.#asking = (async () => {
      try {
        this.took(await this.source.devices(), now);
      } catch (thrown) {
        this.failed(errorOf(thrown));
        // Asked again when it says it may be — Apple busy for half an hour — or in a minute, not at the next quarter's turn.
        const retryMs = thrown instanceof NotReachable && thrown.retryAfterMs !== null ? thrown.retryAfterMs : RETRY_MS;
        this.#fetchedAt = now + retryMs - this.interval();
        throw thrown;
      }
    })().finally(() => {
      this.#asking = null;
    });
    return this.#asking;
  }

  /** Find My's list, as it answered: each device kept, whether one someone added moved noted, and each told. */
  took(devices: readonly FoundDevice[], now = Date.now()): void {
    for (const device of devices) {
      const before = this.#devices.get(device.id)?.location;
      const after = device.location;
      if (before && after && this.#linked.has(device.id)) {
        const sure = Math.max(before.accuracy ?? 0, after.accuracy ?? 0);
        if (distanceBetween(before, after) > MOVED_METRES + sure) this.#movingUntil = now + MOVING_FOR_MS;
      }
    }
    this.#devices = new Map(devices.map((device) => [device.id, device]));
    this.#answeredAt = new Date(now).toISOString();
    this.#error = null;
    for (const told of this.#linked.values()) for (const changed of told) changed();
  }

  /** Every device someone added says the account could not ask: signed out, or Apple not answering. */
  failed(error: string): void {
    this.#error = error;
    for (const told of this.#linked.values()) for (const changed of told) changed();
  }

  get answeredAt(): string | null {
    return this.#answeredAt;
  }

  async link(id: string, changed: () => void): Promise<FindMyLink> {
    // Opened before the account's first answer — a restart opens every device at once: that answer is waited for, not taken as "gone".
    if (this.#answeredAt === null) await this.poll(Date.now(), true).catch(() => undefined);
    if (this.#answeredAt === null) throw new Error(`Its account has not heard from Find My yet${this.#error ? `: ${this.#error}` : ''}`);
    if (!this.#devices.has(id)) throw new Error('That device is no longer in this account’s Find My');
    const told = this.#linked.get(id) ?? new Set();
    told.add(changed);
    this.#linked.set(id, told);
    return {
      device: () => this.#devices.get(id) ?? null,
      answeredAt: () => this.#answeredAt,
      error: () => this.#error,
      ask: async () => {
        await this.poll(Date.now(), true);
        const device = this.#devices.get(id);
        if (!device) throw new Error('That device is no longer in this account’s Find My');
        return device;
      },
      locate: async () => {
        if (Date.now() - this.#fetchedAt >= LOCATE_AGAIN_MS) await this.poll(Date.now(), true);
        const device = this.#devices.get(id);
        if (!device) throw new Error('That device is no longer in this account’s Find My');
        return device;
      },
      watch: (until) => {
        const sooner = until > this.#watchedUntil && this.#watchedUntil < Date.now();
        this.#watchedUntil = Math.max(this.#watchedUntil, until);
        if (!sooner) return;
        // Just opened: asked now, when the last answer is older than a minute — the page shows where it is, not where it was.
        if (Date.now() - this.#fetchedAt >= LOCATE_AGAIN_MS) void this.poll(Date.now(), true).catch(() => undefined);
        // Its schedule changed: said at once, not at the next ask.
        else for (const told of this.#linked.values()) for (const changed of told) changed();
      },
      schedule: () => ({
        nextAt: this.#fetchedAt ? new Date(this.#fetchedAt + this.interval()).toISOString() : null,
        everyMs: this.interval(),
        watched: Date.now() < this.#watchedUntil,
      }),
      playSound: () => this.source.playSound(id),
      lostMode: (options) => this.source.lostMode(id, options),
      close: () => {
        told.delete(changed);
        if (!told.size) this.#linked.delete(id);
      },
    };
  }
}

/** How long before its trust ends a sign-in that has not renewed itself says so: time to sign in again, at leisure. */
export const ENDING_WARNING_MS = 7 * 24 * 60 * 60_000;

const DESCRIPTION = {
  parts: [{ id: MAIN_PART, label: 'Account', kind: 'device' as const, icon: 'user' }],
  attributes: [
    { key: 'devices', label: 'Devices in Find My', value: { type: 'number' as const, integer: true }, category: 'diagnostic' as const },
    { key: 'signedInUntil', label: 'Signed in until', value: { type: 'timestamp' as const }, category: 'diagnostic' as const },
  ],
  events: [
    {
      id: 'sign-in-ending',
      label: 'Sign-in ending',
      level: 'warn' as const,
      description: 'Apple will ask for a code within a week, and renewing it with none has not worked: sign in again on the account’s page.',
    },
  ],
};

/** Signs in to iCloud with what a connection keeps: the Apple ID, its password, and the session Apple's sign-in made. */
export function icloudOver(connection: OpenConnection, trace?: (line: string) => void): { auth: IcloudAuth; appleId: string; password: string } {
  const channel = channelOf(connection, 'http', 'iCloud is reached over HTTPS');
  const { secrets } = directOf(connection, 'iCloud is reached over HTTPS');
  const appleId = String(connection.config.appleId ?? '').trim();
  const password = secrets.get('password');
  if (!appleId || !password) throw new Error('No Apple ID: give it and its password on the account’s connection');
  const auth = new IcloudAuth((url, init) => channel.fetch(url, init), stateOf(secrets.get('session')), (state) => secrets.set('session', JSON.stringify(state)), trace);
  return { auth, appleId, password };
}

/** How often the sign-in is looked at, between Find My's own asking: still held, and renewed when past half its trust. */
export const SIGN_IN_CHECK_MS = 6 * 60 * 60_000;

/**
 * Find My over a signed-in session: signed in again, with no person, when
 * iCloud ends the session — and looked at every `SIGN_IN_CHECK_MS`, so its
 * trust is renewed before it ends rather than after.
 */
function findMyOver(auth: IcloudAuth, appleId: string, password: string): { source: FindMySource; account: () => IcloudAccount | null } {
  let account: IcloudAccount | null = null;
  let findMy: FindMy | null = null;
  let checkedAt = 0;
  const signedIn = async (again: false | 'check' | 'fresh' = false): Promise<FindMy> => {
    if (findMy && !again && Date.now() - checkedAt < SIGN_IN_CHECK_MS) return findMy;
    try {
      account = await auth.resume(appleId, password, Date.now(), { fresh: again === 'fresh' });
    } catch (error) {
      // The six-hourly look failing for a moment — Apple not answering — is no reason to drop a session that works.
      if (findMy && !again && error instanceof NotReachable) {
        checkedAt = Date.now();
        return findMy;
      }
      throw error;
    }
    checkedAt = Date.now();
    findMy = new FindMy(auth, account);
    return findMy;
  };
  /*
    Once more when iCloud says the session is gone: looked at again (401,
    421), or — when Find My itself turned it away (450, 500) — signed in
    afresh with the password and the trust token, bound by the same waits.
  */
  const withSession = async <T>(call: (findMy: FindMy) => Promise<T>): Promise<T> => {
    try {
      return await call(await signedIn());
    } catch (error) {
      if (!(error instanceof AppleRefused) || ![401, 421, 450, 500].includes(error.status)) throw error;
      return call(await signedIn(error.status === 450 || error.status === 500 ? 'fresh' : 'check'));
    }
  };
  return {
    source: {
      devices: () => withSession((each) => each.devices()),
      playSound: (id) => withSession((each) => each.playSound(id)),
      lostMode: (id, options) => withSession((each) => each.lostMode(id, options)),
    },
    account: () => account,
  };
}

/** "3 Jan": a day, as the account's health says it. */
const dayOf = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The account's own session, over wherever Find My's devices come from,
 * kept current on its own schedule — saying until when Apple trusts its
 * sign-in, and, a week before that ends unrenewed, that a person should
 * sign in again (`sign-in-ending`, once a day).
 */
function session(ctx: DeviceContext<Config>, family: Family, identity: () => string | null, via: string, trusted: () => number | null = () => null): DeviceSession {
  let error: string | null = null;
  /** Why it waits on a person — a code Apple asks for again, its password refused — when it does: then it asks nothing, until it is signed in anew. */
  let needsYou: string | null = null;
  let warnedAt = 0;
  const tick = async () => {
    if (needsYou) return;
    try {
      await family.poll();
      error = null;
    } catch (thrown) {
      error = errorOf(thrown);
      if (needsSignIn(thrown)) needsYou = error;
      ctx.log.warn(error);
    }
    const until = trusted();
    const now = ctx.clock.now();
    if (until !== null && until - now < ENDING_WARNING_MS && now - warnedAt > 24 * 60 * 60_000) {
      warnedAt = now;
      ctx.event('sign-in-ending');
    }
    ctx.changed();
  };
  ctx.schedule(TICK_MS, tick);
  void tick();
  return {
    health(): SessionHealth {
      const at = family.answeredAt;
      if (needsYou) return { status: 'needs-you', detail: needsYou, lastReadingAt: at };
      if (error) return { status: 'error', detail: error, lastReadingAt: at };
      if (!at) return { status: 'connecting', detail: `Signing in ${via}`, lastReadingAt: null };
      const count = family.members().length;
      const until = trusted();
      return { status: 'connected', detail: `${count === 1 ? '1 device' : `${count} devices`} in Find My · ${via}${until !== null ? ` · signed in until ${dayOf(until)}` : ''}`, lastReadingAt: at };
    },
    readings: () => {
      if (!family.answeredAt) return [];
      const until = trusted();
      return [
        { key: 'devices', value: family.members().length, at: family.answeredAt },
        ...(until !== null ? [{ key: 'signedInUntil', value: new Date(until).toISOString(), at: family.answeredAt }] : []),
      ];
    },
    info: () => ({ manufacturer: 'Apple' }),
    identity: () => ({ id: identity(), name: null }),
    command: async () => ({ accepted: false, error: 'An account takes no commands: its devices are devices of their own' }),
    bridge: family,
    close: async () => undefined,
  };
}

async function accountSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  if (!ctx.connection) throw new Error('An iCloud account is reached through iCloud');
  const { auth, appleId, password } = icloudOver(ctx.connection, (line) => ctx.log.info(line));
  const { source, account } = findMyOver(auth, appleId, password);
  return session(
    ctx,
    new Family(source),
    () => {
      const signedIn = account();
      return signedIn ? accountIdentity(signedIn.dsid) : null;
    },
    'through iCloud',
    () => trustUntil(auth.state)
  );
}

/** An account with a family that is not there: one phone going out and back, one at home, a Mac that is not located. */
function simulatedAccount(ctx: DeviceContext<Config>): DeviceSession {
  const family = new Family(simulatedFamily(ctx));
  return session(ctx, family, () => null, 'simulated: a family, one of them out and back');
}

export default defineDeviceType<Config>({
  id: 'icloud.account',
  kind: 'account',
  meta: {
    name: 'iCloud account',
    brand: 'Apple',
    category: 'account',
    icon: 'cloud',
    description: 'Your Apple ID, signed into as icloud.com is: every device in its Find My — your family’s included — is found, each added as a device of its own, with where it is and how charged.',
    support: 'experimental',
    supportNote: 'Ported from Home Assistant’s iCloud integration; Apple changes its sign-in often.',
  },
  config: { fields: {} },
  bridge: { fallback: 'icloud.device' },
  simulation: {
    fields: {
      latitude: { type: 'number', title: 'Where the simulated family lives: latitude', default: 59.3, min: -90, max: 90 },
      longitude: { type: 'number', title: 'Where the simulated family lives: longitude', default: 18, min: -180, max: 180 },
    },
  },
  describe: () => DESCRIPTION,
  connections: ICLOUD_WAYS,

  async identify(connection: OpenConnection) {
    const { auth, appleId, password } = icloudOver(connection);
    let account: IcloudAccount;
    try {
      account = await auth.resume(appleId, password);
    } catch (error) {
      if (needsSignIn(error)) throw new Error('Apple asks for a code: go back, press "Sign in", and give it the code');
      throw error;
    }
    const devices = account.findMe ? await new FindMy(auth, account).devices() : [];
    const names = devices.map((device) => (device.owner ? `${device.name} (${device.owner})` : device.name));
    return {
      identity: accountIdentity(account.dsid),
      model: null,
      summary: devices.length ? `Signed in: ${names.join(', ')} ${devices.length === 1 ? 'is' : 'are'} in its Find My.` : 'Signed in, but there is nothing in this Apple ID’s Find My.',
      info: { manufacturer: 'Apple' },
    };
  },

  createSession: accountSession,
  createSimulator: async (ctx) => simulatedAccount(ctx),
});
