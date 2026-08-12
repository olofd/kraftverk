import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';

import { Aedes } from 'aedes';

import { parseFrame, toHex, type ParsedFrame } from '@kraftverk/protocol';

/**
 * An MQTT broker the power station talks to instead of the vendor cloud.
 *
 * The device resolves `mqtt.sydpower.com` and connects on port 1883. Point that
 * hostname at this machine (router DNS / Pi-hole) and it lands here instead.
 *
 * The device authenticates with credentials it fetched from the Sydpower cloud,
 * which we cannot predict — so the broker accepts anyone. Bind it to your LAN,
 * not the internet.
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

export type BrokerEvents = {
  message: [DeviceMessage];
  deviceSeen: [string];
  clientConnected: [string];
  clientDisconnected: [string];
};

const RESPONSE_TOPIC = /^([0-9A-Fa-f]{12})\/device\/response\/(?:client\/)?(\w+)$/;

export class DeviceBroker extends EventEmitter<BrokerEvents> {
  #aedes: Aedes | null = null;
  #server: Server | null = null;
  #devices = new Map<string, Date>();
  /** Rolling log for the diagnostics screen. */
  #log: DeviceMessage[] = [];
  #logLimit = 200;

  get devices(): { mac: string; lastSeen: string }[] {
    return [...this.#devices.entries()].map(([mac, at]) => ({
      mac,
      lastSeen: at.toISOString(),
    }));
  }

  get recentMessages(): DeviceMessage[] {
    return this.#log;
  }

  get listening(): boolean {
    return this.#server?.listening ?? false;
  }

  async start(port: number, host: string): Promise<void> {
    const aedes = await Aedes.createBroker();
    this.#aedes = aedes;

    aedes.on('client', (client) => this.emit('clientConnected', client.id));
    aedes.on('clientDisconnect', (client) => this.emit('clientDisconnected', client.id));

    aedes.on('publish', (packet, client) => {
      // Ignore our own publishes and broker-internal $SYS topics.
      if (!client) return;

      const match = RESPONSE_TOPIC.exec(packet.topic);
      if (!match) return;

      const mac = match[1]!.toUpperCase();
      const channel = match[2]!;
      const payload = new Uint8Array(packet.payload as Buffer);

      if (!this.#devices.has(mac)) this.emit('deviceSeen', mac);
      this.#devices.set(mac, new Date());

      const message: DeviceMessage = {
        mac,
        topic: packet.topic,
        channel,
        payload,
        frame: parseFrame(payload),
        at: new Date(),
      };

      this.#log.push(message);
      if (this.#log.length > this.#logLimit) this.#log.shift();

      this.emit('message', message);
    });

    const server = createServer(aedes.handle as never);
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  /** Publishes a raw MODBUS frame to the device's request topic. */
  send(mac: string, frame: Uint8Array): Promise<void> {
    const aedes = this.#aedes;
    if (!aedes) throw new Error('broker not started');

    return new Promise((resolve, reject) => {
      aedes.publish(
        {
          cmd: 'publish',
          topic: `${mac.toUpperCase()}/client/request/data`,
          payload: Buffer.from(frame),
          qos: 0,
          retain: false,
          dup: false,
        } as never,
        (err?: Error | null) => (err ? reject(err) : resolve())
      );
    });
  }

  /**
   * Sends a frame and waits for the next response on `channel` from that device.
   * The protocol has no request/response correlation id, so this pairs by
   * arrival order — keep requests serialised.
   */
  async request(
    mac: string,
    frame: Uint8Array,
    channel: string,
    timeoutMs = 5000
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
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(message.frame);
      };

      this.on('message', onMessage);

      this.send(target, frame).catch((err) => {
        clearTimeout(timer);
        this.off('message', onMessage);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => this.#aedes?.close(() => resolve()) ?? resolve());
    this.#server = null;
    this.#aedes = null;
  }
}

/** Compact form for the diagnostics endpoint. */
export const describeMessage = (m: DeviceMessage) => ({
  at: m.at.toISOString(),
  mac: m.mac,
  topic: m.topic,
  bytes: m.payload.length,
  hex: toHex(m.payload).slice(0, 400),
  frame:
    m.frame?.kind === 'registers'
      ? { kind: 'registers', fn: m.frame.fn, start: m.frame.start, count: m.frame.values.length }
      : m.frame,
});
