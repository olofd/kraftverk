import { md5Hex } from './md5.ts';

/**
 * The NIU cloud, as the NIU app talks to it. Nothing here is documented by
 * NIU: it is what the app sends, as others read it before us — niu-charge,
 * the Home Assistant components, the ioBroker adapter, evcc (the package's
 * README names them and what each showed).
 *
 * Two hosts: one to sign in, one for everything else. Outside China the app
 * uses the `-fk` pair; the account decides nothing about which.
 */

export const NIU_ACCOUNT = 'https://account-fk.niu.com';
export const NIU_API = 'https://app-api-fk.niu.com';

/**
 * The app id the sign-in names. Each app version has had its own, and the
 * projects before us use different ones (`niu_ktdrr960`, `niu_8xt1afu6`,
 * `niu_fksss2ws`); NIU may retire any of them. One place to change.
 */
export const NIU_APP_ID = 'niu_ktdrr960';

/** How the app introduces itself; NIU answers in `lang`, and some calls want an app-like agent. */
export const niuUserAgent = (lang = 'en-US') => `manager/4.10.4 (android; kraftverk);lang=${lang};clientIdentifier=Overseas;ostype=android`;

/** Every answer comes in one envelope: status 0 is success. */
type Envelope<T> = { status?: number; desc?: string; trace?: string; data?: T };

/** The session has expired: sign in again. */
export const NIU_SESSION_EXPIRED = 1131;

export class NiuError extends Error {
  constructor(
    message: string,
    /** NIU's own status, when it gave one. */
    readonly status?: number,
    /** The HTTP status, when the answer never reached NIU's envelope. */
    readonly http?: number
  ) {
    super(message);
    this.name = 'NiuError';
  }

  /** Signed out: the token is no good, and signing in again may help. */
  get expired(): boolean {
    return this.status === NIU_SESSION_EXPIRED || this.http === 401;
  }
}

/** `fetch`, to an absolute URL on one of NIU's two hosts. */
export type NiuHttp = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

export type NiuTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, ms since the epoch; null when NIU did not say. */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
};

// --- reading what NIU says --------------------------------------------------------------

