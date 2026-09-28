import { describe, expect, test } from 'bun:test';

import { fromHex, parseFrame, readInputRegisters, toHex, writeRegister } from './modbus.ts';

/**
 * Vectors captured from real hardware in Jack Reeve's teardown of an AFERIY
 * P210 and in the sydpower-mqtt protocol notes. If these pass, our framing
 * matches what the devices actually accept.
 */
describe('modbus framing', () => {
  test('reads 80 input registers exactly as the BrightEMS app does', () => {
    expect(toHex(readInputRegisters(0, 80))).toBe('110400000050a6f2');
  });

  test('writes the AC charging booking register (60 min delay)', () => {
    expect(toHex(writeRegister(0x3f, 60))).toBe('1106003f003c47bb');
  });
});

describe('response parsing', () => {
  // A real /device/response/client/04 payload, 168 bytes.
  // prettier-ignore
  const RESPONSE =
    '110400000050000000000005000000000000000000000000000000000000000000000000000000000000090001f40066000d00000000000000000000000000000000000000000000000000000000000000000000006600000804000000000000000000003000400000000000000000000000016d000002980000000002810000000000ffffff0000000000000000000000000000000000000000000000000000000000000000dfb5';

  test('accepts the frame and recovers all 80 registers', () => {
    const parsed = parseFrame(fromHex(RESPONSE));
    expect(parsed?.kind).toBe('registers');
    if (parsed?.kind !== 'registers') throw new Error('wrong kind');
    expect(parsed.values.length).toBe(80);
  });

  test('decodes the documented register values from that capture', () => {
    const parsed = parseFrame(fromHex(RESPONSE));
    if (parsed?.kind !== 'registers') throw new Error('wrong kind');
    const r = parsed.values;

    expect(r[39]).toBe(0x0066); // total output = 102 W
    expect(r[48]).toBe(0x4000); // not charging
    expect(r[56]).toBe(0x0298); // SOC 664 -> 66.4 %
    expect(r[57]).toBe(0); // no charge booking
    expect(r[58]).toBe(0); // time to full
    expect(r[59]).toBe(0x0281); // time to empty = 641 min
  });

  test('rejects a frame whose CRC has been corrupted', () => {
    const bad = fromHex(RESPONSE.slice(0, -4) + '0000');
    expect(parseFrame(bad)).toBeNull();
  });
});
