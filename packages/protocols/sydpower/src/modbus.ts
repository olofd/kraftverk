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

/**
 * A frame travelling *to* a station, as the station would read it.
 *
 * `parseFrame` reads responses, and cannot read requests: a read request's
 * start address sits where a response keeps its byte count, so the same eight
 * bytes decode as nonsense. Anything that watches the command direction — the
 * broker's journal, a guard on the wire — needs this one instead.
 *
 * `crcValid` is reported rather than required. A frame with a wrong CRC is one
 * the station *should* drop, but a guard that let it through on that basis
 * would be trusting the firmware's CRC check to protect the hardware.
 */
export type ParsedCommand = { crcValid: boolean; address: number } & (
  | { kind: 'read'; fn: typeof FN.READ_HOLDING | typeof FN.READ_INPUT; start: number; count: number }
  | { kind: 'write'; register: number; value: number }
  /**
   * `values` may be shorter than `count` when the frame is truncated.
   * `wellFormed` is false when the frame's parts disagree — see `wellFormed`.
   */
  | { kind: 'writeMany'; start: number; count: number; values: number[]; wellFormed: boolean }
  /**
   * Function 0x16: the register becomes `(current AND and) OR (or AND NOT and)`.
   * The masks are null when the frame is truncated before them.
   */
  | { kind: 'maskWrite'; register: number; and: number | null; or: number | null }
  /** Function 0x17: one read and one multi-register write, in a single frame. */
  | {
      kind: 'readWriteMany';
      readStart: number;
      readCount: number;
      start: number;
      count: number;
      values: number[];
      wellFormed: boolean;
    }
  | { kind: 'other'; fn: number }
);

/**
 * Functions 0x10, 0x16 and 0x17. Never built here; recognised so a guard can
 * refuse them. All three write holding registers — 0x16 and 0x17 as surely as
 * 0x10 — and a guard that knew only the ones this code sends would be trusting
 * the firmware not to implement the rest of the standard.
 */
const WRITE_MULTIPLE = 0x10;
const MASK_WRITE = 0x16;
const READ_WRITE_MULTIPLE = 0x17;

/**
 * Whether a multi-register write says the same thing three ways.
 *
 * Its register count, its byte count and the data it actually carries must
 * agree. A frame that says "one register at 67" and carries two registers'
 * worth of data writes 68 on any firmware that goes by the data — so a guard
 * that read only the count would pass the very write it exists to stop. The
 * frame may arrive with its CRC or without it: those are the only two lengths
 * that agree.
 */
function wellFormed(payload: Uint8Array, header: number, count: number): boolean {
  if (payload.length <= header - 1) return false;
  const byteCount = payload[header - 1]!;
  return byteCount === count * 2 && (payload.length === header + byteCount || payload.length === header + byteCount + 2);
}

export function parseCommand(payload: Uint8Array): ParsedCommand | null {
  if (payload.length < 4) return null;

  const address = payload[0]!;
  const fn = payload[1]!;
  const expected = crc16(payload.subarray(0, payload.length - 2));
  const actual = (payload[payload.length - 2]! << 8) | payload[payload.length - 1]!;
  const common = { crcValid: expected === actual, address };
  const word = (index: number) => (payload[index]! << 8) | payload[index + 1]!;

  if ((fn === FN.READ_HOLDING || fn === FN.READ_INPUT) && payload.length >= 6) {
    return { ...common, kind: 'read', fn, start: word(2), count: word(4) };
  }
  if (fn === FN.WRITE_SINGLE && payload.length >= 6) {
    return { ...common, kind: 'write', register: word(2), value: word(4) };
  }
  if (fn === WRITE_MULTIPLE && payload.length >= 6) {
    const start = word(2);
    const count = word(4);
    const values: number[] = [];
    // [addr][fn][start:2][count:2][byteCount][data...][crc:2]
    for (let i = 0; i < count && 7 + i * 2 + 1 < payload.length; i++) values.push(word(7 + i * 2));
    return { ...common, kind: 'writeMany', start, count, values, wellFormed: wellFormed(payload, 7, count) };
  }
  if (fn === MASK_WRITE && payload.length >= 6) {
    // [addr][fn][register:2][and:2][or:2], then the CRC when it has one
    const masks = payload.length >= 8;
    return { ...common, kind: 'maskWrite', register: word(2), and: masks ? word(4) : null, or: masks ? word(6) : null };
  }
  if (fn === READ_WRITE_MULTIPLE && payload.length >= 10) {
    // [addr][fn][readStart:2][readCount:2][writeStart:2][writeCount:2][byteCount][data...][crc:2]
    const count = word(8);
    const values: number[] = [];
    for (let i = 0; i < count && 11 + i * 2 + 1 < payload.length; i++) values.push(word(11 + i * 2));
    return {
      ...common,
      kind: 'readWriteMany',
      readStart: word(2),
      readCount: word(4),
      start: word(6),
      count,
      values,
      wellFormed: wellFormed(payload, 11, count),
    };
  }
  return { ...common, kind: 'other', fn };
}

/** One line a person can read: "write holding 26 = 1", "read input 0+80". */
export function describeCommand(payload: Uint8Array): string {
  const command = parseCommand(payload);
  if (!command) return `${payload.length}-byte fragment`;
  const suffix = command.crcValid ? '' : ' (bad CRC)';
  switch (command.kind) {
    case 'read':
      return `read ${command.fn === FN.READ_INPUT ? 'input' : 'holding'} ${command.start}+${command.count}${suffix}`;
    case 'write':
      return `write holding ${command.register} = ${command.value}${suffix}`;
    case 'writeMany':
      return `write holding ${command.start}..${command.start + command.count - 1} = [${command.values.join(', ')}]${suffix}`;
    case 'maskWrite':
      return `mask write holding ${command.register}${
        command.and === null || command.or === null ? '' : ` (and ${command.and}, or ${command.or})`
      }${suffix}`;
    case 'readWriteMany':
      return `read holding ${command.readStart}+${command.readCount}, write holding ${command.start}..${
        command.start + command.count - 1
      } = [${command.values.join(', ')}]${suffix}`;
    case 'other':
      return `function 0x${command.fn.toString(16).padStart(2, '0')}${suffix}`;
  }
}

export const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
