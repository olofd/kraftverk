import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

/**
 * The cryptography the Tuya LAN protocol uses, and nothing else.
 *
 * Sourced from the published specification in tinytuya's PROTOCOL.md
 * (https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md) rather than
 * from packet capture — the protocol is documented, so none of this is
 * guesswork. Where a detail is untested against real hardware it says so.
 */

/** AES-128-ECB, as used for payloads on 3.1/3.3 and with the session key on 3.4. */
export function aesEcbEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-GCM, for protocol 3.5. */
export function aesGcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad: Buffer): {
  ciphertext: Buffer;
  tag: Buffer;
} {
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  aad: Buffer,
  tag: Buffer
): Buffer {
  const decipher = createDecipheriv('aes-128-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export const md5 = (data: Buffer | string): Buffer => createHash('md5').update(data).digest();

export const hmacSha256 = (key: Buffer, data: Buffer): Buffer =>
  createHmac('sha256', key).update(data).digest();

/**
 * The key every Tuya device encrypts its UDP discovery broadcast with.
 *
 * Published and identical on every device — it protects nothing, and it is what
 * lets us find a plug on the network without knowing its local key. This is the
 * one piece of the protocol you get for free.
 */
export const DISCOVERY_KEY = md5('yGAdlopoPVldABfn');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC, the integrity check on 3.1–3.3 frames. */
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
