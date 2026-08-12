import { parseFrame, SLAVE_ADDRESS, type ParsedFrame } from './modbus.ts';

/**
 * The parts of the BLE link that don't depend on which Bluetooth stack you're
 * on: the GATT layout, the advertisement heuristics, and frame reassembly.
 *
 * Three stacks talk to this hardware in this repo — noble on the server, Web
 * Bluetooth in the browser, react-native-ble-plx on iOS and Android — and they
 * disagree about almost everything except these facts. Keeping the facts here
 * means a fix found on one stack is a fix on all three.
 */

/**
 * GATT layouts documented for this rebadged hardware family. Sources disagree
 * on which applies to which model, so probe both and use whichever the device
 * actually exposes. `a002` is what an AFERIY P280 answers on.
 */
export const SERVICE_CANDIDATES = [
  { service: 'a002', write: 'c304', notify: 'c305' },
  { service: 'fff0', write: 'fff2', notify: 'fff1' },
] as const;

/**
 * Expands a 16-bit GATT UUID to its full 128-bit form.
 *
 * noble takes the short form, Web Bluetooth and react-native-ble-plx report and
 * expect the long one. Comparing the two forms directly is the classic way to
 * conclude a characteristic is missing when it is right there.
 */
export const fullUuid = (short: string): string =>
  short.length === 4 ? `0000${short.toLowerCase()}-0000-1000-8000-00805f9b34fb` : short.toLowerCase();

/** Compares GATT UUIDs regardless of which form either side used. */
export const uuidEquals = (a: string, b: string): boolean => fullUuid(a) === fullUuid(b);

/** Every service UUID to declare up front, in the long form web APIs want. */
export const BLE_SERVICE_UUIDS: string[] = SERVICE_CANDIDATES.map((c) => fullUuid(c.service));

/** Advertised names seen across this rebadged hardware family. */
export const NAME_PATTERN = /^(fossibot|aferiy|sydpower|abok|ecoplay|power|p\d{3})/i;

/**
 * The same list as prefixes, for APIs that filter rather than match.
 *
 * Web Bluetooth's chooser takes `namePrefix` filters and has no regex, and an
 * AFERIY P280 advertises as `POWER-nnnn` — a prefix generic enough that the
 * chooser is the safeguard, not the filter.
 */
export const NAME_PREFIXES = [
  'POWER',
  'AFERIY',
  'FOSSIBOT',
  'SYDPOWER',
  'ABOK',
  'ECOPLAY',
] as const;

/**
 * The station drops frames if you talk too fast. The reference client spaces
 * writes 500 ms apart and so do we — going faster produced silent timeouts
 * rather than errors, which is the worst kind of failure to debug.
 */
export const WRITE_SPACING_MS = 500;

/** Drop a device from the discovery list after this long without an ad. */
export const STALE_AFTER_MS = 30_000;

/** True if an advertisement is strong evidence of a station, not a guess. */
export function isLikelyStation(ad: { name?: string | null; serviceUuids?: readonly string[] }): boolean {
  const advertised = ad.serviceUuids ?? [];
  if (advertised.some((u) => BLE_SERVICE_UUIDS.includes(fullUuid(u)))) return true;
  return !!ad.name && NAME_PATTERN.test(ad.name);
}

/**
 * The longest frame this protocol can produce: a 125-register read response,
 * the most one MODBUS request may ask for.
 *
 * Used as a sanity bound while reassembling. A stray byte can make the header
 * imply an enormous length, and without a ceiling the assembler would sit
 * waiting for bytes that are never coming.
 */
export const MAX_FRAME_BYTES = 6 + 125 * 2 + 2;

/** Function codes we can work out a length for. Anything else is noise. */
const isKnownFunction = (fn: number): boolean =>
  fn === 0x03 || fn === 0x04 || fn === 0x06 || (fn & 0x80) !== 0;

/**
 * Total frame length implied by the header, including the two CRC bytes, or
 * null if the header isn't complete enough to tell yet.
 */
export function expectedFrameLength(bytes: readonly number[]): number | null {
  const fn = bytes[1];
  if (fn === undefined) return null;
  if (fn === 0x06) return 8; // addr + fn + reg(2) + val(2) + crc(2)
  if (fn === 0x03 || fn === 0x04) {
    // These devices echo the start register and count before the data.
    if (bytes.length < 6) return null;
    const count = (bytes[4]! << 8) | bytes[5]!;
    return 6 + count * 2 + 2;
  }
  if (fn & 0x80) return 5; // exception response
  return null;
}

/**
 * Reassembles GATT notifications into MODBUS frames.
 *
 * BLE splits payloads at the MTU, so a 168-byte telemetry response arrives in
 * several notifications. Frames always start with the slave address and their
 * length is implied by the function code, so accumulate until the CRC checks.
 *
 * Resyncing on a bad CRC by dropping a single byte matters: an assembler that
 * clears its whole buffer instead never recovers from one corrupt packet.
 */
export class FrameAssembler {
  #buffer: number[] = [];

  reset(): void {
    this.#buffer = [];
  }

  /** Feeds one notification in, returns whatever complete frames came out. */
  push(chunk: ArrayLike<number>): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.#buffer.push(chunk[i]!);

    const frames: ParsedFrame[] = [];
    this.#resync();

    while (this.#buffer.length >= 5) {
      /*
        A byte of noise that happens to be 0x11 puts us at a fake frame start,
        and its "header" can name a function we don't speak or a length far
        past anything the protocol can send. Both mean this is not a frame —
        step over the byte and look again, rather than waiting for data that
        will never arrive. Observed as a link that went quiet after one
        corrupt notification and stayed that way.
      */
      if (!isKnownFunction(this.#buffer[1]!)) {
        this.#skipByte();
        continue;
      }

      const expected = expectedFrameLength(this.#buffer);
      if (expected !== null && expected > MAX_FRAME_BYTES) {
        this.#skipByte();
        continue;
      }
      if (expected === null || this.#buffer.length < expected) break;

      const frame = parseFrame(Uint8Array.from(this.#buffer.slice(0, expected)));
      if (frame) {
        this.#buffer = this.#buffer.slice(expected);
        frames.push(frame);
      } else {
        // Bad CRC — drop one byte and resync rather than stalling forever.
        this.#skipByte();
      }
    }

    return frames;
  }

  #skipByte(): void {
    this.#buffer.shift();
    this.#resync();
  }

  #resync(): void {
    while (this.#buffer.length && this.#buffer[0] !== SLAVE_ADDRESS) this.#buffer.shift();
  }
}

/**
 * Splits a frame for stacks that won't fragment it themselves.
 *
 * Web Bluetooth and react-native-ble-plx both cap a write at the negotiated
 * ATT MTU minus 3 bytes, and the longest frame we send is 8, so this is a
 * no-op in practice — but it is the difference between working and silently
 * truncating if a longer command is ever added.
 */
export function chunkForWrite(frame: Uint8Array, mtu = 20): Uint8Array[] {
  if (frame.length <= mtu) return [frame];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < frame.length; i += mtu) chunks.push(frame.slice(i, i + mtu));
  return chunks;
}
