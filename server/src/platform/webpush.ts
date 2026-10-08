import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PushSender } from '@kraftverk/hub';
import type { PushEndpoint } from '@kraftverk/store';

/*
  Web push, sent by the server (docs/PLAN-WORLD-MODEL.md §8.14): a browser
  subscribed with this server's public key is woken through its own push
  service — its browser maker's — with a message only it can read.

  - Who sends it is proven by a VAPID token (RFC 8292): a JWT signed ES256
    with this server's key, for the push service's origin, half a day long.
  - What it says is sealed to the browser (RFC 8291, aes128gcm): an
    ephemeral ECDH key with the browser's, its auth secret, HKDF, AES-128-GCM.

  The key pair is made once, kept beside the database (0600), never in the
  configuration file: a new one means every browser subscribes again.
*/

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string): Buffer => Buffer.from(text, 'base64url');

type KeptKeys = { publicKey: string; privateKey: string };

/** This server's key for signing pushes: made the first time, then kept. */
function keysAt(file: string): { publicKey: string; signing: KeyObject } {
  if (!existsSync(file)) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    // The public key as a browser wants it: the uncompressed point, 65 bytes.
    const point = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x!), fromB64url(jwk.y!)]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ publicKey: b64url(point), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } satisfies KeptKeys), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const kept = JSON.parse(readFileSync(file, 'utf8')) as KeptKeys;
  return { publicKey: kept.publicKey, signing: createPrivateKey(kept.privateKey) };
}

/** A VAPID token for a push service's origin: who sends, proven by this server's key. */
function vapidToken(audience: string, subject: string, signing: KeyObject, now = Date.now()): string {
  const part = (value: unknown) => b64url(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  return `${unsigned}.${b64url(sign('sha256', Buffer.from(unsigned), { key: signing, dsaEncoding: 'ieee-p1363' }))}`;
}

/** A message sealed to one browser (RFC 8291): only it, with its private key and auth secret, can read it. */
export function sealFor(subscription: { p256dh: string; auth: string }, plaintext: Uint8Array): Buffer {
  const browserKey = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  const ephemeral = createECDH('prime256v1');
  const serverKey = ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(browserKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browserKey, serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, its last: the message, then the delimiter 0x02.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, sealed]);
}

/**
 * The server's web push: its public key, and a send that seals and signs a
 * message for one browser's push service. `subject` is who to contact about
 * the pushes, as push services ask: an https: or mailto: address.
 */
export function webPush(file: string, subject: string, fetchOut: typeof fetch = fetch): PushSender {
  const { publicKey, signing } = keysAt(file);
  // Checked at once: a key that does not load is said when the server starts, not at the first push.
  createPublicKey(signing);
  return {
    publicKey: () => publicKey,
    async send(endpoint: PushEndpoint, message) {
      if (endpoint.provider !== 'webpush') return 'failed';
      const subscription = JSON.parse(endpoint.token) as { endpoint: string; keys: { p256dh: string; auth: string } };
      const body = sealFor(subscription.keys, Buffer.from(JSON.stringify({ id: message.id, title: message.title, body: message.body, level: message.level })));
      const response = await fetchOut(subscription.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(24 * 3600),
          urgency: message.level === 'alarm' ? 'high' : 'normal',
          authorization: `vapid t=${vapidToken(new URL(subscription.endpoint).origin, subject, signing)}, k=${publicKey}`,
        },
        body,
      });
      if (response.status === 404 || response.status === 410) return 'gone';
      return response.ok ? 'sent' : 'failed';
    },
  };
}
