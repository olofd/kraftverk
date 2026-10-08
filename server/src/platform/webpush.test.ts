import { describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealFor, webPush } from './webpush.ts';

/*
  Web push, checked against its own standards: a message sealed to a
  browser opens with the browser's key and auth secret (RFC 8291), the
  VAPID token verifies with the server's public key (RFC 8292), and a push
  service's answers are said as sent, gone, or failed. No push service is
  asked: the fetch is the test's.
*/

/** A browser's side: its key pair and auth secret, as PushManager makes them. */
function aBrowser() {
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url'), authBytes: auth, publicKey };
}

/** What the browser does with a push: opens it, as RFC 8291 says. */
function open(browser: ReturnType<typeof aBrowser>, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);
  const shared = browser.ecdh.computeSecret(serverKey);
  const ikm = Buffer.from(hkdfSync('sha256', shared, browser.authBytes, Buffer.concat([Buffer.from('WebPush: info\0'), browser.publicKey, serverKey]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // One record, its last: the message, then 0x02.
  expect(plain.at(-1)).toBe(0x02);
  return plain.subarray(0, -1).toString();
}

describe('web push', () => {
  test('a message sealed to a browser opens only with its key and auth secret', () => {
    const browser = aBrowser();
    const sealed = sealFor({ p256dh: browser.p256dh, auth: browser.auth }, Buffer.from('{"title":"Hello"}'));
    expect(sealed.readUInt32BE(16)).toBe(4096);
    expect(open(browser, sealed)).toBe('{"title":"Hello"}');
    // Another browser cannot open it.
    expect(() => open({ ...aBrowser(), publicKey: browser.publicKey, authBytes: browser.authBytes }, sealed)).toThrow();
  });

  test('sent with a VAPID token the server’s public key verifies, sealed for the browser; a gone subscription said so', async () => {
    const browser = aBrowser();
    const requests: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const push = webPush(join(mkdtempSync(join(tmpdir(), 'kraftverk-push-')), 'vapid.json'), 'mailto:push@kraftverk.invalid', (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(null, { status });
    }) as typeof fetch);
    const endpoint = { nodeId: 'n-1', personId: 'p-1', provider: 'webpush' as const, token: JSON.stringify({ endpoint: 'https://push.example/send/abc', keys: { p256dh: browser.p256dh, auth: browser.auth } }), updatedAt: '' };

    expect(await push.send(endpoint, { id: 'nt-1', title: 'At home', body: null, level: 'info' })).toBe('sent');
    const { init } = requests[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    // The token: for the push service's origin, signed by the key the browser subscribed with.
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization!)!;
    expect(key).toBe(push.publicKey());
    const [head, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ aud: 'https://push.example', sub: 'mailto:push@kraftverk.invalid' });
    const point = Buffer.from(key!, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
    // What it says, as the browser opens it.
    expect(JSON.parse(open(browser, Buffer.from(init.body as Uint8Array)))).toEqual({ id: 'nt-1', title: 'At home', body: null, level: 'info' });

    status = 410;
    expect(await push.send(endpoint, { id: 'nt-2', title: 'Again', body: null, level: 'info' })).toBe('gone');
    status = 500;
    expect(await push.send(endpoint, { id: 'nt-3', title: 'Again', body: null, level: 'info' })).toBe('failed');
  });
});
