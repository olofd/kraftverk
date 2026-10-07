import { describe, expect, test } from 'bun:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { crc32, hexOf, hmacSha256, md5, sha256 } from './hash.ts';

/**
 * The hand-written hashes, checked byte for byte against Node's — allowed
 * here because a test never ships. Random inputs of every length that
 * matters: empty, around a block, exactly a block, and larger.
 */

const LENGTHS = [0, 1, 15, 16, 17, 31, 32, 33, 55, 56, 57, 63, 64, 65, 119, 120, 200, 1000];
const u8 = (buffer: Buffer) => new Uint8Array(buffer);

describe('the hashes', () => {
  test('SHA-256, HMAC-SHA256 and MD5 agree with Node on every length', () => {
    for (const length of LENGTHS) {
      const data = randomBytes(length);
      expect(sha256(u8(data))).toEqual(u8(createHash('sha256').update(data).digest()));
      expect(md5(u8(data))).toEqual(u8(createHash('md5').update(data).digest()));
      const key = randomBytes(length % 90);
      expect(hmacSha256(u8(key), u8(data))).toEqual(u8(createHmac('sha256', key).update(data).digest()));
    }
  });

  test('strings are hashed as UTF-8, and written in hex', () => {
    expect(sha256('')).toEqual(u8(createHash('sha256').update('').digest()));
    expect(hexOf(md5('lösenord'))).toBe(createHash('md5').update('lösenord').digest('hex'));
    // RFC 1321's own answers.
    expect(hexOf(md5('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hexOf(md5('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });

  test('CRC-32 matches the known check value', () => {
    // The standard CRC-32/ISO-HDLC check: "123456789" -> 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
