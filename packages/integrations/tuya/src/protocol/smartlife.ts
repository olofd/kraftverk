import type { ScopedHttp } from '@kraftverk/device-sdk';

import { concat, text, toHex, utf8 } from './bytes.ts';
import { aesGcmDecrypt, aesGcmEncrypt } from './crypto/aes.ts';
import { hmacSha256, md5 } from '@kraftverk/device-sdk';
import type { CloudDevice } from './cloud.ts';

/**
 * Local keys through the Smart Life app's own login: no IoT Platform project,
 * no subscription to lapse.
 *
 * Home Assistant's Tuya integration signs in this way. You type the "User Code"
 * from the app (Me → Settings → Account and Security), scan a QR code with the
 * same app, and get a token for your own account; the device list it opens
 * carries each device's `local_key`. The Tuya Local integration fetches keys the
 * same way.
 *
 * The client id and schema are the ones Tuya issued to Home Assistant — this
 * login exists for it, and there is no way to register another. So the phone
 * asks you to authorise "Home Assistant". The token is used for the one listing
 * and never kept.
 *
 * Follows tuya-device-sharing-sdk (the Python library behind Home Assistant's
 * integration): the login calls are plain; everything after is AES-GCM
 * encrypted both ways and HMAC-signed, with a key derived per request.
 */

const LOGIN_HOST = 'https://apigw.iotbing.com';
const CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
const SCHEMA = 'haauthorize';

/** What the app's scanner must read to offer the login. */
export const qrLoginContent = (token: string): string => `tuyaSmart--qrLogin?token=${token}`;

export type SmartLifeSession = {
  accessToken: string;
  refreshToken: string;
  /** The data centre's API gateway, as Tuya hands it back — e.g. https://apigw.tuyaeu.com */
  endpoint: string;
  uid: string;
};

export class SmartLifeError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

type Envelope<T> = { success: boolean; result?: T; msg?: string; code?: number };

const query = (params: Record<string, string>): string => new URLSearchParams(params).toString();

async function json<T>(response: Response, what: string): Promise<Envelope<T>> {
  if (!response.ok) throw new SmartLifeError(`Tuya answered HTTP ${response.status} for ${what}`);
  return (await response.json()) as Envelope<T>;
}

/**
 * Starts a login: the token to put in the QR code. Refused when the user code
 * is wrong — it is per account, and changes if you ask the app for a new one.
 */
export async function requestQrToken(http: ScopedHttp, userCode: string): Promise<string> {
  const params = query({ clientid: CLIENT_ID, usercode: userCode, schema: SCHEMA });
  const body = await json<{ qrcode: string }>(
    await http(`${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens?${params}`, { method: 'POST', timeoutMs: 15_000 }),
    'the QR code'
  );
  if (!body.success || !body.result?.qrcode) {
    throw new SmartLifeError(`${body.msg ?? 'no QR code'} — check the User Code in the app (Me → Settings → Account and Security).`, body.code);
  }
  return body.result.qrcode;
}

/**
 * Whether the QR code has been scanned and confirmed yet: the session once it
 * has, null while it has not. Ask again every couple of seconds.
 */
export async function pollLogin(http: ScopedHttp, token: string, userCode: string): Promise<SmartLifeSession | null> {
  const params = query({ clientid: CLIENT_ID, usercode: userCode });
  const body = await json<{ access_token: string; refresh_token: string; endpoint: string; uid: string }>(
    await http(`${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}?${params}`, { timeoutMs: 15_000 }),
    'the login'
  );
  if (!body.success || !body.result?.access_token) return null;
  const { access_token, refresh_token, endpoint, uid } = body.result;
  return { accessToken: access_token, refreshToken: refresh_token, endpoint: endpoint.replace(/\/$/, ''), uid };
}

