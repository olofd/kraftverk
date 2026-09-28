import { describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

import {
  decryptPayload,
  encryptPayload,
  pollLogin,
  qrLoginContent,
  requestKeys,
  requestQrToken,
  signHeaders,
  smartLifeDevices,
  SmartLifeError,
  type SmartLifeSession,
} from './smartlife.ts';

/**
 * The Smart Life login, checked against tuya-device-sharing-sdk's algorithm
 * written out a second time with Node's crypto — and a fake Tuya that speaks
 * it, so the whole listing runs without the network.
 */

// tuya_sharing/customerapi.py, transcribed.
const reference = {
  keys(requestId: string, refreshToken: string) {
    const hashKey = createHash('md5').update(requestId + refreshToken).digest('hex');
    const secret = createHmac('sha256', requestId).update(hashKey).digest('hex').slice(0, 16);
    return { hashKey, secret };
  },
  encrypt(plaintext: string, secret: string, nonce: string): string {
    const cipher = createCipheriv('aes-128-gcm', Buffer.from(secret), Buffer.from(nonce));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return Buffer.from(nonce).toString('base64') + body.toString('base64');
  },
  /** How the server answers: one base64 of nonce ‖ ciphertext ‖ tag. */
  answer(plaintext: string, secret: string, nonce: string): string {
    const cipher = createCipheriv('aes-128-gcm', Buffer.from(secret), Buffer.from(nonce));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([Buffer.from(nonce), body]).toString('base64');
  },
  /** How the server reads a request's encdata. */
  read(encdata: string, secret: string): string {
    const nonce = Buffer.from(encdata.slice(0, 16), 'base64');
    const body = Buffer.from(encdata.slice(16), 'base64');
    const decipher = createDecipheriv('aes-128-gcm', Buffer.from(secret), nonce);
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
  },
  sign(hashKey: string, headers: Record<string, string>, encdata: string): string {
    const signed = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
      .filter((name) => headers[name])
      .map((name) => `${name}=${headers[name]}`)
      .join('||');
    return createHmac('sha256', hashKey).update(signed + encdata).digest('hex');
  },
};

describe('Smart Life request crypto', () => {
  const requestId = 'b3c1d2e4-0000-4a4a-9f9f-0123456789ab';
  const refreshToken = 'refresh-abc';

  test('derives the same per-request keys as the Python SDK', () => {
    const ours = requestKeys(requestId, refreshToken);
    const theirs = reference.keys(requestId, refreshToken);
    expect(ours.hashKey).toBe(theirs.hashKey);
    expect(new TextDecoder().decode(ours.secret)).toBe(theirs.secret);
  });

  test('encrypts a query exactly as the SDK does, and reads the server’s answers', () => {
    const { secret } = requestKeys(requestId, refreshToken);
    const plain = JSON.stringify({ homeId: 12345678 });
    const expected = reference.encrypt(plain, reference.keys(requestId, refreshToken).secret, 'Ab3dEf6hIj9k');
    expect(encryptPayload(plain, secret, 'Ab3dEf6hIj9k')).toBe(expected);

    const answer = reference.answer('[{"ok":true}]', reference.keys(requestId, refreshToken).secret, 'ZyXwVu987654');
    expect(decryptPayload(answer, secret)).toBe('[{"ok":true}]');
  });

  test('signs the non-empty headers, then the encrypted query', () => {
    const headers = { 'X-appKey': 'app', 'X-requestId': requestId, 'X-sid': '', 'X-time': '1700000000000', 'X-token': 'tok' };
    const { hashKey } = requestKeys(requestId, refreshToken);
    expect(signHeaders(hashKey, headers, 'ENC')).toBe(reference.sign(hashKey, headers, 'ENC'));
    expect(signHeaders(hashKey, headers)).toBe(reference.sign(hashKey, headers, ''));
  });
});

describe('the Smart Life login and listing', () => {
  const session: SmartLifeSession = { accessToken: 'tok', refreshToken: 'ref', endpoint: 'https://apigw.tuyaeu.com', uid: 'eu123' };

  /** A Tuya that checks every signature and encrypts every answer. */
  function fakeTuya(routes: Record<string, (params: Record<string, unknown> | null) => unknown>) {
    const seen: string[] = [];
    const http = async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname);
      const headers = init?.headers as Record<string, string>;
      const { hashKey, secret } = reference.keys(headers['X-requestId']!, session.refreshToken);
      const encdata = parsed.searchParams.get('encdata') ?? '';
      if (headers['X-sign'] !== reference.sign(hashKey, headers, encdata)) {
        return Response.json({ success: false, msg: 'sign invalid', code: 1004 });
      }
      const route = routes[parsed.pathname];
      if (!route) return new Response('', { status: 404 });
      const params = encdata ? (JSON.parse(reference.read(encdata, secret)) as Record<string, unknown>) : null;
      return Response.json({ success: true, result: reference.answer(JSON.stringify(route(params)), secret, 'N0nceN0nce12') });
    };
    return { http, seen };
  }

  test('lists every device in every home, each with its local key', async () => {
    const { http, seen } = fakeTuya({
      '/v1.0/m/life/users/homes': () => [
        { ownerId: 11, name: 'Home' },
        { ownerId: 22, name: 'Cabin' },
      ],
      '/v1.0/m/life/ha/home/devices': (params) =>
        params?.homeId === 11
          ? [{ id: 'bfefca9dcaf027e6bfzons', name: 'Kitchen plug', local_key: 'a1b2c3d4e5f6g7h8', category: 'cz', online: true }]
          : [{ id: '50566078bcddc23af4d5', name: 'Sauna', local_key: 'h8g7f6e5d4c3b2a1', product_name: 'S1W' }],
    });
    const devices = await smartLifeDevices(http, session);
    expect(devices.map((device) => [device.id, device.localKey])).toEqual([
      ['bfefca9dcaf027e6bfzons', 'a1b2c3d4e5f6g7h8'],
      ['50566078bcddc23af4d5', 'h8g7f6e5d4c3b2a1'],
    ]);
    expect(devices[1]!.productName).toBe('S1W');
    expect(seen).toEqual(['/v1.0/m/life/users/homes', '/v1.0/m/life/ha/home/devices', '/v1.0/m/life/ha/home/devices']);
  });

  test('a refusal is an error with Tuya’s message, not an empty list', async () => {
    const http = async () => Response.json({ success: false, msg: 'token invalid', code: 1010 });
    await expect(smartLifeDevices(http, session)).rejects.toBeInstanceOf(SmartLifeError);
  });

  test('the QR code carries the login token; polling waits, then hands over the session', async () => {
    let scanned = false;
    const http = async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('usercode')).toBe('user-code');
      if (init?.method === 'POST') return Response.json({ success: true, result: { qrcode: 'QRTOKEN' } });
      if (!scanned) return Response.json({ success: false, msg: 'not scanned yet' });
      return Response.json({
        success: true,
        result: { access_token: 'tok', refresh_token: 'ref', endpoint: 'https://apigw.tuyaeu.com/', uid: 'eu123' },
      });
    };
    const token = await requestQrToken(http, 'user-code');
    expect(qrLoginContent(token)).toBe('tuyaSmart--qrLogin?token=QRTOKEN');
    expect(await pollLogin(http, token, 'user-code')).toBeNull();
    scanned = true;
    expect(await pollLogin(http, token, 'user-code')).toEqual({
      accessToken: 'tok',
      refreshToken: 'ref',
      endpoint: 'https://apigw.tuyaeu.com',
      uid: 'eu123',
    });
  });

  test('a wrong user code says where to find the right one', async () => {
    const http = async () => Response.json({ success: false, msg: 'user code invalid', code: 1106 });
    await expect(requestQrToken(http, 'nope')).rejects.toThrow('Account and Security');
  });
});
