import { describe, expect, test } from 'bun:test';

import {
  crc16,
  describeCommand,
  fromHex,
  parseCommand,
  readHoldingRegisters,
  readInputRegisters,
  writeRegister,
} from './modbus.ts';
import { commandRefusal, HOLDING } from './registers.ts';

/**
 * The command direction: frames travelling *to* a station.
 *
 * These are read by things that carry bytes they did not build — the broker's
 * journal and the guard in front of the wire — so the guard is tested against
 * frames built every way a caller could, not only by `writeRegister`.
 */

/** A frame with its CRC appended big-endian, as the station expects. */
function framed(bytes: number[]): Uint8Array {
  const crc = crc16(Uint8Array.from(bytes));
  return Uint8Array.from([...bytes, (crc >> 8) & 0xff, crc & 0xff]);
}

describe('parseCommand', () => {
  test('reads a poll as a read, not as a response', () => {
    expect(parseCommand(readInputRegisters(0, 80))).toMatchObject({ kind: 'read', fn: 4, start: 0, count: 80, crcValid: true });
    expect(parseCommand(readHoldingRegisters(0, 80))).toMatchObject({ kind: 'read', fn: 3, start: 0, count: 80 });
  });

  test('reads the write this project has proven on hardware', () => {
    // Holding 26 (AC output) set to 1 — the frame the P280 acknowledged over Wi-Fi.
    expect(parseCommand(fromHex('1106001a00015d6b'))).toMatchObject({ kind: 'write', register: 26, value: 1, crcValid: true });
  });

  test('says so when the CRC is wrong, rather than refusing to read it', () => {
    expect(parseCommand(fromHex('1106001a00010000'))).toMatchObject({ kind: 'write', register: 26, crcValid: false });
  });

  test('describes frames in words', () => {
    expect(describeCommand(readInputRegisters(0, 80))).toBe('read input 0+80');
    expect(describeCommand(writeRegister(26, 1))).toBe('write holding 26 = 1');
    expect(describeCommand(fromHex('1106001a00010000'))).toBe('write holding 26 = 1 (bad CRC)');
  });
});

describe('commandRefusal: register 68 is never set to 0, whoever built the frame', () => {
  const SLEEP = HOLDING.SLEEP_MINUTES;

  test('the brick write is refused', () => {
    expect(SLEEP).toBe(68);
    expect(commandRefusal(writeRegister(SLEEP, 0))).toContain('bricks');
  });

  test('refused with a corrupt CRC too — the firmware is not trusted to drop it', () => {
    expect(commandRefusal(fromHex('1106004400000000'))).not.toBeNull();
  });

  test('refused at any slave address', () => {
    expect(commandRefusal(framed([0x01, 0x06, 0x00, 0x44, 0x00, 0x00]))).not.toBeNull();
  });

  test('refused when hidden inside a multi-register write', () => {
    // Function 0x10: registers 66..69, register 68 given 0.
    const frame = framed([0x11, 0x10, 0x00, 0x42, 0x00, 0x04, 0x08, 0, 1, 0, 1, 0, 0, 0, 1]);
    expect(commandRefusal(frame)).not.toBeNull();
    // And when the frame is truncated before the value arrives.
    expect(commandRefusal(Uint8Array.from([0x11, 0x10, 0x00, 0x44, 0x00, 0x01]))).not.toBeNull();
  });

  test('every other value outside the whitelist for 68 is refused as well', () => {
    expect(commandRefusal(writeRegister(SLEEP, 1))).not.toBeNull();
    expect(commandRefusal(writeRegister(SLEEP, 0xffff))).not.toBeNull();
  });

  test('the permitted sleep values pass', () => {
    for (const minutes of [5, 10, 30, 480]) expect(commandRefusal(writeRegister(SLEEP, minutes))).toBeNull();
  });

  test('frames that do not touch 68 pass — raw frames exist to reach other registers', () => {
    expect(commandRefusal(readHoldingRegisters(0, 80))).toBeNull();
    expect(commandRefusal(writeRegister(26, 1))).toBeNull();
    expect(commandRefusal(writeRegister(67, 0))).toBeNull();
    expect(commandRefusal(framed([0x11, 0x10, 0x00, 0x45, 0x00, 0x01, 0x02, 0, 0]))).toBeNull();
  });
});
