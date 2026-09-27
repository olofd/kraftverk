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

  test('reads the standard writes this code never sends as writes, not as unknowns', () => {
    const mask = framed([0x11, 0x16, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00]);
    expect(parseCommand(mask)).toMatchObject({ kind: 'maskWrite', register: 68, and: 0, or: 0, crcValid: true });
    expect(describeCommand(mask)).toBe('mask write holding 68 (and 0, or 0)');

    const readWrite = framed([0x11, 0x17, 0x00, 0x00, 0x00, 0x50, 0x00, 0x1a, 0x00, 0x01, 0x02, 0, 1]);
    expect(parseCommand(readWrite)).toMatchObject({ kind: 'readWriteMany', readStart: 0, readCount: 80, start: 26, count: 1, values: [1] });
    expect(describeCommand(readWrite)).toBe('read holding 0+80, write holding 26..26 = [1]');
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

  test('refused when a multi-register write carries more than it says', () => {
    // "One register at 67", carrying two: register 68 given 0 on any firmware
    // that goes by the data rather than the count.
    expect(commandRefusal(framed([0x11, 0x10, 0x00, 0x43, 0x00, 0x01, 0x04, 0, 1, 0, 0]))).toContain('disagree');
    // The byte count lying instead of the data.
    expect(commandRefusal(framed([0x11, 0x10, 0x00, 0x43, 0x00, 0x01, 0x04, 0, 1]))).toContain('disagree');
    // The same for the write half of a read/write.
    expect(commandRefusal(framed([0x11, 0x17, 0x00, 0x00, 0x00, 0x01, 0x00, 0x43, 0x00, 0x01, 0x04, 0, 1, 0, 0]))).toContain('disagree');
    // Said three ways alike, one register at 67 is 67's business, with or without its CRC.
    expect(commandRefusal(framed([0x11, 0x10, 0x00, 0x43, 0x00, 0x01, 0x02, 0, 1]))).toBeNull();
    expect(commandRefusal(Uint8Array.from([0x11, 0x10, 0x00, 0x43, 0x00, 0x01, 0x02, 0, 1]))).toBeNull();
  });

  test('fails closed: what the guard cannot read is refused, not waved through', () => {
    // A function code it does not know — a vendor's own may well write.
    expect(commandRefusal(framed([0x11, 0x41, 0x00, 0x44, 0x00, 0x00]))).toContain('function 0x41');
    expect(commandRefusal(framed([0x11, 0x08, 0x00, 0x00, 0x00, 0x00]))).toContain('function 0x08');
    // Known writes, cut off before they can be read.
    expect(commandRefusal(Uint8Array.from([0x11, 0x06, 0x00, 0x44]))).not.toBeNull();
    expect(commandRefusal(Uint8Array.from([0x11, 0x16, 0x00, 0x43, 0x00, 0x00]))).not.toBeNull();
    expect(commandRefusal(Uint8Array.from([0x11, 0x17, 0x00, 0x00, 0x00, 0x50]))).not.toBeNull();
    expect(commandRefusal(Uint8Array.from([0x11, 0x06, 0x00]))).not.toBeNull();
    // What the server itself sends still passes.
    expect(commandRefusal(readInputRegisters(0, 80))).toBeNull();
    expect(commandRefusal(writeRegister(26, 1))).toBeNull();
  });

  test('refused when written by a mask write (0x16), which can set it to anything', () => {
    // AND mask 0, OR mask 0: the register becomes 0, whatever it held.
    expect(commandRefusal(framed([0x11, 0x16, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00]))).toContain('bricks');
    // A mask to any other register is not this guard's business.
    expect(commandRefusal(framed([0x11, 0x16, 0x00, 0x43, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  test('refused when the write half of a read/write (0x17) spans it', () => {
    // Read 0+80, write 66..69 with 68 given 0.
    const frame = framed([0x11, 0x17, 0x00, 0x00, 0x00, 0x50, 0x00, 0x42, 0x00, 0x04, 0x08, 0, 1, 0, 1, 0, 0, 0, 1]);
    expect(commandRefusal(frame)).toContain('bricks');
    // And when the frame is truncated before its values arrive.
    expect(commandRefusal(Uint8Array.from([0x11, 0x17, 0x00, 0x00, 0x00, 0x50, 0x00, 0x44, 0x00, 0x01]))).not.toBeNull();
    // Reading 68 while writing elsewhere changes nothing on it.
    expect(commandRefusal(framed([0x11, 0x17, 0x00, 0x00, 0x00, 0x50, 0x00, 0x1a, 0x00, 0x01, 0x02, 0, 1]))).toBeNull();
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
