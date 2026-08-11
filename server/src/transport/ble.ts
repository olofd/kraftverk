import { EventEmitter } from 'node:events';

import { parseFrame, type ParsedFrame } from '../protocol/modbus.ts';
import type { DiscoveredDevice, Transport } from './types.ts';

/**
 * Bluetooth LE transport.
 *
 * The station exposes a GATT service carrying the same MODBUS frames the MQTT
 * bridge uses: write a request to one characteristic, receive the response as a
 * notification on another. No handshake is needed after connecting.
 *
 * Two UUID sets are documented for this hardware family and sources disagree on
 * which applies to which model, so we probe both and use whichever the device
 * actually exposes.
 */
const SERVICE_CANDIDATES = [
  { service: 'a002', write: 'c304', notify: 'c305' },
  { service: 'fff0', write: 'fff2', notify: 'fff1' },
] as const;

/** Advertised names seen across this rebadged hardware family. */
const NAME_PATTERN = /^(fossibot|aferiy|sydpower|abok|ecoplay|power|p\d{3})/i;

/** The device drops frames if you talk too fast; the reference client uses 500ms. */
const WRITE_SPACING_MS = 500;

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = Awaited<ReturnType<Noble['startScanningAsync']>> extends never ? never : any;

export class BleTransport extends EventEmitter implements Transport {
  readonly kind = 'ble' as const;

  #noble: Noble | null = null;
  #devices = new Map<string, DiscoveredDevice>();
  #peripherals = new Map<string, Peripheral>();
  #boundId: string | null = null;
  #writeChar: any = null;
  #connected = false;
  #lastWrite = 0;
  /** Notifications can arrive split across packets. */
  #rxBuffer: number[] = [];

  get boundId(): string | null {
    return this.#boundId;
  }

  get connected(): boolean {
    return this.#connected;
  }

  async start(): Promise<void> {
    const noble = (await import('@stoprocent/noble')).default;
    this.#noble = noble;

    noble.on('discover', (peripheral: Peripheral) => {
      const name: string = peripheral.advertisement?.localName ?? '';
      if (name && !NAME_PATTERN.test(name)) return;

      const id: string = peripheral.id;
      const now = new Date().toISOString();
      const existing = this.#devices.get(id);

      const device: DiscoveredDevice = {
        id,
        kind: 'ble',
        name: name || 'Unnamed BLE device',
        mac: (peripheral.address ?? '').replace(/:/g, '').toUpperCase() || null,
        rssi: peripheral.rssi,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
      };

      this.#peripherals.set(id, peripheral);
      this.#devices.set(id, device);
      this.emit('discovery', device);
    });

    await new Promise<void>((resolve, reject) => {
      if (noble.state === 'poweredOn') return resolve();
      const timer = setTimeout(() => reject(new Error('No Bluetooth adapter became available')), 8000);
      noble.once('stateChange', (state: string) => {
        clearTimeout(timer);
        state === 'poweredOn' ? resolve() : reject(new Error(`Bluetooth adapter is ${state}`));
      });
    });

    await noble.startScanningAsync([], false);
  }

  async stop(): Promise<void> {
    await this.unbind();
    await this.#noble?.stopScanningAsync().catch(() => {});
    this.#noble = null;
  }

