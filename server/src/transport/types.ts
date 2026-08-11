import type { ParsedFrame } from '../protocol/modbus.ts';

export type TransportKind = 'mqtt' | 'ble';

/** Something that looks like a power station, found by a transport. */
export type DiscoveredDevice = {
  /** Stable handle for binding. MAC for MQTT, peripheral id for BLE. */
  id: string;
  kind: TransportKind;
  name: string;
  mac: string | null;
  /** BLE only. */
  rssi?: number;
  firstSeen: string;
  lastSeen: string;
};

/**
 * A way to exchange MODBUS frames with a station.
 *
 * Both transports carry byte-identical frames — the BLE GATT link and the MQTT
 * bridge speak the same protocol — so everything above this interface is shared.
 */
export interface Transport {
  readonly kind: TransportKind;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Devices seen so far. */
  discovered(): DiscoveredDevice[];

  /** The device we are currently talking to, if any. */
  readonly boundId: string | null;

  bind(id: string): Promise<void>;
  unbind(): Promise<void>;

  /** True when the bound device is reachable right now. */
  readonly connected: boolean;

  send(frame: Uint8Array): Promise<void>;

  /**
   * Sends a frame and resolves with the matching response.
   * `expect` selects which response stream to wait on: telemetry (0x04) or
   * settings (0x03).
   */
  request(frame: Uint8Array, expect: 'input' | 'holding', timeoutMs?: number): Promise<ParsedFrame>;

  onFrame(listener: (frame: ParsedFrame) => void): () => void;
  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void;
}