// ---------------------------------------------------------------------------
// The signed, encrypted calls

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unbase64 = (encoded: string): Uint8Array => Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Twelve letters and digits: the nonce is sent as text, so it is made of text. */
function textNonce(): string {
  const random = new Uint8Array(12);
  globalThis.crypto.getRandomValues(random);
  return [...random].map((byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join('');
}

/** Per request: md5(requestId + refreshToken) signs, and an HMAC of it keys the AES. */
export function requestKeys(requestId: string, refreshToken: string): { hashKey: string; secret: Uint8Array } {
  const hashKey = toHex(md5(requestId + refreshToken));
  // With an empty session id the message is the hash key alone.
  const secret = utf8(toHex(hmacSha256(requestId, hashKey)).slice(0, 16));
  return { hashKey, secret };
}

/** base64(nonce) + base64(ciphertext ‖ tag) — two encodings side by side, as Tuya wants it. */
export function encryptPayload(plaintext: string, secret: Uint8Array, nonce = textNonce()): string {
  const iv = utf8(nonce);
  const { ciphertext, tag } = aesGcmEncrypt(secret, iv, utf8(plaintext), new Uint8Array(0));
  return base64(iv) + base64(concat(ciphertext, tag));
}

/** Answers come back as one base64 of nonce ‖ ciphertext ‖ tag. */
export function decryptPayload(encoded: string, secret: Uint8Array): string {
  const bytes = unbase64(encoded);
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(bytes.length - 16);
  return text(aesGcmDecrypt(secret, iv, bytes.subarray(12, bytes.length - 16), new Uint8Array(0), tag));
}

/** HMAC-SHA256 over the non-empty headers as name=value joined by ||, then the encrypted query. */
export function signHeaders(hashKey: string, headers: Record<string, string>, encryptedQuery = ''): string {
  const signed = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
    .filter((name) => headers[name])
    .map((name) => `${name}=${headers[name]}`)
    .join('||');
  return toHex(hmacSha256(hashKey, signed + encryptedQuery));
}

/** A random version-4 UUID, from the random values every place has (a phone has no `crypto.randomUUID`). */
function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function call<T>(http: ScopedHttp, session: SmartLifeSession, path: string, params?: Record<string, unknown>): Promise<T> {
  const requestId = randomUuid();
  const { hashKey, secret } = requestKeys(requestId, session.refreshToken);
  const encryptedQuery = params ? encryptPayload(JSON.stringify(params), secret) : '';

  const headers: Record<string, string> = {
    'X-appKey': CLIENT_ID,
    'X-requestId': requestId,
    'X-sid': '',
    'X-time': String(Date.now()),
    'X-token': session.accessToken,
  };
  headers['X-sign'] = signHeaders(hashKey, headers, encryptedQuery);

  const url = `${session.endpoint}${path}${encryptedQuery ? `?${query({ encdata: encryptedQuery })}` : ''}`;
  const body = await json<string>(await http(url, { headers, timeoutMs: 15_000 }), path);
  if (!body.success || typeof body.result !== 'string') {
    throw new SmartLifeError(`${body.msg ?? 'refused'}${body.code ? ` (code ${body.code})` : ''}`, body.code);
  }
  return JSON.parse(decryptPayload(body.result, secret)) as T;
}

type RawDevice = {
  id: string;
  name: string;
  local_key: string;
  product_name?: string;
  category?: string;
  ip?: string;
  online?: boolean;
  /** Reached through a gateway: a Zigbee or Bluetooth device. Its `local_key` is its gateway's. */
  sub?: boolean;
  /** Tuya's own identifier for it: for a Zigbee device, its Zigbee address — the `cid` its gateway knows it by. */
  uuid?: string;
};

/** Every device in every home on the signed-in account, each with its local key. */
export async function smartLifeDevices(http: ScopedHttp, session: SmartLifeSession): Promise<CloudDevice[]> {
  const homes = await call<{ ownerId: string | number; name: string }[]>(http, session, '/v1.0/m/life/users/homes');
  const devices = new Map<string, CloudDevice>();
  for (const home of homes) {
    const raw = await call<RawDevice[]>(http, session, '/v1.0/m/life/ha/home/devices', { homeId: home.ownerId });
    for (const device of raw) {
      devices.set(device.id, {
        id: device.id,
        name: device.name,
        localKey: device.local_key,
        productName: device.product_name,
        category: device.category,
        ip: device.ip,
        online: device.online,
        uid: session.uid,
        ...(device.sub ? { sub: true } : {}),
        ...(device.uuid ? { uuid: device.uuid } : {}),
      });
    }
  }
  return [...devices.values()];
}