  discovered(): DiscoveredDevice[] {
    return [...this.#devices.values()];
  }

  async bind(id: string): Promise<void> {
    const peripheral = this.#peripherals.get(id);
    if (!peripheral) throw new Error(`No BLE device with id ${id}. Scan first.`);

    await this.unbind();
    await peripheral.connectAsync();

    const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

    const short = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
    const find = (want: string) =>
      characteristics.find((c: any) => {
        const u = short(c.uuid);
        return u === want || u === `0000${want}00001000800000805f9b34fb`;
      });

    let writeChar: any = null;
    let notifyChar: any = null;

    for (const candidate of SERVICE_CANDIDATES) {
      const w = find(candidate.write);
      const n = find(candidate.notify);
      if (w && n) {
        writeChar = w;
        notifyChar = n;
        break;
      }
    }

    if (!writeChar || !notifyChar) {
      await peripheral.disconnectAsync().catch(() => {});
      const seen = characteristics.map((c: any) => c.uuid).join(', ');
      throw new Error(
        `Device exposes neither known GATT layout. Characteristics found: ${seen || 'none'}`
      );
    }

    notifyChar.on('data', (data: Buffer) => this.#onNotification(data));
    await notifyChar.subscribeAsync();

    peripheral.once('disconnect', () => {
      this.#connected = false;
      this.#writeChar = null;
    });

    this.#writeChar = writeChar;
    this.#boundId = id;
    this.#connected = true;
  }

  async unbind(): Promise<void> {
    const current = this.#boundId ? this.#peripherals.get(this.#boundId) : null;
    if (current) await current.disconnectAsync().catch(() => {});
    this.#boundId = null;
    this.#writeChar = null;
    this.#connected = false;
    this.#rxBuffer = [];
  }

  /**
   * Reassembles notifications into frames.
   *
   * BLE splits payloads at the MTU, so a 168-byte telemetry response arrives in
   * several packets. Frames always start with the slave address 0x11 and the
   * length is implied by the function code, so accumulate until the CRC checks.
   */
  #onNotification(data: Buffer): void {
    this.#rxBuffer.push(...data);

    // Resync if we somehow started mid-frame.
    while (this.#rxBuffer.length && this.#rxBuffer[0] !== 0x11) this.#rxBuffer.shift();

    while (this.#rxBuffer.length >= 5) {
      const expected = this.#expectedLength(this.#rxBuffer);
      if (expected === null || this.#rxBuffer.length < expected) return;

      const candidate = Uint8Array.from(this.#rxBuffer.slice(0, expected));
      const frame = parseFrame(candidate);

      if (frame) {
        this.#rxBuffer = this.#rxBuffer.slice(expected);
        this.emit('frame', frame);
      } else {
        // Bad CRC — drop a byte and try to resync rather than stalling forever.
        this.#rxBuffer.shift();
        while (this.#rxBuffer.length && this.#rxBuffer[0] !== 0x11) this.#rxBuffer.shift();
      }
    }
  }

  /** Total frame length implied by the header, including the 2 CRC bytes. */
  #expectedLength(bytes: number[]): number | null {
    const fn = bytes[1];
    if (fn === 0x06) return 8; // addr + fn + reg(2) + val(2) + crc(2)
    if (fn === 0x03 || fn === 0x04) {
      // These devices echo start + count before the data.
      if (bytes.length < 6) return null;
      const count = (bytes[4]! << 8) | bytes[5]!;
      return 6 + count * 2 + 2;
    }
    if (fn && fn & 0x80) return 5;
    return null;
  }

  async send(frame: Uint8Array): Promise<void> {
    const characteristic = this.#writeChar;
    if (!characteristic) throw new Error('No BLE device bound');

    const wait = WRITE_SPACING_MS - (Date.now() - this.#lastWrite);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#lastWrite = Date.now();

    // `false` = write with response, which the device requires.
    await characteristic.writeAsync(Buffer.from(frame), false);
  }

  async request(
    frame: Uint8Array,
    expect: 'input' | 'holding',
    timeoutMs = 8000
  ): Promise<ParsedFrame> {
    const wantFn = expect === 'input' ? 0x04 : 0x03;

    return new Promise<ParsedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error(`BLE timeout after ${timeoutMs}ms waiting for fn 0x0${wantFn}`));
      }, timeoutMs);

      const onFrame = (parsed: ParsedFrame) => {
        if (parsed.kind !== 'registers' || parsed.fn !== wantFn) return;
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(parsed);
      };

      this.on('frame', onFrame);

      this.send(frame).catch((err) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        reject(err);
      });
    });
  }

  onFrame(listener: (frame: ParsedFrame) => void): () => void {
    this.on('frame', listener);
    return () => this.off('frame', listener);
  }

  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void {
    this.on('discovery', listener);
    return () => this.off('discovery', listener);
  }
}
