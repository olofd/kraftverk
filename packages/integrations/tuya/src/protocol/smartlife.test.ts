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
import { memoryKept } from '@kraftverk/device-sdk';

import { toHex } from './bytes.ts';
import { DISCOVERY_KEY } from './discovery.ts';
import { encodeFrame } from './frame.ts';
import protocol from './index.ts';

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
          ? [{ id: 'bf0e5a1c2d3b4f6a7c8d9e', name: 'Kitchen plug', local_key: 'a1b2c3d4e5f6g7h8', category: 'cz', online: true }]
          : [{ id: '20000000aabbccddeeff', name: 'Sauna', local_key: 'h8g7f6e5d4c3b2a1', product_name: 'S1W' }],
    });
    const devices = await smartLifeDevices(http, session);
    expect(devices.map((device) => [device.id, device.localKey])).toEqual([
      ['bf0e5a1c2d3b4f6a7c8d9e', 'a1b2c3d4e5f6g7h8'],
      ['20000000aabbccddeeff', 'h8g7f6e5d4c3b2a1'],
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

  test('from setup: a QR code, then waiting, then the plugs by name — the one heard here with its address', async () => {
    const signIn = protocol.credentials!.actions!.find((action) => action.id === 'signIn')!;
    let scanned = false;
    const listing = fakeTuya({
      '/v1.0/m/life/users/homes': () => [{ ownerId: 11, name: 'Home' }],
      '/v1.0/m/life/ha/home/devices': () => [
        { id: 'bf0e5a1c2d3b4f6a7c8d9e', name: 'Charger', local_key: 'a1b2c3d4e5f6g7h8', category: 'cz', product_name: 'Smart Socket', online: true },
        { id: '20000000aabbccddeeff', name: 'Lamp', local_key: 'h8g7f6e5d4c3b2a1', category: 'dj' },
      ],
    });
    const http = async (url: string, init?: RequestInit) => {
      if (new URL(url).host !== 'apigw.iotbing.com') return listing.http(url, init);
      if (init?.method === 'POST') return Response.json({ success: true, result: { qrcode: 'QRTOKEN' } });
      return scanned ? Response.json({ success: true, result: { access_token: 'tok', refresh_token: 'ref', endpoint: 'https://apigw.tuyaeu.com', uid: 'eu123' } }) : Response.json({ success: false });
    };
    // The plug announcing itself on 3.5, as a sighting of the lan transport.
    const announcement = encodeFrame({
      version: '3.5',
      key: DISCOVERY_KEY,
      sequence: 0,
      command: 0x13,
      payload: new TextEncoder().encode(JSON.stringify({ ip: '192.0.2.196', gwId: 'bf0e5a1c2d3b4f6a7c8d9e', version: '3.5' })),
      iv: new Uint8Array(12).fill(1),
    });
    const ctx = {
      kept: memoryKept(),
      adding: { typeId: 'tuya.plug', kind: 'hardware' as const },
      draft: {},
      connection: {},
      address: null,
      secrets: { get: () => null },
      http,
      sightings: [{ transport: 'lan', address: '192.0.2.196', seenAt: new Date().toISOString(), heard: [{ kind: 'broadcast' as const, port: 6667, payload: toHex(announcement) }] }],
      log: { info: () => {}, warn: () => {}, error: () => {} },
      signal: AbortSignal.timeout(10_000),
      platform: 'system' as const,
    };

    const first = await signIn.run(ctx, { userCode: 'user-code' });
    expect(first.waiting?.qr).toBe('tuyaSmart--qrLogin?token=QRTOKEN');
    const waiting = await signIn.run(ctx, first.waiting!.next);
    expect(waiting.waiting).toBeDefined();
    scanned = true;
    const done = await signIn.run(ctx, waiting.waiting!.next);
    expect(done.waiting).toBeUndefined();
    expect(done.choices?.map((choice) => [choice.label, choice.address ?? null, choice.recommended])).toEqual([
      ['Charger', '192.0.2.196', true],
      ['Lamp', null, false],
    ]);
    expect(done.choices?.[0]).toMatchObject({ name: 'Charger', config: { deviceId: 'bf0e5a1c2d3b4f6a7c8d9e', localKey: 'a1b2c3d4e5f6g7h8', protocolVersion: '3.5' } });
  });

  test('from setup: a Zigbee gateway comes with the key Tuya hands the plugs behind it, its address and version; the plugs are found through it — and a plug on Wi-Fi is not offered as one', async () => {
    const signIn = protocol.credentials!.actions!.find((action) => action.id === 'signIn')!;
    const listing = fakeTuya({
      '/v1.0/m/life/users/homes': () => [{ ownerId: 11, name: 'Home' }],
      '/v1.0/m/life/ha/home/devices': () => [
        // Tuya lists a gateway with no key, and hands its devices its key.
        { id: 'bf8d0000000000000000gw', name: 'Gateway', local_key: '', category: 'wg2', product_name: 'Zigbee gateway' },
        { id: 'bf7c0000000000000000zp', name: 'Fan plug', local_key: 'g1a2t3e4w5a6y7k8', category: 'cz', product_name: 'Smart plug', sub: true, uuid: 'A4C1380000000001' },
        // A plug on Wi-Fi beside it: never a gateway.
        { id: 'bf9e0000000000000000wp', name: 'Charger', local_key: 'w1i2f3i4p5l6u7g8', category: 'cz', product_name: 'Smart plug' },
      ],
    });
    const http = async (url: string, init?: RequestInit) => {
      if (new URL(url).host !== 'apigw.iotbing.com') return listing.http(url, init);
      return Response.json({ success: true, result: { access_token: 'tok', refresh_token: 'ref', endpoint: 'https://apigw.tuyaeu.com', uid: 'eu123' } });
    };
    const announcement = encodeFrame({
      version: '3.5',
      key: DISCOVERY_KEY,
      sequence: 0,
      command: 0x13,
      payload: new TextEncoder().encode(JSON.stringify({ ip: '192.0.2.74', gwId: 'bf8d0000000000000000gw', version: '3.4' })),
      iv: new Uint8Array(12).fill(1),
    });
    const ctx = {
      kept: memoryKept(),
      adding: { typeId: 'tuya.gateway', kind: 'gateway' as const },
      draft: {},
      connection: {},
      address: null,
      secrets: { get: () => null },
      http,
      sightings: [{ transport: 'lan', address: '192.0.2.74', seenAt: new Date().toISOString(), heard: [{ kind: 'broadcast' as const, port: 6667, payload: toHex(announcement) }] }],
      log: { info: () => {}, warn: () => {}, error: () => {} },
      signal: AbortSignal.timeout(10_000),
      platform: 'system' as const,
    };
    const done = await signIn.run(ctx, { userCode: 'user-code', token: 'QRTOKEN' });
    expect(done.choices).toEqual([
      expect.objectContaining({
        label: 'Gateway',
        address: '192.0.2.74',
        detail: 'Zigbee gateway · a gateway: what is paired with it is found through it · on your network at 192.0.2.74',
        recommended: true,
        config: { deviceId: 'bf8d0000000000000000gw', localKey: 'g1a2t3e4w5a6y7k8', protocolVersion: '3.4' },
      }),
    ]);
    expect(done.detail).toContain('1 more is behind a gateway: add the gateway, and it is found through it');

    // Adding a plug instead: the plug on Wi-Fi, and not the gateway.
    const plugs = await signIn.run({ ...ctx, adding: { typeId: 'tuya.plug', kind: 'hardware' } }, { userCode: 'user-code', token: 'QRTOKEN' });
    expect(plugs.choices?.map((choice) => choice.label)).toEqual(['Charger']);
  });

  test('kept for the next setup: the listing, offered with no sign-in and fetched again on asking; the User Code, remembered when asked', async () => {
    const signIn = protocol.credentials!.actions!.find((action) => action.id === 'signIn')!;
    const listing = fakeTuya({
      '/v1.0/m/life/users/homes': () => [{ ownerId: 11, name: 'Home' }],
      '/v1.0/m/life/ha/home/devices': () => [{ id: 'bf0e5a1c2d3b4f6a7c8d9e', name: 'Charger', local_key: 'a1b2c3d4e5f6g7h8', category: 'cz', product_name: 'Smart Socket' }],
    });
    let asked = 0;
    const http = async (url: string, init?: RequestInit) => {
      asked += 1;
      if (new URL(url).host !== 'apigw.iotbing.com') return listing.http(url, init);
      if (init?.method === 'POST') return Response.json({ success: true, result: { qrcode: 'QRTOKEN' } });
      return Response.json({ success: true, result: { access_token: 'tok', refresh_token: 'ref', endpoint: 'https://apigw.tuyaeu.com', uid: 'eu123' } });
    };
    const kept = memoryKept();
    const ctx = {
      kept,
      adding: { typeId: 'tuya.plug', kind: 'hardware' as const },
      draft: {},
      connection: {},
      address: null,
      secrets: { get: () => null },
      http,
      sightings: [],
      log: { info: () => {}, warn: () => {}, error: () => {} },
      signal: AbortSignal.timeout(10_000),
      platform: 'system' as const,
    };

    // Nothing kept: the User Code is asked for, to be remembered by default.
    const first = await signIn.run(ctx, {});
    expect(first.ask?.schema.fields).toMatchObject({ userCode: { type: 'string', required: true }, remember: { type: 'boolean', default: true } });
    expect(first.ask?.schema.fields.userCode).not.toHaveProperty('default');
    const qr = await signIn.run(ctx, { userCode: ' user-code ', remember: true });
    expect(qr.waiting?.qr).toBe('tuyaSmart--qrLogin?token=QRTOKEN');
    expect(kept.get('smartlife.userCode')).toBe('user-code');
    const done = await signIn.run(ctx, qr.waiting!.next);
    expect(done.choices?.map((choice) => choice.label)).toEqual(['Charger']);
    expect(done.again).toBeUndefined();

    // The next device: offered from what was kept — no sign-in, nothing asked of the network — and fetched again on asking.
    asked = 0;
    const later = await signIn.run(ctx, {});
    expect(asked).toBe(0);
    expect(later.detail).toStartWith('From the keys fetched just now.');
    expect(later.choices?.[0]).toMatchObject({ label: 'Charger', config: { deviceId: 'bf0e5a1c2d3b4f6a7c8d9e', localKey: 'a1b2c3d4e5f6g7h8' } });
    expect(later.again).toEqual({ label: 'Fetch the keys again', input: { fresh: true } });
    const afresh = await signIn.run(ctx, later.again!.input);
    expect(afresh.ask?.schema.fields.userCode).toMatchObject({ default: 'user-code' });

    // Not to be remembered: forgotten.
    await signIn.run(ctx, { userCode: 'user-code', remember: false });
    expect(kept.get('smartlife.userCode')).toBeNull();
  });

  test('a wrong user code says where to find the right one', async () => {
    const http = async () => Response.json({ success: false, msg: 'user code invalid', code: 1106 });
    await expect(requestQrToken(http, 'nope')).rejects.toThrow('Account and Security');
  });
});
