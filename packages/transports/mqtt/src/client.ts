import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

import mqttPacket from 'mqtt-packet';

/**
 * A small MQTT 3.1.1 client: the server's end of its connection to the broker.
 *
 * Built on `mqtt-packet`, the codec aedes itself uses, rather than on a client
 * library. The server needs QoS 0 publish, one SUBSCRIBE and a keepalive —
 * and above all a reconnect loop that never gives up, because the broker is a
 * separate process that can be restarted under it. That loop is the part that
 * matters, and it is short enough to read.
 */

export type MqttClientOptions = {
  host: string;
  port: number;
  clientId: string;
  username?: string;
  /** Asked for on every attempt, so a broker that came back with a new token is still reachable. */
  password?: () => string;
  /** Seconds. The broker drops us after 1.5× this without a packet. */
  keepalive?: number;
  /** Topic filters to subscribe to on every (re)connect. */
  subscriptions: string[];
  /** Backoff between attempts, in ms. */
  retry?: { min: number; max: number };
  /**
   * From starting an attempt to a completed SUBSCRIBE, before it is abandoned.
   * Covers the TCP connect too: a blackholed address otherwise waits out the
   * operating system's own timeout, twenty seconds or more.
   */
  handshakeTimeoutMs?: number;
};

type Events = {
  /** Connected and subscribed. */
  connect: [];
  /** An established connection went; it will be retried. The error says why, when known. */
  close: [Error | null];
  /** `retained`: the broker kept it for the topic, and sent it because we subscribed. */
  message: [topic: string, payload: Buffer, retained: boolean];
  /**
   * An attempt failed, or something went wrong on a live connection, with the
   * reason. Retried regardless. Deliberately not called `error`: an `error`
   * event nobody listens for is thrown by Node, and a reconnecting client
   * whose every failed attempt could crash its host would be a strange thing
   * to build.
   */
  failed: [Error];
};

const HANDSHAKE_TIMEOUT_MS = 5000;

const CONNACK_REASON: Record<number, string> = {
  1: 'the broker refused the protocol version',
  2: 'the broker rejected the client id',
  3: 'the broker is unavailable',
  4: 'the broker refused the token — is it a different broker, or was its token file replaced?',
  5: 'the broker says this client is not authorised',
};

export class MqttClient extends EventEmitter<Events> {
  #socket: Socket | null = null;
  #connected = false;
  #stopped = true;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #awaitingPong = false;
  #nextPacketId = 1;

