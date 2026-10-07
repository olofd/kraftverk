import type { ScopedHttp } from '@kraftverk/device-sdk';

import { toHex } from './bytes.ts';
import { hmacSha256, sha256 } from '@kraftverk/device-sdk';

/**
 * Just enough of the Tuya Cloud API to fetch local keys.
 *
 * The local key is the one thing a plug will not tell you itself: it is set at
 * the factory and handed out only through Tuya's cloud, to the account the
 * device is paired with. So "no cloud" is true of everything kraftverk does at
 * runtime — and false, exactly once, when you first set a plug up.
 *
 * The whole protocol is an HMAC-SHA256 over a canonical string, documented at
 * https://developer.tuya.com/en/docs/iot/api-reference and implemented the same
 * way by tinytuya's Cloud.py, which this follows. The request itself goes out
 * through whatever `fetch` its caller hands it.
 */

/** Tuya's data centres. Pick the one you chose when creating the cloud project. */
export const REGIONS = {
  eu: { label: 'Central Europe', host: 'openapi.tuyaeu.com' },
  'eu-w': { label: 'Western Europe', host: 'openapi-weaz.tuyaeu.com' },
  us: { label: 'Western America', host: 'openapi.tuyaus.com' },
  'us-e': { label: 'Eastern America', host: 'openapi-ueaz.tuyaus.com' },
  cn: { label: 'China', host: 'openapi.tuyacn.com' },
  in: { label: 'India', host: 'openapi.tuyain.com' },
  sg: { label: 'Singapore', host: 'openapi-sg.iotbing.com' },
} as const;

export type Region = keyof typeof REGIONS;

export const isRegion = (value: string): value is Region => value in REGIONS;

const EMPTY_BODY_SHA256 = toHex(sha256(''));

/**
 * The canonical string Tuya signs.
 *
 * Order is load-bearing and unforgiving — a wrong signature comes back as a
 * flat "sign invalid" with no hint which part was wrong, which is why this is a
 * separate, tested function rather than inline string concatenation.
 */
export function stringToSign(method: string, path: string, bodyHash = EMPTY_BODY_SHA256): string {
  // METHOD \n sha256(body) \n signature-headers \n path-with-query
  return `${method.toUpperCase()}\n${bodyHash}\n\n${path}`;
}

export function signRequest(options: {
  clientId: string;
  secret: string;
  timestamp: number;
  method: string;
  path: string;
  /** Present for every call except the token request itself. */
  accessToken?: string;
  bodyHash?: string;
}): string {
  const { clientId, secret, timestamp, method, path, accessToken, bodyHash } = options;
  const payload = clientId + (accessToken ?? '') + String(timestamp) + stringToSign(method, path, bodyHash);
  return toHex(hmacSha256(secret, payload)).toUpperCase();
}

export type CloudDevice = {
  id: string;
  name: string;
  localKey: string;
  productName?: string;
  category?: string;
  ip?: string;
  online?: boolean;
  uid?: string;
  /** Reached through a gateway (Zigbee, Bluetooth): its local key is its gateway's. */
  sub?: boolean;
  /** Tuya's own identifier; for a Zigbee device, its Zigbee address. */
  uuid?: string;
};

type TuyaResponse<T> = { success: boolean; result?: T; msg?: string; code?: number };

export class TuyaCloudError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

export class TuyaCloud {
  #token: string | null = null;

  constructor(
    private region: Region,
    private clientId: string,
    private secret: string,
    private http: ScopedHttp
  ) {}

  get host(): string {
    return REGIONS[this.region].host;
  }

  async #call<T>(path: string): Promise<T> {
    const timestamp = Date.now();
    const headers: Record<string, string> = {
      client_id: this.clientId,
      sign_method: 'HMAC-SHA256',
      t: String(timestamp),
      sign: signRequest({
        clientId: this.clientId,
        secret: this.secret,
        timestamp,
        method: 'GET',
        path,
        accessToken: this.#token ?? undefined,
      }),
    };
    if (this.#token) headers.access_token = this.#token;

    const response = await this.http(`https://${this.host}${path}`, { headers, timeoutMs: 15_000 });
    if (!response.ok) throw new TuyaCloudError(`Tuya answered HTTP ${response.status} for ${path}`);

    const body = (await response.json()) as TuyaResponse<T>;
    if (!body.success || body.result === undefined) throw new TuyaCloudError(explain(body), body.code);
    return body.result;
  }

  /** Exchanges the project credentials for a short-lived access token. */
  async authenticate(): Promise<void> {
    const result = await this.#call<{ access_token: string }>('/v1.0/token?grant_type=1');
    this.#token = result.access_token;
  }

  /** One device, by id. Also the way to discover the owning account's uid. */
  async device(deviceId: string): Promise<CloudDevice> {
    const raw = await this.#call<{
      id: string;
      name: string;
      local_key: string;
      product_name?: string;
      category?: string;
      ip?: string;
      online?: boolean;
      uid?: string;
    }>(`/v1.0/devices/${encodeURIComponent(deviceId)}`);
    return {
      id: raw.id,
      name: raw.name,
      localKey: raw.local_key,
      productName: raw.product_name,
      category: raw.category,
      ip: raw.ip,
      online: raw.online,
      uid: raw.uid,
    };
  }

  /** Every device on an account, each with its local key. */
  async devicesOf(uid: string): Promise<CloudDevice[]> {
    const raw = await this.#call<
      { id: string; name: string; local_key: string; product_name?: string; category?: string; ip?: string; online?: boolean }[]
    >(`/v1.0/users/${encodeURIComponent(uid)}/devices`);
    return raw.map((device) => ({
      id: device.id,
      name: device.name,
      localKey: device.local_key,
      productName: device.product_name,
      category: device.category,
      ip: device.ip,
      online: device.online,
      uid,
    }));
  }

  /**
   * Every device the account owns, bootstrapped from one device id.
   *
   * Tuya has no "list my devices" call that works from credentials alone — the
   * project knows nothing about your app account until you name one device it
   * contains. So: look that one up, read the `uid` off it, then ask for
   * everything belonging to that user. The same trick the tinytuya and
   * tuya-cli wizards use.
   */
  async allDevices(seedDeviceId: string): Promise<CloudDevice[]> {
    const seed = await this.device(seedDeviceId);
    if (!seed.uid) return [seed];
    try {
      const all = await this.devicesOf(seed.uid);
      return all.length > 0 ? all : [seed];
    } catch {
      // The account listing can be refused while the single lookup works;
      // one key is still a successful outcome.
      return [seed];
    }
  }
}

/** Turns Tuya's terse error codes into something a person can act on. */
function explain(body: { msg?: string; code?: number }): string {
  const message = body.msg ?? 'unknown error';
  switch (body.code) {
    case 1004:
      return `${message} — the Access Secret does not match the Access ID, or the wrong data centre was selected.`;
    case 1106:
      return `${message} — permission denied. Is the device linked to this cloud project's app account?`;
    case 1114:
      return `${message} — your cloud project has no API subscription. Enable the "IoT Core" service for it.`;
    case 2007:
      return `${message} — this device id is not in the project's linked account.`;
    case 2009:
      return `${message} — check the Access ID, and that the data centre matches the one the cloud project was created in.`;
    case 28841002:
      return `${message} — the project's API trial has expired; renew it in the Tuya console.`;
    default:
      return `${message}${body.code ? ` (code ${body.code})` : ''}`;
  }
}
