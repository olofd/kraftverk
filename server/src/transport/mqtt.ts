import { EventEmitter } from 'node:events';

import type { ParsedFrame } from '@kraftverk/protocol';

import { DeviceBroker, type DeviceMessage } from '../mqtt/broker.ts';
import { stationId, type StationId } from '@kraftverk/plugin-sdk';

import type { DiscoveredDevice, ServerLink, TransportHost } from './types.ts';

/**
 * MQTT: the station connects to our embedded broker (after mqtt.sydpower.com is
 * pointed at this machine) and we exchange MODBUS frames over its
 * request/response topics.
 *
 * There was never a reason this could only serve one station. `DeviceBroker`
 * has always been per-MAC — `send(mac, frame)`, `request(mac, …)` — and has
 * always tracked every station that connects. The old transport read all of
 * their frames off the broker and then threw away everything that did not match
 * a single `boundId`. A second station's telemetry was arriving and being
 * discarded by one line.
 *
 * So the host is a thin thing: the broker plus a directory of who has been
 * heard. The links are thinner still — a MAC, and a filter.
 */
export class MqttHost extends EventEmitter implements TransportHost {
  readonly kind = 'mqtt' as const;

  #broker: DeviceBroker;
  #port: number;
  #host: string;
  #devices = new Map<string, DiscoveredDevice>();
  #links = new Map<StationId, MqttLink>();

  constructor(broker: DeviceBroker, port: number, host: string) {
    super();
    this.#broker = broker;
    this.#port = port;
    this.#host = host;
  }

  get broker(): DeviceBroker {
    return this.#broker;
  }

  /** Kept so `stop` can detach it rather than leaving it on a shared broker. */
  #onMessage: ((message: DeviceMessage) => void) | null = null;

  async start(): Promise<void> {
    await this.#broker.start(this.#port, this.#host);

    this.#onMessage = (message) => {
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

      // Routed, not filtered: every station that speaks reaches its own link,
      // and one that nothing is linked to is still recorded as discovered so it
      // can be added.
      // The broker hands over a raw MAC; this is where it becomes a station id.
      this.#links.get(stationId(message.mac))?.receive(now, message.frame);
    };

    this.#broker.on('message', this.#onMessage);
  }

  async stop(): Promise<void> {
    for (const link of [...this.#links.values()]) await link.close();
    // Detached explicitly: the broker outlives this host, so a handler left
    // behind would keep routing frames into a stopped host's link map — and a
    // second `start` would then deliver every frame twice.
    if (this.#onMessage) this.#broker.off('message', this.#onMessage);
    this.#onMessage = null;
    await this.#broker.stop();
  }

  discovered(): DiscoveredDevice[] {
    return [...this.#devices.values()];
  }

  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void {
    this.on('discovery', listener);
    return () => this.off('discovery', listener);
  }

  openIds(): StationId[] {
    return [...this.#links.keys()];
  }

  async open(station: StationId): Promise<ServerLink> {
    const mac = stationId(station.toUpperCase());
    // Refused rather than shared. Handing the same link to two owners means two
    // drivers polling one station and whichever closes first taking it from the
    // other — a corruption that would show up as a device going quiet for no
    // stated reason. The manager claims stations before opening them, so this
    // is a guard against a bug here, not an expected outcome.
    if (this.#links.has(mac)) throw new Error(`${mac} is already linked`);

    const link = new MqttLink(mac, this.#broker, () => this.#links.delete(mac));
    this.#links.set(mac, link);
    return link;
  }
}

/** One station on the broker. Everything about it is its MAC. */
export class MqttLink extends EventEmitter implements ServerLink {
  readonly kind = 'mqtt' as const;

  #mac: StationId;
  #broker: DeviceBroker;
  #release: () => void;
  #lastSeen: Date | null = null;

  constructor(mac: StationId, broker: DeviceBroker, release: () => void) {
    super();
    this.#mac = mac;
    this.#broker = broker;
    this.#release = release;
  }

  get boundId(): StationId {
    return this.#mac;
  }

  /** Considered live if this station has spoken in the last two minutes. */
  get connected(): boolean {
    return this.#lastSeen !== null && Date.now() - this.#lastSeen.getTime() < 120_000;
  }

  /** Called by the host when a frame for this station arrives. */
  receive(at: Date, frame: ParsedFrame | null | undefined): void {
    this.#lastSeen = at;
    if (frame) this.emit('frame', frame);
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.#broker.send(this.#mac, frame);
  }

  async request(
    frame: Uint8Array,
    expect: 'input' | 'holding',
    timeoutMs = 5000
  ): Promise<ParsedFrame> {
    // Telemetry lands on .../client/04; everything else on .../client/data.
    return this.#broker.request(this.#mac, frame, expect === 'input' ? '04' : 'data', timeoutMs);
  }

  onFrame(listener: (frame: ParsedFrame) => void): () => void {
    this.on('frame', listener);
    return () => this.off('frame', listener);
  }

  async close(): Promise<void> {
    this.removeAllListeners();
    this.#release();
  }
}