  constructor(private options: MqttClientOptions) {
    super();
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Starts connecting, and keeps reconnecting until `stop`. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  /** Resolves on the next successful connect, or false after `timeoutMs`. */
  waitForConnect(timeoutMs: number): Promise<boolean> {
    if (this.#connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('connect', onConnect);
        resolve(false);
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('connect', onConnect);
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const socket = this.#socket;
    if (socket && this.#connected) {
      // A clean DISCONNECT, so the broker's journal says we left on purpose —
      // but not waited on for ever: a half-dead socket may never flush it.
      await Promise.race([
        new Promise<void>((resolve) => socket.write(mqttPacket.generate({ cmd: 'disconnect' }), () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    socket?.destroy();
    this.#teardown(null);
  }

  /** QoS 0, fire and forget. Rejects only when not connected or the write fails. */
  publish(topic: string, payload: Uint8Array | string): Promise<void> {
    const socket = this.#socket;
    if (!socket || !this.#connected) {
      return Promise.reject(new Error('Not connected to the MQTT broker'));
    }
    const packet = mqttPacket.generate({
      cmd: 'publish',
      topic,
      payload: typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload),
      qos: 0,
      retain: false,
      dup: false,
    });
    return new Promise((resolve, reject) => {
      socket.write(packet, (error) => (error ? reject(error) : resolve()));
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#attempt++;

    const socket = connect({ host: this.options.host, port: this.options.port });
    this.#socket = socket;
    socket.setNoDelay(true);

    const parser = mqttPacket.parser({ protocolVersion: 4 });
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
      socket.destroy();
    };

    /*
      Something that accepts TCP but never speaks MQTT — another service on the
      port, a broker wedged mid-start — would otherwise hold this attempt open
      for ever, and with it the whole reconnect loop.
    */
    const handshake = setTimeout(
      () => fail(new Error(`${this.options.host}:${this.options.port} accepted the connection but did not complete an MQTT handshake`)),
      this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    );

    parser.on('packet', (packet) => {
      switch (packet.cmd) {
        case 'connack': {
          const code = packet.returnCode ?? 0;
          if (code !== 0) {
            fail(new Error(CONNACK_REASON[code] ?? `the broker refused the connection (code ${code})`));
            return;
          }
          socket.write(
            mqttPacket.generate({
              cmd: 'subscribe',
              messageId: this.#packetId(),
              subscriptions: this.options.subscriptions.map((topic) => ({ topic, qos: 0 })),
            })
          );
          return;
        }
        case 'suback': {
          clearTimeout(handshake);
          const refused = (packet.granted as number[]).findIndex((granted) => granted === 0x80);
          if (refused !== -1) {
            this.emit('failed', new Error(`The broker refused the subscription to ${this.options.subscriptions[refused]}`));
          }
          this.#connected = true;
          this.#attempt = 0;
          this.#startPing(socket);
          this.emit('connect');
          return;
        }
        case 'publish':
          this.emit(
            'message',
            packet.topic,
            typeof packet.payload === 'string' ? Buffer.from(packet.payload) : Buffer.from(packet.payload),
            packet.retain === true
          );
          return;
        case 'pingresp':
          this.#awaitingPong = false;
          return;
        default:
          return;
      }
    });
    parser.on('error', fail);

    socket.on('connect', () => {
      // Asked for now, not at construction: the token can change under a
      // long-running server, and reading it can fail. A failure here is this
      // attempt's failure, not an exception thrown out of a socket callback.
      let password: Buffer | undefined;
      try {
        password = this.options.password ? Buffer.from(this.options.password()) : undefined;
      } catch (error) {
        fail(error as Error);
        return;
      }
      socket.write(
        mqttPacket.generate({
          cmd: 'connect',
          protocolId: 'MQTT',
          protocolVersion: 4,
          clean: true,
          clientId: this.options.clientId,
          keepalive: this.options.keepalive ?? 30,
          username: this.options.username,
          password,
        })
      );
    });
    // No encoding is ever set on this socket, so every chunk is a Buffer.
    socket.on('data', (chunk) => parser.parse(chunk as Buffer));
    socket.on('error', (error) => {
      failure ??= error;
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      if (this.#socket !== socket) return;
      const wasConnected = this.#connected;
      this.#teardown(failure);
      // A connection that never came up has no `close` to report, but its
      // reason — refused, wrong token, no handshake — is exactly what a person
      // looking at "not connected" needs.
      if (!wasConnected && failure) this.emit('failed', failure);
      this.#scheduleReconnect();
    });
  }

  #teardown(error: Error | null): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    this.#awaitingPong = false;
    const was = this.#connected;
    this.#connected = false;
    this.#socket = null;
    if (was) this.emit('close', error);
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const { min, max } = this.options.retry ?? { min: 250, max: 5000 };
    const delay = Math.min(max, min * 2 ** Math.min(this.#attempt, 10));
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  /**
   * PINGREQ every keepalive period, and a dead connection is one that did not
   * answer the previous ping. Without this, a broker that vanished without a
   * FIN — a killed process on some platforms, a sleeping laptop — would leave
   * the server believing it was connected.
   */
  #startPing(socket: Socket): void {
    const every = (this.options.keepalive ?? 30) * 1000;
    this.#pingTimer = setInterval(() => {
      if (this.#awaitingPong) {
        socket.destroy(new Error('The broker stopped answering pings'));
        return;
      }
      this.#awaitingPong = true;
      socket.write(mqttPacket.generate({ cmd: 'pingreq' }));
    }, every);
  }

  #packetId(): number {
    const id = this.#nextPacketId;
    this.#nextPacketId = id >= 65535 ? 1 : id + 1;
    return id;
  }
}
