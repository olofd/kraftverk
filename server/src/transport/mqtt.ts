import { EventEmitter } from 'node:events';

import type { ParsedFrame } from '@kraftverk/protocol';

import type { StationPresence } from '../broker/shared.ts';
import { BrokerBus, type DeviceMessage } from '../mqtt/bus.ts';
import { stationId, type StationId } from '@kraftverk/plugin-sdk';

import type { DiscoveredDevice, ServerLink, TransportHost } from './types.ts';

/**
 * MQTT: stations connect to the kraftverk broker, and we exchange MODBUS
 * frames with them over its request/response topics.
 *
 * The broker is a separate process (`src/broker/`), so that restarting the
 * server does not drop the station. This host is the server's side of that:
 * the bus it is connected over, plus a directory of who has been heard. The
 * bus is per-MAC throughout — `send(mac, frame)`, `request(mac, …)` — which is
 * what makes the links thin. A link is a MAC and a mailbox.
 */
export class MqttHost extends EventEmitter implements TransportHost {
  readonly kind = 'mqtt' as const;

  #bus: BrokerBus;
  #devices = new Map<string, DiscoveredDevice>();
  #links = new Map<StationId, MqttLink>();
  /** Kept so `stop` can detach them rather than leaving them on a shared bus. */
  #detach: (() => void)[] = [];

  constructor(bus: BrokerBus) {
    super();
    this.#bus = bus;
  }

  get bus(): BrokerBus {
    return this.#bus;
  }

  /**
   * Starts connecting to the broker, and returns once connected or after a
   * short wait. Not connecting is not a failure: the bus keeps trying, and a
   * link that is not connected is a normal resting state.
   */
  async start(): Promise<void> {
    const onMessage = (message: DeviceMessage) => {
      this.#heard(message.mac, message.at);
      // Routed, not filtered: every station that speaks reaches its own link,
      // and one that nothing is linked to is still recorded as discovered so it
      // can be added. The bus hands over a raw MAC; here it becomes a station id.
      this.#links.get(stationId(message.mac))?.receive(message.at, message.frame);
    };
    // The broker remembers stations across its own restarts and tells us on
    // connect, so a station that is offline right now can still be added.
    const onPresence = (presence: StationPresence) => {
      const seen = presence.lastMessageAt ?? presence.connectedAt ?? presence.disconnectedAt;
      this.#heard(presence.station, seen ? new Date(seen) : new Date());
    };

    this.#bus.on('message', onMessage);
    this.#bus.on('presence', onPresence);
    this.#detach = [() => this.#bus.off('message', onMessage), () => this.#bus.off('presence', onPresence)];

    this.#bus.start();
    // A moment more after connecting, for the retained presence messages that
    // follow the subscription: then the startup log can say who is connected.
    if (await this.#bus.waitForConnect(3000)) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async stop(): Promise<void> {
    for (const link of [...this.#links.values()]) await link.close();
    for (const detach of this.#detach) detach();
    this.#detach = [];
    // The server lets go of the broker. The broker — and the station — stay.
    await this.#bus.stop();
  }

  #heard(mac: string, at: Date): void {
    const existing = this.#devices.get(mac);
    const device: DiscoveredDevice = {
      id: mac,
      kind: 'mqtt',
      name: `Station ${mac}`,
      mac,
      firstSeen: existing?.firstSeen ?? at.toISOString(),
      lastSeen: existing && Date.parse(existing.lastSeen) > at.getTime() ? existing.lastSeen : at.toISOString(),
      // Anything speaking this protocol on our broker is a station.
      likelyStation: true,
    };
    this.#devices.set(mac, device);
    if (!existing) this.emit('discovery', device);
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

    const link = new MqttLink(mac, this.#bus, () => this.#links.delete(mac));
    this.#links.set(mac, link);
    return link;
  }
}

/** One station on the broker. Everything about it is its MAC. */
export class MqttLink extends EventEmitter implements ServerLink {
  readonly kind = 'mqtt' as const;

  #mac: StationId;
  #bus: BrokerBus;
  #release: () => void;
  #lastSeen: Date | null = null;

  constructor(mac: StationId, bus: BrokerBus, release: () => void) {
    super();
    this.#mac = mac;
    this.#bus = bus;
    this.#release = release;
  }

  get boundId(): StationId {
    return this.#mac;
  }

  /**
   * Whether this station is reachable right now.
   *
   * The broker knows for certain — it holds the station's socket — and says so
   * on the presence topic. Only when it has not said anything about this
   * station does the old rule apply: live if heard in the last two minutes.
   */
  get connected(): boolean {
    if (!this.#bus.connected) return false;
    const presence = this.#bus.presence(this.#mac);
    if (presence) return presence.online;
    return this.#lastSeen !== null && Date.now() - this.#lastSeen.getTime() < 120_000;
  }

  /** Called by the host when a frame for this station arrives. */
  receive(at: Date, frame: ParsedFrame | null | undefined): void {
    this.#lastSeen = at;
    if (frame) this.emit('frame', frame);
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.#bus.send(this.#mac, frame);
  }

  async request(
    frame: Uint8Array,
    expect: 'input' | 'holding',
    timeoutMs = 5000
  ): Promise<ParsedFrame> {
    // Telemetry lands on .../client/04; everything else on .../client/data —
    // write echoes included, so the answer is matched by its function code,
    // as over Bluetooth.
    const wantFn = expect === 'input' ? 0x04 : 0x03;
    return this.#bus.request(
      this.#mac,
      frame,
      expect === 'input' ? '04' : 'data',
      timeoutMs,
      (parsed) => parsed.kind === 'registers' && parsed.fn === wantFn
    );
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
