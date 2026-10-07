import { describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { aesEcbDecrypt, aesEcbEncrypt, aesGcmDecrypt, aesGcmEncrypt } from './aes.ts';

/**
 * The hand-written AES, checked byte for byte against Node's — the hashes are the SDK's, and checked there — the one
 * place in this package allowed to use Node's, because it is a test and never
 * ships. Random inputs of every length that matters: empty, one block short,
 * exactly a block, a block and a bit, and larger.
 */

const LENGTHS = [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 200];
const u8 = (buffer: Buffer) => new Uint8Array(buffer);

describe('AES-128-ECB with PKCS#7', () => {
  test('encrypts exactly as Node does, and decrypts what Node encrypts', () => {
    for (const length of LENGTHS) {
      const key = randomBytes(16);
      const plaintext = randomBytes(length);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const expected = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      expect(aesEcbEncrypt(u8(key), u8(plaintext))).toEqual(u8(expected));
      expect(aesEcbDecrypt(u8(key), u8(expected))).toEqual(u8(plaintext));
    }
  });

  test('the FIPS-197 known answer', () => {
    // FIPS-197 Appendix C.1: AES-128 on one block (Node agrees; padding adds a second).
    const key = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
    const plaintext = Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
    expect(Buffer.from(aesEcbEncrypt(key, plaintext).subarray(0, 16)).toString('hex')).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
  });

  test('a wrong key is refused, not decrypted into nonsense', () => {
    const encrypted = aesEcbEncrypt(u8(randomBytes(16)), new TextEncoder().encode('{"dps":{"1":true}}'));
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      try {
        aesEcbDecrypt(u8(randomBytes(16)), encrypted);
      } catch {
        refused += 1;
      }
    }
    // Padding catches nearly every wrong key; a rare accidental match is possible.
    expect(refused).toBeGreaterThanOrEqual(18);
  });
});

describe('AES-128-GCM', () => {
  test('encrypts and tags exactly as Node does, and opens what Node seals', () => {
    for (const length of LENGTHS) {
      const key = randomBytes(16);
      const iv = randomBytes(12);
      const aad = randomBytes(length % 20);
      const plaintext = randomBytes(length);
      const cipher = createCipheriv('aes-128-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      const ours = aesGcmEncrypt(u8(key), u8(iv), u8(plaintext), u8(aad));
      expect(ours.ciphertext).toEqual(u8(ciphertext));
      expect(ours.tag).toEqual(u8(tag));
      expect(aesGcmDecrypt(u8(key), u8(iv), u8(ciphertext), u8(aad), u8(tag))).toEqual(u8(plaintext));

      const decipher = createDecipheriv('aes-128-gcm', key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(ours.tag));
      expect(u8(Buffer.concat([decipher.update(Buffer.from(ours.ciphertext)), decipher.final()]))).toEqual(u8(plaintext));
    }
  });

  test('an altered message is refused', () => {
    const key = u8(randomBytes(16));
    const iv = u8(randomBytes(12));
    const sealed = aesGcmEncrypt(key, iv, new TextEncoder().encode('switch on'), new Uint8Array());
    sealed.ciphertext[0]! ^= 1;
    expect(() => aesGcmDecrypt(key, iv, sealed.ciphertext, new Uint8Array(), sealed.tag)).toThrow();
  });
});
