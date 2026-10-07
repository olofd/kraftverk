import { EventEmitter } from 'node:events';

import { SERVER_USERNAME, TOPIC, type DevicePresence, type JournalEntry } from './broker/shared.ts';
import { MqttClient } from './client.ts';

/**
 * The server's view of the broker: devices' messages in, commands out.
 *
 * The broker is its own process, and this is the server's connection to it —
 * as the one privileged client that may publish commands. It subscribes to
 * everything devices publish, and each connection's protocol picks out its own
 * device's topics; it knows no protocol itself. It adds what only the broker can
 * know: whether each device is connected right now, from the retained presence
 * topics, and the broker's journal as it is written.
 */

export type BusMessage = { topic: string; payload: Uint8Array; at: Date };

/** Whether a topic filter matches a topic, MQTT's way (`+` one level, `#` the rest). */
export type TopicMatch = (filter: string, topic: string) => boolean;

type Events = {
  message: [BusMessage];
  presence: [DevicePresence];
  journal: [JournalEntry];
  connected: [];
  disconnected: [Error | null];
  /** Why the server cannot connect or subscribe — once per distinct reason. */
  failed: [Error];
};

export type BrokerBusOptions = {
  host: string;
  port: number;
  token: () => string;
};

const presenceKey = (protocol: string, address: string) => `${protocol}:${address}`;

export class BrokerBus extends EventEmitter<Events> {
  #client: MqttClient;
  #presence = new Map<string, DevicePresence>();
  #connectedAt: Date | null = null;
  #lastError: string | null = null;
  /**
   * What the broker keeps, by topic: every message it sent as retained, and
   * each later one on the same topic. The server subscribes once, at its
   * start, so a channel opened afterwards would otherwise never hear what a
   * device left there — a bridge's list of its devices, its state.
   */
  #retained = new Map<string, BusMessage>();

  constructor(options: BrokerBusOptions) {
    super();
    /*
      No cap on listeners. Every open channel listens here, and every request
      in flight adds one more; Node warns at ten and calls it a leak. They are
      removed on every outcome.
    */
    this.setMaxListeners(0);

    this.#client = new MqttClient({
      host: options.host,
      port: options.port,
      // Unique per process: a server restarting quickly must not take over its
      // predecessor's session — or be taken over by it. Short, because MQTT
      // only obliges a broker to accept 23 characters, and a pid can be seven.
      clientId: `kraftverk-srv-${process.pid.toString(36)}`,
      username: SERVER_USERNAME,
      password: options.token,
      keepalive: 15,
      subscriptions: [TOPIC.everything, TOPIC.presenceFilter, TOPIC.journal],
    });

    this.#client.on('connect', () => {
      this.#connectedAt = new Date();
      this.#lastError = null;
      this.emit('connected');
    });
    this.#client.on('close', (error) => {
      this.#connectedAt = null;
      this.#lastError = error?.message ?? 'the connection closed';
      /*
        Forgotten, not kept. Presence is the broker's word about *now*, and a
        broker that restarted may not know a device the old one did — so an
        entry left from before would say "online" about a device nobody can
        reach. The retained messages restore it on reconnect.
      */
      this.#presence.clear();
      // Likewise: the broker sends them all again when the subscription is made again.
      this.#retained.clear();
      this.emit('disconnected', error);
    });
    this.#client.on('failed', (error) => {
      const repeat = error.message === this.#lastError;
      this.#lastError = error.message;
      // Once per distinct reason: the client retries every few seconds.
      if (!repeat) this.emit('failed', error);
    });
    this.#client.on('message', (topic, payload, retained) => this.#onMessage(topic, payload, retained));
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  get connectedAt(): Date | null {
    return this.#connectedAt;
  }

  /** Why the last attempt or connection failed. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** Every device the broker has told us about, connected or not. */
  get devices(): DevicePresence[] {
    return [...this.#presence.values()];
  }

  /** What the broker says about the device at `address`, under any protocol. */
  presence(address: string): DevicePresence | null {
    for (const presence of this.#presence.values()) if (presence.address === address) return presence;
    return null;
  }

  /** What the broker keeps on the topics `filter` matches: what a new subscription to it is sent first. */
  retained(filter: string, matches: TopicMatch): BusMessage[] {
    return [...this.#retained.values()].filter((message) => matches(filter, message.topic));
  }

  start(): void {
    this.#client.start();
  }

  waitForConnect(timeoutMs: number): Promise<boolean> {
    return this.#client.waitForConnect(timeoutMs);
  }

  /** Disconnects the server. The broker, and the devices on it, carry on. */
  async stop(): Promise<void> {
    await this.#client.stop();
  }

  /**
   * Publishes a command. Fails at once, saying why, when the broker cannot be
   * reached — rather than publishing into nothing and timing out later.
   */
  async publish(topic: string, payload: Uint8Array): Promise<void> {
    if (!this.#client.connected) {
      throw new Error('The server is not connected to the MQTT broker, so nothing can reach the device');
    }
    await this.#client.publish(topic, payload);
  }

  #onMessage(topic: string, payload: Buffer, retained: boolean): void {
    if (topic.startsWith('$kraftverk/device/')) {
      try {
        const presence = JSON.parse(payload.toString('utf8')) as DevicePresence;
        this.#presence.set(presenceKey(presence.protocol, presence.address), presence);
        this.emit('presence', presence);
      } catch {
        // A presence message that does not parse is the broker's bug, not a reason to stop.
      }
      return;
    }

    if (topic === TOPIC.journal) {
      try {
        this.emit('journal', JSON.parse(payload.toString('utf8')) as JournalEntry);
      } catch {
        // As above.
      }
      return;
    }

    const message = { topic, payload: new Uint8Array(payload), at: new Date() };
    // Kept when the broker keeps it, and followed after: a later message on a kept topic replaces it, an empty one clears it.
    if (retained || this.#retained.has(topic)) {
      if (payload.length === 0) this.#retained.delete(topic);
      else this.#retained.set(topic, message);
    }
    this.emit('message', message);
  }
}
