import { EventEmitter } from 'node:events';

import type { ParsedFrame } from '@kraftverk/protocol';

import { DeviceBroker } from '../mqtt/broker.ts';
import type { DiscoveredDevice, Transport } from './types.ts';

/**
 * MQTT transport: the station connects to our embedded broker (after
 * mqtt.sydpower.com is pointed at this machine) and we exchange MODBUS frames
 * over its request/response topics.
 */
export class MqttTransport extends EventEmitter implements Transport {
  readonly kind = 'mqtt' as const;

  #broker: DeviceBroker;
  #port: number;
  #host: string;
  #devices = new Map<string, DiscoveredDevice>();
  #boundId: string | null = null;
  #lastSeen: Date | null = null;

  constructor(broker: DeviceBroker, port: number, host: string) {
    super();
    this.#broker = broker;
    this.#port = port;
    this.#host = host;
  }

  get broker(): DeviceBroker {
    return this.#broker;
  }

  get boundId(): string | null {
    return this.#boundId;
  }

  /** Considered live if the bound station has spoken in the last two minutes. */
  get connected(): boolean {
    if (!this.#boundId || !this.#lastSeen) return false;
    return Date.now() - this.#lastSeen.getTime() < 120_000;
  }

  async start(): Promise<void> {
    await this.#broker.start(this.#port, this.#host);

    this.#broker.on('message', (message) => {
      const now = new Date();
      const existing = this.#devices.get(message.mac);
      const device: DiscoveredDevice = {
        id: message.mac,
        kind: 'mqtt',
        name: `Station ${message.mac}`,
        mac: message.mac,
        firstSeen: existing?.firstSeen ?? now.toISOString(),
        lastSeen: now.toISOString(),
        // Anything speaking this protocol on our broker is a station.
        likelyStation: true,
      };
      this.#devices.set(message.mac, device);
      if (!existing) this.emit('discovery', device);

      if (message.mac !== this.#boundId) return;
      this.#lastSeen = now;
      if (message.frame) this.emit('frame', message.frame);
    });
  }

  async stop(): Promise<void> {
    await this.#broker.stop();
  }

  discovered(): DiscoveredDevice[] {
    return [...this.#devices.values()];
  }

  async bind(id: string): Promise<void> {
    this.#boundId = id.toUpperCase();
    this.#lastSeen = null;
  }

  async unbind(): Promise<void> {
    this.#boundId = null;
    this.#lastSeen = null;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.#boundId) throw new Error('No station bound');
    await this.#broker.send(this.#boundId, frame);
  }

  async request(
    frame: Uint8Array,
    expect: 'input' | 'holding',
    timeoutMs = 5000
  ): Promise<ParsedFrame> {
    if (!this.#boundId) throw new Error('No station bound');
    // Telemetry lands on .../client/04; everything else on .../client/data.
    return this.#broker.request(this.#boundId, frame, expect === 'input' ? '04' : 'data', timeoutMs);
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
