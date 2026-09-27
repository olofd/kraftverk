import { EventEmitter } from 'node:events';

import { commandRefusal, parseFrame, type ParsedFrame } from '@kraftverk/protocol';

import { RESPONSE_TOPIC } from '../broker/policy.ts';
import { SERVER_USERNAME, TOPIC, type JournalEntry, type StationPresence } from '../broker/shared.ts';
import { MqttClient } from './client.ts';

/**
 * The server's view of the broker: stations' frames in, commands out.
 *
 * The broker is its own process now, and this is the server's connection to
 * it — as the one privileged client that may publish to a station's command
 * topic. What it offers the rest of the server is what the in-process broker
 * used to: `send`, `request` and a `message` event per frame, keyed by MAC. It
 * adds what only the broker can know: whether each station is connected right
 * now, from the retained presence topic, and the broker's journal as it is
 * written.
 */

export type DeviceMessage = {
  mac: string;
  topic: string;
  /** Trailing topic segment: '04', 'data', 'state'. */
  channel: string;
  payload: Uint8Array;
  frame: ParsedFrame | null;
  at: Date;
};

type Events = {
  message: [DeviceMessage];
  presence: [StationPresence];
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

export class BrokerBus extends EventEmitter<Events> {
  #client: MqttClient;
  #presence = new Map<string, StationPresence>();
  #connectedAt: Date | null = null;
  #lastError: string | null = null;

  constructor(options: BrokerBusOptions) {
    super();
    /*
      No cap on `message` listeners. `request` attaches one per exchange in
      flight, and every linked station has one in flight while it polls; Node
      warns at ten and calls it a leak. They are removed on every outcome.
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
      subscriptions: [TOPIC.responses, TOPIC.presenceFilter, TOPIC.journal],
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
        broker that restarted may not know a station the old one did — so an
        entry left from before would say "online" about a station nobody can
        reach. The retained messages restore it on reconnect.
      */
      this.#presence.clear();
      this.emit('disconnected', error);
    });
    this.#client.on('failed', (error) => {
      const repeat = error.message === this.#lastError;
      this.#lastError = error.message;
      // Once per distinct reason: the client retries every few seconds.
      if (!repeat) this.emit('failed', error);
    });
    this.#client.on('message', (topic, payload) => this.#onMessage(topic, payload));
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

  /** Every station the broker has told us about, connected or not. */
  get stations(): StationPresence[] {
    return [...this.#presence.values()];
  }

  presence(mac: string): StationPresence | null {
    return this.#presence.get(mac.toUpperCase()) ?? null;
  }

  start(): void {
    this.#client.start();
  }

  waitForConnect(timeoutMs: number): Promise<boolean> {
    return this.#client.waitForConnect(timeoutMs);
  }

  /** Disconnects the server. The broker, and the stations on it, carry on. */
  async stop(): Promise<void> {
    await this.#client.stop();
  }

  /** Publishes a raw MODBUS frame to the station's command topic. */
  async send(mac: string, frame: Uint8Array): Promise<void> {
    /*
      Refused here as well as at the broker. The broker would refuse it too —
      and close this connection for trying, dropping every station's traffic
      for as long as the reconnect takes. Better that it never leaves.
    */
    const refusal = commandRefusal(frame);
    if (refusal) throw new Error(refusal);

    const target = mac.toUpperCase();
    if (!this.#client.connected) {
      throw new Error('The server is not connected to the MQTT broker, so nothing can reach the station');
    }
    /*
      Fail at once, saying why, rather than publishing into a topic nobody is
      subscribed to and timing out five seconds later. The broker announces
      every station it has ever seen, retained, the moment we subscribe — so no
      presence at all means it has never seen this one.
    */
    const presence = this.#presence.get(target);
    if (!presence) {
      throw new Error(`${target} has not connected to the broker`);
    }
    if (!presence.online) {
      throw new Error(`${target} is not connected to the broker${presence.lastDisconnect ? ` (it left: ${presence.lastDisconnect})` : ''}`);
    }
    await this.#client.publish(TOPIC.commands(target), frame);
  }

  /**
   * Sends a frame and waits for the next response on `channel` from that device
   * that `accept` recognises as the answer.
   *
   * The protocol has no request/response correlation id, so this pairs by
   * arrival order — keep requests serialised — and by kind: a write's echo or
   * an exception shares the channel with a settings read, and must not be
   * taken for its answer.
   */
  request(
    mac: string,
    frame: Uint8Array,
    channel: string,
    timeoutMs = 5000,
    accept: (frame: ParsedFrame) => boolean = () => true
  ): Promise<ParsedFrame> {
    const target = mac.toUpperCase();

    return new Promise<ParsedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${target}/${channel}`));
      }, timeoutMs);

      const onMessage = (message: DeviceMessage) => {
        if (message.mac !== target || message.channel !== channel) return;
        if (!message.frame) return; // malformed or bad CRC — keep waiting
        if (!accept(message.frame)) return; // something else on the same channel
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(message.frame);
      };

      this.on('message', onMessage);

      this.send(target, frame).catch((error) => {
        clearTimeout(timer);
        this.off('message', onMessage);
        reject(error);
      });
    });
  }

  #onMessage(topic: string, payload: Buffer): void {
    if (topic.startsWith('$kraftverk/station/')) {
      try {
        const presence = JSON.parse(payload.toString('utf8')) as StationPresence;
        this.#presence.set(presence.station, presence);
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

    const match = RESPONSE_TOPIC.exec(topic);
    if (!match) return;
    const bytes = new Uint8Array(payload);
    this.emit('message', {
      mac: match[1]!.toUpperCase(),
      topic,
      channel: match[2]!,
      payload: bytes,
      frame: parseFrame(bytes),
      at: new Date(),
    });
  }
}
