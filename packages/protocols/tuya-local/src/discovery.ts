import { readU32, text } from './bytes.ts';
import { aesEcbDecrypt } from './crypto/aes.ts';
import { md5 } from './crypto/hash.ts';
import { PREFIX_55AA } from './frame.ts';

/**
 * Finding Tuya devices on the home network, with no credentials at all.
 *
 * Every Tuya device shouts about itself every few seconds on a UDP broadcast
 * port, encrypted with a key that is identical on every device ever made and
 * therefore public. That means discovery works before you have extracted
 * anything: it hands back the device id, the IP, and — the reason it comes
 * first — **the protocol version**, which decides how everything else talks to it.
 *
 * The listening is the `lan` transport's; this reads what it heard.
 */

/** 6666 is the old plaintext port, 6667 the encrypted one, 7000 used by some newer firmware. */
export const DISCOVERY_PORTS = [6666, 6667, 7000] as const;

/**
 * The key every Tuya device encrypts its discovery broadcast with.
 *
 * Published and identical on every device — it protects nothing, and it is what
 * lets a plug be found without knowing its local key.
 */
export const DISCOVERY_KEY = md5('yGAdlopoPVldABfn');

export type DiscoveredTuyaDevice = {
  ip: string;
  /** Device id, the same value the Smart Life app calls "Virtual ID". */
  gwId: string;
  version: string;
  productKey?: string;
  /** False when the device has never been paired. */
  active?: boolean;
  /** True when payloads need the local key — everything from 3.3 up. */
  encrypted: boolean;
};

/** Decodes one broadcast datagram, or null if it is not one of ours. */
export function decodeBroadcast(datagram: Uint8Array): DiscoveredTuyaDevice | null {
  if (datagram.length < 20 || readU32(datagram, 0) !== PREFIX_55AA) return null;

  const declared = readU32(datagram, 12);
  const body = datagram.subarray(20, Math.min(16 + declared - 8, datagram.length));
  if (body.length === 0) return null;

  const attempts: { bytes: Uint8Array; encrypted: boolean }[] = [{ bytes: body, encrypted: false }];
  try {
    attempts.push({ bytes: aesEcbDecrypt(DISCOVERY_KEY, body), encrypted: true });
  } catch {
    /* not encrypted, or not with the public key */
  }

  for (const attempt of attempts) {
    const decoded = text(attempt.bytes).replace(/\0+$/, '');
    const start = decoded.indexOf('{');
    if (start < 0) continue;
    try {
      const json = JSON.parse(decoded.slice(start)) as Record<string, unknown>;
      if (typeof json.gwId !== 'string' || typeof json.ip !== 'string') continue;
      return {
        ip: json.ip,
        gwId: json.gwId,
        version: typeof json.version === 'string' ? json.version : '3.1',
        productKey: typeof json.productKey === 'string' ? json.productKey : undefined,
        active: typeof json.active === 'number' ? json.active > 0 : undefined,
        encrypted: attempt.encrypted,
      };
    } catch {
      /* try the next decoding */
    }
  }

  return null;
}
