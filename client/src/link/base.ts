import {
  FrameAssembler,
  WRITE_SPACING_MS,
  type DiscoveredDevice,
  type ParsedFrame,
  type StationTransport,
  type TransportKind,
} from '@kraftverk/protocol';

/**
 * The parts of a direct Bluetooth link that are the same in a browser and on a
 * phone: frame reassembly, pairing a request with its response, write spacing,
 * and the listener bookkeeping `StationTransport` requires.
 *
 * Web Bluetooth and react-native-ble-plx agree on almost nothing else — one
 * hands you a `DataView`, the other a base64 string; one has a device chooser,
 * the other a scan callback — so the subclasses stay small and this stays
 * shared. The protocol itself is a level further up, in `@kraftverk/protocol`,
 * which the server uses too.
 */

type FrameListener = (frame: ParsedFrame) => void;
type DiscoveryListener = (device: DiscoveredDevice) => void;

export abstract class DirectBleTransport implements StationTransport {
  abstract readonly kind: TransportKind;

  protected assembler = new FrameAssembler();
  protected devices = new Map<string, DiscoveredDevice>();

  #frameListeners = new Set<FrameListener>();
  #discoveryListeners = new Set<DiscoveryListener>();
  #lastWrite = 0;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract bind(id: string): Promise<void>;
  abstract unbind(): Promise<void>;
  abstract get boundId(): string | null;
  abstract get connected(): boolean;

  /** Puts one frame on the wire. Spacing and assembly are handled here. */
  protected abstract writeFrame(frame: Uint8Array): Promise<void>;

  discovered(): DiscoveredDevice[] {
    return [...this.devices.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  /** Records a sighting, announcing only the first one per device. */
  protected announce(device: DiscoveredDevice): void {
    const existing = this.devices.get(device.id);
    const merged: DiscoveredDevice = { ...device, firstSeen: existing?.firstSeen ?? device.firstSeen };
    this.devices.set(device.id, merged);
    if (!existing) for (const listener of this.#discoveryListeners) listener(merged);
  }

  /** Feeds received bytes through the assembler and publishes whole frames. */
  protected ingest(chunk: ArrayLike<number>): void {
    for (const frame of this.assembler.push(chunk)) {
      for (const listener of this.#frameListeners) listener(frame);
    }
  }

  async send(frame: Uint8Array): Promise<void> {
    // The station drops frames sent too close together, silently.
    const wait = WRITE_SPACING_MS - (Date.now() - this.#lastWrite);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastWrite = Date.now();
    await this.writeFrame(frame);
  }

  /**
   * Sends a request and resolves with the next response of the right kind.
   *
   * The protocol has no correlation id, so this pairs by function code and
   * arrival order — which is safe only because `StationClient` serialises
   * every exchange.
   */
  request(frame: Uint8Array, expect: 'input' | 'holding', timeoutMs = 8000): Promise<ParsedFrame> {
    const wantFn = expect === 'input' ? 0x04 : 0x03;

    return new Promise<ParsedFrame>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const stop = this.onFrame((parsed) => {
        if (parsed.kind !== 'registers' || parsed.fn !== wantFn) return;
        clearTimeout(timer);
        stop();
        resolve(parsed);
      });

      timer = setTimeout(() => {
        stop();
        reject(new Error(`Bluetooth timed out after ${timeoutMs}ms waiting for fn 0x0${wantFn}`));
      }, timeoutMs);

      this.send(frame).catch((error) => {
        clearTimeout(timer);
        stop();
        reject(error);
      });
    });
  }

  onFrame(listener: FrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onDiscovery(listener: DiscoveryListener): () => void {
    this.#discoveryListeners.add(listener);
    return () => this.#discoveryListeners.delete(listener);
  }
}