/** A number, however NIU sent it (it sends "95" as often as 95); null when it is none. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** An on/off, however NIU sent it: true, 1 or "1"; null when it is neither. */
export function booleanOf(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const number = numberOf(value);
  return number === 0 ? false : number === 1 ? true : null;
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * A time NIU gives, as ISO: epoch seconds or milliseconds, whichever it is.
 * Null when there is none — never "now", which would call an old report new.
 */
export function timeOf(value: unknown): string | null {
  const number = numberOf(value);
  if (number === null || number <= 0) return null;
  const ms = number < 1e12 ? number * 1000 : number;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** When a token expires, from what NIU gives: an epoch time, or seconds from now. */
function expiryOf(value: unknown, now: number): number | null {
  const number = numberOf(value);
  if (number === null || number <= 0) return null;
  if (number > 1e12) return number;
  if (number > 1e9) return number * 1000;
  return now + number * 1000;
}

/** A scooter on the account, as the list gives it. */
export type NiuVehicle = {
  /** Its serial: what every other call asks for. Some models give `sn_id` instead of `sn`. */
  serial: string;
  /** What its owner called it in the app. */
  name: string | null;
  /** What NIU calls the model, as its app shows it. */
  model: string | null;
};

export function parseScooters(data: unknown): NiuVehicle[] {
  const record = data as { items?: unknown } | null;
  const items = Array.isArray(data) ? data : Array.isArray(record?.items) ? record.items : [];
  return items.flatMap((item): NiuVehicle[] => {
    const raw = item as Record<string, unknown>;
    const serial = textOf(raw.sn) ?? textOf(raw.sn_id);
    if (!serial) return [];
    return [{ serial, name: textOf(raw.scooter_name) ?? textOf(raw.name), model: textOf(raw.sku_name) ?? textOf(raw.product_type) ?? textOf(raw.type) }];
  });
}

/** One of the scooter's batteries, by compartment, as the state gives it. */
export type NiuBatteryNow = { compartment: string; connected: boolean | null; soc: number | null };

/**
 * What the scooter last reported (`motor_data/index_info`). `at` is when the
 * scooter reported it, not when we asked: a scooter asleep reports seldom,
 * and its figures are as old as its last report.
 */
export type NiuState = {
  at: string | null;
  /** The charge across its batteries: the one there is, or the mean of those in. */
  soc: number | null;
  batteries: NiuBatteryNow[];
  charging: boolean | null;
  /** It reaches NIU: online. (Not a charger: `isConnected` is true on a scooter with none, README.md.) */
  online: boolean | null;
  /** Until full while charging, in minutes; null when not charging or not said. */
  minutesToFull: number | null;
  rangeKm: number | null;
  speedKmh: number | null;
  /** Its electronics are on: it can be ridden. */
  poweredOn: boolean | null;
  /** The anti-theft alarm is armed. */
  alarmArmed: boolean | null;
  /** Lock status as NIU gives it; what each value means on a model is still being mapped. */
  lockStatus: number | null;
  /** Mobile and satellite signal, in NIU's own bars. */
  gsm: number | null;
  gps: number | null;
  /** The control unit's own backup battery, in %. */
  controlUnitBattery: number | null;
};

const COMPARTMENTS = ['A', 'B', 'C'] as const;

export function parseState(data: unknown): NiuState {
  const raw = (data ?? {}) as Record<string, unknown>;
  const holders = (raw.batteries ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const batteries = COMPARTMENTS.flatMap((letter): NiuBatteryNow[] => {
    const battery = holders[`compartment${letter}`];
    if (!battery || typeof battery !== 'object') return [];
    return [{ compartment: letter, connected: booleanOf(battery.isConnected), soc: numberOf(battery.batteryCharging) }];
  });
  // A battery that says it is out does not count; one that does not say, does.
  const counted = batteries.filter((battery) => battery.connected !== false && battery.soc !== null);
  const soc = counted.length ? Math.round((counted.reduce((sum, battery) => sum + battery.soc!, 0) / counted.length) * 10) / 10 : null;
  const charging = booleanOf(raw.isCharging);
  const leftHours = numberOf(raw.leftTime);
  return {
    at: timeOf(raw.infoTimestamp) ?? timeOf(raw.time) ?? timeOf(raw.gpsTimestamp),
    soc,
    batteries,
    charging,
    online: booleanOf(raw.isConnected),
    // NIU says "hours to full" and sends a large number when it has none.
    minutesToFull: charging && leftHours !== null && leftHours >= 0 && leftHours < 100 ? Math.round(leftHours * 60) : null,
    rangeKm: numberOf(raw.estimatedMileage),
    speedKmh: numberOf(raw.nowSpeed),
    poweredOn: booleanOf(raw.isAccOn),
    alarmArmed: booleanOf(raw.isFortificationOn),
    lockStatus: numberOf(raw.lockStatus),
    gsm: numberOf(raw.gsm),
    gps: numberOf(raw.gps),
    controlUnitBattery: numberOf(raw.centreCtrlBattery),
  };
}

/** A battery's own health, from `motor_data/battery_info`. */
export type NiuBatteryHealth = {
  compartment: string;
  soc: number | null;
  temperature: number | null;
  /** NIU's grade of its health, in %. */
  health: number | null;
  /** Times fully charged. */
  cycles: number | null;
};

export function parseBatteries(data: unknown): NiuBatteryHealth[] {
  const raw = (data ?? {}) as Record<string, unknown>;
  const holders = (raw.batteries ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return COMPARTMENTS.flatMap((letter): NiuBatteryHealth[] => {
    const battery = holders[`compartment${letter}`];
    if (!battery || typeof battery !== 'object') return [];
    return [
      {
        compartment: letter,
        soc: numberOf(battery.batteryCharging),
        temperature: numberOf(battery.temperature),
        health: numberOf(battery.gradeBattery),
        cycles: numberOf(battery.chargedTimes),
      },
    ];
  });
}

/** Lifetime figures, from `motoinfo/overallTally`. */
export type NiuTotals = { odometerKm: number | null; daysOwned: number | null };

export const parseTotals = (data: unknown): NiuTotals => {
  const raw = (data ?? {}) as Record<string, unknown>;
  return { odometerKm: numberOf(raw.totalMileage), daysOwned: numberOf(raw.bindDaysCount) };
};

// --- asking ------------------------------------------------------------------------------

async function envelope<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new NiuError(`NIU answered HTTP ${response.status} to ${what}`, undefined, response.status);
  const body = (await response.json()) as Envelope<T>;
  if (body.status !== 0) {
    throw new NiuError(
      body.status === NIU_SESSION_EXPIRED ? 'Signed out by NIU: signing in again' : `NIU said no to ${what}: ${body.desc || body.trace || `status ${body.status}`}`,
      body.status
    );
  }
  return body.data as T;
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

const tokensOf = (data: unknown, now: number): NiuTokens => {
  const token = ((data as { token?: Record<string, unknown> } | null)?.token ?? {}) as Record<string, unknown>;
  const accessToken = textOf(token.access_token);
  if (!accessToken) throw new NiuError('NIU signed in, but gave no token');
  return {
    accessToken,
    refreshToken: textOf(token.refresh_token),
    expiresAt: expiryOf(token.token_expires_in, now),
    refreshExpiresAt: expiryOf(token.refresh_token_expires_in, now),
  };
};

/** Signs in with the NIU app's account: email or phone, and its password. */
export async function signIn(http: NiuHttp, account: string, password: string, now = Date.now()): Promise<NiuTokens> {
  const response = await http(`${NIU_ACCOUNT}/v3/api/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': niuUserAgent() },
    body: form({ account, password: md5Hex(password), grant_type: 'password', scope: 'base', app_id: NIU_APP_ID }),
    timeoutMs: 15_000,
  });
  try {
    return tokensOf(await envelope(response, 'the sign-in'), now);
  } catch (error) {
    // NIU says little about a wrong password; say what it most likely is.
    if (error instanceof NiuError && error.status !== undefined) throw new NiuError(`NIU did not accept that account and password (${error.message.replace(/^NIU said no to the sign-in: /, '')})`, error.status);
    throw error;
  }
}

/** A new access token for a refresh token, without the password. */
export async function refreshTokens(http: NiuHttp, refreshToken: string, now = Date.now()): Promise<NiuTokens> {
  const response = await http(`${NIU_ACCOUNT}/v3/api/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': niuUserAgent() },
    body: form({ refresh_token: refreshToken, grant_type: 'refresh_token', scope: 'base', app_id: NIU_APP_ID }),
    timeoutMs: 15_000,
  });
  return tokensOf(await envelope(response, 'renewing the sign-in'), now);
}

/** How long before it expires a token is renewed. */
const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * After a sign-in that failed, how long before the password is tried again —
 * longer each time: a password changed in NIU's app is not tried hundreds
 * of times an hour, which could have the account locked.
 */
const SIGN_IN_AGAIN_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * A signed-in conversation with the NIU cloud: it signs in when it must,
 * renews its token before it runs out — with the refresh token, else the
 * password — and, told by NIU it is signed out, signs in once more and asks
 * again. Tokens live only in memory: what is kept is the password, as the
 * connection's secret.
 */
export class NiuClient {
  #tokens: NiuTokens | null = null;
  /** A renewal under way: every call that needs one at once waits on the same. */
  #renewing: Promise<NiuTokens> | null = null;
  /** The last sign-in that failed, how often in a row, and until when it is not tried again. */
  #refused: { error: unknown; times: number; until: number } | null = null;

  constructor(
    private readonly http: NiuHttp,
    private readonly credentials: { account: string; password: string },
    private readonly now: () => number = Date.now
  ) {}

  get signedIn(): boolean {
    return this.#tokens !== null;
  }

  async #token(): Promise<string> {
    const tokens = this.#tokens;
    if (tokens && (tokens.expiresAt === null || tokens.expiresAt - this.now() > RENEW_BEFORE_MS)) return tokens.accessToken;
    this.#renewing ??= this.#renew(tokens).finally(() => (this.#renewing = null));
    return (await this.#renewing).accessToken;
  }

  async #renew(tokens: NiuTokens | null): Promise<NiuTokens> {
    const now = this.now();
    if (tokens?.refreshToken && (tokens.refreshExpiresAt === null || tokens.refreshExpiresAt > now)) {
      try {
        return (this.#tokens = await refreshTokens(this.http, tokens.refreshToken, now));
      } catch {
        // A refresh NIU no longer takes: the password, as at the start.
      }
    }
    // Refused a moment ago: said again, not asked again, until its wait is over.
    if (this.#refused && now < this.#refused.until) throw this.#refused.error;
    try {
      this.#tokens = await signIn(this.http, this.credentials.account, this.credentials.password, now);
      this.#refused = null;
      return this.#tokens;
    } catch (error) {
      const times = (this.#refused?.times ?? 0) + 1;
      this.#refused = { error, times, until: now + SIGN_IN_AGAIN_MS[Math.min(times, SIGN_IN_AGAIN_MS.length) - 1]! };
      throw error;
    }
  }

  /** One call, signed in; signed out by NIU on the way, it signs in again and asks once more. */
  async #ask<T>(what: string, request: (token: string) => Promise<Response>): Promise<T> {
    try {
      return await envelope<T>(await request(await this.#token()), what);
    } catch (error) {
      if (!(error instanceof NiuError) || !error.expired) throw error;
      this.#tokens = null;
      return envelope<T>(await request(await this.#token()), what);
    }
  }

  #headers(token: string, json = false): Record<string, string> {
    return { token, 'user-agent': niuUserAgent(), accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  #get<T>(path: string, what: string): Promise<T> {
    return this.#ask<T>(what, (token) => this.http(`${NIU_API}${path}`, { headers: this.#headers(token), timeoutMs: 15_000 }));
  }

  #post<T>(path: string, body: Record<string, unknown>, what: string): Promise<T> {
    return this.#ask<T>(what, (token) => this.http(`${NIU_API}${path}`, { method: 'POST', headers: this.#headers(token, true), body: JSON.stringify(body), timeoutMs: 15_000 }));
  }

  /** The scooters on the account. */
  async scooters(): Promise<NiuVehicle[]> {
    return parseScooters(await this.#get<unknown>('/v5/scooter/list', 'the list of your scooters'));
  }

  /**
   * What the scooter last reported, raw, and from which call: the app's v5
   * call, else the older v3 one — which of them a 2019 scooter answers is
   * still being learnt.
   */
  async stateRaw(serial: string): Promise<{ data: Record<string, unknown>; from: 'v5' | 'v3' }> {
    const sn = encodeURIComponent(serial);
    try {
      return { data: await this.#get<Record<string, unknown>>(`/v5/scooter/motor_data/index_info?sn=${sn}`, 'the state of the scooter'), from: 'v5' };
    } catch (error) {
      if (error instanceof NiuError && error.expired) throw error;
      return { data: await this.#get<Record<string, unknown>>(`/v3/motor_data/index_info?sn=${sn}`, 'the state of the scooter'), from: 'v3' };
    }
  }

  async state(serial: string): Promise<NiuState> {
    return parseState((await this.stateRaw(serial)).data);
  }

  async batteriesRaw(serial: string): Promise<Record<string, unknown>> {
    return this.#get<Record<string, unknown>>(`/v3/motor_data/battery_info?sn=${encodeURIComponent(serial)}`, 'its batteries');
  }

  async batteries(serial: string): Promise<NiuBatteryHealth[]> {
    return parseBatteries(await this.batteriesRaw(serial));
  }

  async totalsRaw(serial: string): Promise<Record<string, unknown>> {
    return this.#post<Record<string, unknown>>('/motoinfo/overallTally', { sn: serial }, 'its totals');
  }

  async totals(serial: string): Promise<NiuTotals> {
    return parseTotals(await this.totalsRaw(serial));
  }

  /** Its trips, newest first. Raw: what a trip carries on a model is still being mapped. */
  async tripsRaw(serial: string, count = 5): Promise<unknown> {
    return this.#post<unknown>('/v5/track/list/v2', { index: 0, pagesize: count, sn: serial }, 'its trips');
  }
}
