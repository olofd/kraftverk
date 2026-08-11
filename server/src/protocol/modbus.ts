/**
 * MODBUS RTU framing as spoken by SYDPOWER-stack power stations
 * (FOSSiBOT / AFERIY / Eco Play / ABOK) over MQTT.
 *
 * The device is a MODBUS slave at address 0x11 reachable through an MQTT
 * bridge: raw RTU frames are published as binary MQTT payloads rather than
 * sent over a serial line.
 *
 * Protocol reference: https://github.com/schauveau/sydpower-mqtt/blob/main/MQTT-MODBUS.md
 */

/** Every device on this stack answers at slave address 0x11. */
export const SLAVE_ADDRESS = 0x11;

export const FN = {
  /** Read holding registers — the writable settings block. */
  READ_HOLDING: 0x03,
  /** Read input registers — the read-only telemetry block. */
  READ_INPUT: 0x04,
  /** Write a single holding register. */
  WRITE_SINGLE: 0x06,
} as const;

/**
 * CRC-16/MODBUS: init 0xFFFF, reflected polynomial 0xA001, no final XOR.
 */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

/**
 * Appends the CRC **big-endian** (high byte first).
 *
 * This is deliberately NOT standard MODBUS RTU, which transmits the CRC low
 * byte first. Verified against three independent captures from real hardware:
 *
 *   crc16("110400000050") = 0xA6F2 -> frame ends "a6f2"
 *   crc16("1106003f003c") = 0x47BB -> frame ends "47bb"
 *   crc16(<168-byte response body>) = 0xDFB5 -> frame ends "dfb5"
 *
 * A stock MODBUS library will byte-swap these and the device will drop every
 * frame, so don't "fix" this to match the spec.
 */
function withCrc(body: number[]): Uint8Array {
  const crc = crc16(Uint8Array.from(body));
  return Uint8Array.from([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

const hi = (v: number) => (v >> 8) & 0xff;
const lo = (v: number) => v & 0xff;

/** Frame requesting `count` input registers (telemetry) starting at `start`. */
export function readInputRegisters(start: number, count: number): Uint8Array {
  return withCrc([SLAVE_ADDRESS, FN.READ_INPUT, hi(start), lo(start), hi(count), lo(count)]);
}

/** Frame requesting `count` holding registers (settings) starting at `start`. */
export function readHoldingRegisters(start: number, count: number): Uint8Array {
  return withCrc([SLAVE_ADDRESS, FN.READ_HOLDING, hi(start), lo(start), hi(count), lo(count)]);
}

/** Frame writing a single holding register. */
export function writeRegister(register: number, value: number): Uint8Array {
  return withCrc([SLAVE_ADDRESS, FN.WRITE_SINGLE, hi(register), lo(register), hi(value), lo(value)]);
}

export type ParsedFrame =
  | { kind: 'registers'; fn: number; start: number; values: number[] }
  | { kind: 'writeAck'; register: number; value: number }
  | { kind: 'error'; fn: number; code: number };

/**
 * Parses a response frame. Returns null when the payload isn't a valid frame
 * for us — a bad CRC, a foreign slave address, or a truncated message.
 *
 * Note: read responses carry a byte count but not the starting address, so
 * `start` is echoed from the request by the caller, not recovered here.
 */
export function parseFrame(payload: Uint8Array): ParsedFrame | null {
  if (payload.length < 5) return null;
  if (payload[0] !== SLAVE_ADDRESS) return null;

  const expected = crc16(payload.subarray(0, payload.length - 2));
  const actual = (payload[payload.length - 2]! << 8) | payload[payload.length - 1]!;
  if (expected !== actual) return null;

  const fn = payload[1]!;

  // Exception responses set the high bit of the function code.
  if (fn & 0x80) {
    return { kind: 'error', fn: fn & 0x7f, code: payload[2]! };
  }

  if (fn === FN.WRITE_SINGLE) {
    return {
      kind: 'writeAck',
      register: (payload[2]! << 8) | payload[3]!,
      value: (payload[4]! << 8) | payload[5]!,
    };
  }

  if (fn === FN.READ_INPUT || fn === FN.READ_HOLDING) {
    // Devices on this stack echo the request header (start + count) before the
    // data rather than sending a plain byte count, so detect which shape it is.
    const byteCount = payload[2]!;
    const dataOnly = payload.length - 5; // minus addr, fn, count, crc(2)

    let offset: number;
    let count: number;

    if (byteCount === dataOnly) {
      // Standard RTU: [addr][fn][byteCount][data...][crc]
      offset = 3;
      count = byteCount / 2;
    } else {
      // Echoed header: [addr][fn][start:2][count:2][data...][crc]
      const start = (payload[2]! << 8) | payload[3]!;
      count = (payload[4]! << 8) | payload[5]!;
      offset = 6;
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const p = offset + i * 2;
        if (p + 1 >= payload.length - 2) break;
        values.push((payload[p]! << 8) | payload[p + 1]!);
      }
      return { kind: 'registers', fn, start, values };
    }

    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = offset + i * 2;
      values.push((payload[p]! << 8) | payload[p + 1]!);
    }
    return { kind: 'registers', fn, start: 0, values };
  }

  return null;
}

export const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
