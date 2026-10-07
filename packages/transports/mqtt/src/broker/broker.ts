import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import { Aedes } from 'aedes';
import type { Client } from 'aedes';

import type { MessageBrokerPolicy } from '@kraftverk/device-sdk';

import { duration, type Journal } from './journal.ts';
import { commandOf, deviceOf, guardOf, isSecret, refusalFor, type Policies } from './policy.ts';
import { clientsFingerprint, RESERVED_CLIENT_PREFIX, SERVER_USERNAME, sameSecret, TOPIC, type DevicePresence } from './shared.ts';

/**
 * The MQTT broker devices talk to instead of their vendor's cloud.
 *
 * A Sydpower station gets here two ways, both on port 1883 in plain MQTT:
 * BrightEMS 1.6.0+ has a *Local MQTT Broker* setting that takes this machine's
 * address directly, and older firmware can be caught by pointing
 * `mqtt.sydpower.com` at this machine in the router or a Pi-hole.
 *
 * It runs in its own process (see `main.ts`) and knows nothing about saved
 * devices or the database — and no protocol of its own. It does three things:
 *
 * 1. **Carries messages.** Devices publish on their own topics; the server,
 *    connected as the one privileged client, subscribes to everything and
 *    publishes commands.
 * 2. **Refuses what must never reach a device** — see `policy.ts`, which
 *    applies each installed protocol's rules.
 * 3. **Writes down everything** — every socket, handshake, subscription,
 *    message and disconnect, with the reason — because a device's behaviour is
 *    often undocumented and the journal is how it gets documented.
 *
 * Which device a connection speaks for is learned from what it does — the
 * topics it publishes and subscribes to, as its protocol reads them — not from
 * what it calls itself.
 *
 * Bind it to your LAN, never the internet.
 */

export type BrokerOptions = {
  host: string;
  port: number;
  /** The secret the server proves itself with. */
  token: string;
  /**
   * Clients that sign in, by name, each with its password: a bridge, one
   * client for many devices. Signed in, a client may speak for the devices of a protocol
   * that asks for it (`MessageBrokerPolicy.signedIn`). None by default.
   */
  clients?: ReadonlyMap<string, string>;
  journal: Journal;
  /** The installed protocols' rules. At least one. */
  policies: Policies;
  /** Where known devices are remembered between runs. Null to forget them. */
  devicesFile: string | null;
  /**
   * Where what is kept on each topic (retained) is kept between runs. A
   * broker restarted — by a deploy — would otherwise start empty, and a
   * bridge's quiet devices would say nothing of themselves until they next
   * changed: a sensor, for an hour. Null to keep it in memory only.
   */
  retainedFile?: string | null;
  /** How often to check for devices that have not come back. */
  watchdogMs?: number;
};

/** A publish the broker refused, for diagnostics. */
export type RefusedPublish = {
  at: string;
  clientId: string | null;
  remote: string | null;
  topic: string;
  reason: string;
  /** The command, when it was one, in words. */
  frame: string | null;
};

/** One TCP connection, from accept to close. */
type Connection = {
  n: number;
  remote: string;
  socket: Socket;
  openedAt: number;
  clientId: string | null;
  privileged: boolean;
  /** The name it signed in with, when it is one of the broker's clients (`BrokerOptions.clients`). */
  signedIn: string | null;
  /** Set once the broker has sent a successful CONNACK. */
  connectedAt: number | null;
  connect: {
    protocol: string;
    keepalive: number;
    clean: boolean;
    username: string | null;
    passwordBytes: number;
    will: { topic: string; bytes: number; retain: boolean; qos: number } | null;
  } | null;
  subscriptions: Set<string>;
  /** The device this connection speaks for, once it has said: its record's key. */
  device: string | null;
  lastPacketAt: number;
  pings: number;
  /** The first known cause of the end, if one was seen before the socket closed. */
  endReason: string | null;
  graceful: boolean;
  peerEnded: boolean;
  socketError: string | null;
};

type DeviceRecord = DevicePresence & {
  connection: Connection | null;
  messagesIn: number;
  commandsOut: number;
  unprompted: number;
  lastUnpromptedAt: number | null;
  /** The interval between the last two unprompted pushes, in ms. */
  pushIntervalMs: number | null;
  /** Commands awaiting a reply, by what the reply will look like. */
  pending: Map<string, number>;
  /** Absence alerts already raised during the current absence, in ms thresholds. */
  alerted: Set<number>;
};

/** How long a gap before the broker says a device has not come back. */
const ABSENCE_ALERTS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000];

/** A reply later than this is treated as an unprompted push rather than an answer. */
const REPLY_WINDOW_MS = 10_000;

/** One record per device, keyed by protocol and address — the address as its protocol gives it. */
const keyOf = (protocol: string, address: string) => `${protocol}:${address}`;

/** Kinds that are a device's every word: kept in the file and the journal, not sent on to the server as they happen. */
const CHATTER = new Set(['device.message', 'mqtt.publish']);

/** How long one client's traffic that no protocol knows is journalled at info, before it is debug until the next window. */
const UNKNOWN_TRAFFIC_WINDOW_MS = 60_000;

/** How long after a retained message changes what is kept is written: one write for many reports. */
const KEEP_RETAINED_MS = 30_000;

export class MessageBroker {
  #aedes: Aedes | null = null;
  #server: Server | null = null;
  #connections = new Map<Socket, Connection>();
  #devices = new Map<string, DeviceRecord>();
  #refusals: RefusedPublish[] = [];
  /** Devices already warned about during the current run of undeliverable commands. */
  #undelivered = new Set<string>();
  /** When each client's traffic that no protocol knows was last journalled at info. */
  #unknownSaid = new Map<string, number>();
  /**
   * The topics on which a message is kept (retained), as published. MQTT
   * clears the retain flag on what it forwards to a subscription that already
   * exists; the server subscribed long before most of them were said, and
   * needs to know which are kept — it replays them to a channel opened later
   * (`BrokerBus`). So it is told: what it is sent on a kept topic says so.
   */
  #retained = new Map<string, Uint8Array>();
  #saveRetainedTimer: ReturnType<typeof setTimeout> | null = null;
  #nextConnection = 0;
  #startedAt = Date.now();
  #stopping = false;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #unsubscribeJournal: (() => void) | null = null;
  #counters = { connections: 0, messagesIn: 0, commandsOut: 0, commandsUndelivered: 0, refused: 0 };

  constructor(private options: BrokerOptions) {
    if (!options.policies.length) throw new Error('A broker needs at least one protocol policy');
    for (const record of this.#loadKnown()) this.#devices.set(keyOf(record.protocol, record.address), record);
  }

  get #journal(): Journal {
    return this.options.journal;
  }

  /** The port actually bound — which differs from the one asked for when that was 0. */
  get port(): number | null {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  get listening(): boolean {
    return this.#server?.listening ?? false;
  }

  get startedAt(): Date {
    return new Date(this.#startedAt);
  }

  get refusals(): RefusedPublish[] {
    return this.#refusals;
  }

  get devices(): DevicePresence[] {
    return [...this.#devices.values()].map(presenceOf);
  }

  /** Which clients it lets sign in, as a fingerprint a deploy compares against its own. */
  get clientsFingerprint(): string {
    return clientsFingerprint(this.options.clients ?? new Map());
  }

  /** The protocols whose rules this broker applies. */
  get protocols(): string[] {
    return this.options.policies.map((policy) => policy.protocol);
  }

  /** Everything the admin API's `/status` reports. */
  status() {
    const now = Date.now();
    return {
      counters: { ...this.#counters },
      protocols: this.protocols,
      clients: [...this.#connections.values()].map((c) => ({
        connection: c.n,
        clientId: c.clientId,
        remote: c.remote,
        role: c.privileged ? 'server' : c.device ? 'device' : c.clientId ? 'client' : 'handshaking',
        signedIn: c.signedIn,
        device: c.device ? this.#devices.get(c.device)?.address ?? null : null,
        openForMs: now - c.openedAt,
        connectedAt: c.connectedAt ? new Date(c.connectedAt).toISOString() : null,
        keepalive: c.connect?.keepalive ?? null,
        username: c.connect?.username ?? null,
        subscriptions: [...c.subscriptions],
        pings: c.pings,
        lastPacketAgoMs: now - c.lastPacketAt,
        bytesIn: c.socket.bytesRead,
        bytesOut: c.socket.bytesWritten,
      })),
      devices: [...this.#devices.values()].map((d) => ({
        ...presenceOf(d),
        messagesIn: d.messagesIn,
        commandsOut: d.commandsOut,
        unpromptedPushes: d.unprompted,
        pushIntervalMs: d.pushIntervalMs,
      })),
      refusals: this.#refusals,
    };
  }

  async start(): Promise<void> {
    const aedes = await Aedes.createBroker({
      /*
        aedes turns away client ids over 23 characters by default — the minimum
        MQTT 3.1.1 obliges a broker to accept, not a maximum anyone has to keep
        to. A device from a model we have not met yet could use a longer one,
        and being refused at the door would look exactly like a device that
        never tried.
      */
      maxClientsIdLength: 256,

      preConnect: (client, packet, callback) => {
        const conn = this.#of(client);
        if (conn) {
          const clientId = packet.clientId || client.id;
          conn.clientId = clientId;
          conn.lastPacketAt = Date.now();
          conn.connect = {
            protocol: `${packet.protocolId ?? 'MQTT'} v${packet.protocolVersion ?? '?'}`,
            keepalive: packet.keepalive ?? 0,
            clean: packet.clean ?? true,
            username: packet.username ?? null,
            // Never the password itself. A station sends none, but another client may.
            passwordBytes: packet.password?.length ?? 0,
            will: packet.will
              ? {
                  topic: packet.will.topic,
                  bytes: packet.will.payload?.length ?? 0,
                  retain: packet.will.retain ?? false,
                  qos: packet.will.qos ?? 0,
                }
              : null,
          };

        }
        callback(null, true);
      },

      authenticate: (client, username, password, done) => {
        const conn = this.#of(client);
        const who = `${conn?.remote ?? 'a client'} (client id ${client.id})`;

        if (username === SERVER_USERNAME) {
          if (sameSecret(password, this.options.token)) {
            if (conn) conn.privileged = true;
            this.#takesOver(conn);
            return done(null, true);
          }
          this.#journal.warn({
            kind: 'auth.refused',
            message: `Refused ${who}: it presented the server's username with the wrong token`,
            clientId: client.id,
            remote: conn?.remote,
          });
          return done(Object.assign(new Error('Bad username or password'), { returnCode: 4 }), null);
        }

        if (client.id.startsWith(RESERVED_CLIENT_PREFIX)) {
          this.#journal.warn({
            kind: 'auth.refused',
            message: `Refused ${who}: client ids starting "${RESERVED_CLIENT_PREFIX}" belong to the server`,
            clientId: client.id,
            remote: conn?.remote,
          });
          return done(Object.assign(new Error('Identifier rejected'), { returnCode: 2 }), null);
        }

        // One of the broker's own clients, by name: its password is checked,
        // and a wrong one is turned away rather than let in as anyone.
        const expected = username ? this.options.clients?.get(username) : undefined;
        const signedIn = expected !== undefined && sameSecret(password, expected) ? username! : null;

        /*
          A client that signed in keeps its client id. MQTT gives an id to the
          newest connection that asks for it and closes the one holding it, so
          anyone asking for Zigbee2MQTT's would push it off the broker, again
          and again: the id a client signs in by — and one a signed-in client
          holds now — is only for a connection signed in as that client.
        */
        const holder = [...this.#connections.values()].find((other) => other !== conn && other.clientId === client.id && !other.endReason && other.signedIn !== null);
        if ((this.options.clients?.has(client.id) && signedIn !== client.id) || (holder && holder.signedIn !== signedIn)) {
          this.#journal.warn({
            kind: 'auth.refused',
            message: `Refused ${who}: client id "${client.id}" belongs to a client that signs in`,
            clientId: client.id,
            remote: conn?.remote,
          });
          return done(Object.assign(new Error('Identifier rejected'), { returnCode: 2 }), null);
        }

        if (expected !== undefined) {
          if (signedIn) {
            if (conn) conn.signedIn = signedIn;
            this.#takesOver(conn);
            return done(null, true);
          }
          this.#journal.warn({
            kind: 'auth.refused',
            message: `Refused ${who}: it signed in as "${username}" with the wrong password`,
            clientId: client.id,
            remote: conn?.remote,
          });
          return done(Object.assign(new Error('Bad username or password'), { returnCode: 4 }), null);
        }

        // A station connects with no username and no password — seen, not
        // assumed — so there is nothing to check a device by. Everyone else
        // is let in, and then held to `policy.ts`.
        this.#takesOver(conn);
        done(null, true);
      },

      authorizePublish: (client, packet, callback) => {
        const conn = client ? this.#of(client) : null;
        const payload = toBytes(packet.payload);
        const reason =
          refusalFor(this.options.policies, packet.topic, payload, { privileged: conn?.privileged ?? false, signedIn: conn?.signedIn ?? null }) ??
          (conn ? this.#heldElsewhere(conn, packet.topic) : null);
        if (!reason) {
          if (packet.retain) {
            if (payload.length === 0) this.#retained.delete(packet.topic);
            else this.#retained.set(packet.topic, payload);
            this.#keepRetainedSoon();
          }
          return callback(null);
        }

        const command = commandOf(this.options.policies, packet.topic);
        const frame = command ? command.policy.describeCommand(packet.topic, payload).summary : null;
        const refused: RefusedPublish = {
          at: new Date().toISOString(),
          clientId: client?.id ?? null,
          remote: conn?.remote ?? null,
          topic: packet.topic,
          reason,
          frame,
        };
        this.#refusals.push(refused);
        if (this.#refusals.length > 50) this.#refusals.shift();
        this.#counters.refused++;

        const who = client ? `${client.id} (${conn?.remote ?? 'unknown address'})` : 'a departed client’s last will';
        const entry = {
          kind: 'mqtt.refused',
          message: `Refused ${who} publishing to ${packet.topic}${frame ? ` [${frame}]` : ''}: ${reason}`,
          clientId: client?.id,
          remote: conn?.remote,
          device: command && command.address !== packet.topic ? command.address : undefined,
          data: { ...refused, bytes: payload.length, ...(isSecret(this.options.policies, packet.topic) ? {} : { hex: toHex(payload) }) },
        };
        // The server itself being refused means something upstream failed to
        // stop a frame that destroys hardware. That is an error, not a warning.
        if (conn?.privileged) this.#journal.error(entry);
        else this.#journal.warn(entry);

        if (conn) conn.endReason ??= `cut off for publishing to ${packet.topic}`;
        // aedes drops the publish and closes this client's connection.
        callback(new Error(reason));
      },

      // The server is told which of what it is sent is kept on its topic (`#retained`). The copy is its own: no other client's flag changes.
      authorizeForward: (client, packet) => {
        const conn = this.#of(client);
        /*
          What a bridge says of its devices — their state, its own configuration
          with its network's key — is the server's and its own: anyone else
          on the network may subscribe, and is sent none of it.
        */
        const guard = guardOf(this.options.policies, packet.topic);
        if (guard && !conn?.privileged && conn?.signedIn !== guard) return null;
        if (this.#retained.has(packet.topic) && conn?.privileged) packet.retain = true;
        return packet;
      },

      /*
        The journal names devices, their addresses and their MQTT usernames, so
        it is the server's to read, not the LAN's. A `#` subscription never
        matches `$` topics; this refuses asking for them by name. A refused
        subscription is answered with a failure code, not a disconnect, so a
        device that asked for something odd is not cut off for it.
      */
      authorizeSubscribe: (client, subscription, callback) => {
        const conn = this.#of(client);
        if (subscription.topic.startsWith('$kraftverk/') && !conn?.privileged) {
          this.#journal.warn({
            kind: 'mqtt.subscribe-refused',
            message: `Refused ${conn ? this.#label(conn) : client.id} a subscription to ${subscription.topic}: broker topics are the server's`,
            clientId: client.id,
            remote: conn?.remote,
          });
          return callback(null, null);
        }
        callback(null, subscription);
      },
    });
    this.#aedes = aedes;

    aedes.on('connackSent', (packet, client) => this.#onConnack(packet.returnCode ?? 0, client));
    aedes.on('subscribe', (subscriptions, client) => this.#onSubscribe(subscriptions, client));
    aedes.on('unsubscribe', (topics, client) => this.#onUnsubscribe(topics, client));
    aedes.on('publish', (packet, client) => {
      if (client) this.#onPublish(packet.topic, toBytes(packet.payload), client, packet.retain ?? false);
    });
    aedes.on('ping', (_packet, client) => {
      const conn = this.#of(client);
      if (!conn) return;
      conn.pings++;
      conn.lastPacketAt = Date.now();
      this.#journal.debug({ kind: 'mqtt.ping', message: `${this.#label(conn)} pinged`, clientId: client.id, device: this.#addressOf(conn) });
    });
    aedes.on('keepaliveTimeout', (client) => {
      const conn = this.#of(client);
      const keepalive = conn?.connect?.keepalive ?? 0;
      if (conn) conn.endReason ??= `keepalive timeout: nothing heard for ${duration(keepalive * 1500)} (it asked for ${keepalive} s)`;
      this.#journal.warn({
        kind: 'mqtt.keepalive-timeout',
        message: `${conn ? this.#label(conn) : client.id} went silent past its keepalive of ${keepalive} s; closing it`,
        clientId: client.id,
        device: conn ? this.#addressOf(conn) : undefined,
      });
    });
    aedes.on('clientError', (client, error) => this.#onError(client, error));
    aedes.on('connectionError', (client, error) => this.#onError(client, error));
    aedes.on('clientDisconnect', (client) => {
      const conn = this.#of(client);
      // aedes sets this only when a valid DISCONNECT packet arrived: the one
      // way to tell "said goodbye" from "vanished".
      if (conn && (client as unknown as { _disconnected?: boolean })._disconnected) conn.graceful = true;
    });

    // The journal's notable entries go out to the server as they happen, so its
    // console can say what a device is doing without polling for it.
    // A device's every word stays in the file: a bridge says many, and the server's console is for what happened to it.
    this.#unsubscribeJournal = this.#journal.onEntry((entry) => {
      if (entry.level === 'debug' || (CHATTER.has(entry.kind) && entry.level === 'info') || !this.#aedes || this.#aedes.closed) return;
      this.#publish(TOPIC.journal, JSON.stringify(entry), false);
    });

    // What was kept on each topic when the last broker stopped, kept again before anyone connects.
    await this.#restoreRetained(aedes);

    const server = createServer((socket) => this.#onSocket(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    // Every known device's presence, retained, so a server that connects
    // later learns the whole picture from its first subscription.
    for (const device of this.#devices.values()) this.#announce(device);

    this.#watchdog = setInterval(() => this.#checkAbsences(), this.options.watchdogMs ?? 15_000);
    this.#watchdog.unref?.();
  }

  async stop(reason = 'stopped'): Promise<void> {
    this.#stopping = true;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;

    for (const conn of this.#connections.values()) conn.endReason ??= `the broker shut down (${reason})`;

    // Stop accepting, then close every open connection: `server.close` alone
    // waits for them, and a device never closes its side on its own.
    const closed = new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    for (const conn of this.#connections.values()) conn.socket.destroy();
    await closed;
    await new Promise<void>((resolve) => (this.#aedes ? this.#aedes.close(() => resolve()) : resolve()));

    this.#unsubscribeJournal?.();
    this.#server = null;
    this.#aedes = null;
    this.#saveKnown();
    this.#keepRetained();
  }

  // --- connection lifecycle -------------------------------------------------

  #onSocket(socket: Socket): void {
    const remote = `${(socket.remoteAddress ?? '?').replace(/^::ffff:/, '')}:${socket.remotePort ?? '?'}`;
    const conn: Connection = {
      n: ++this.#nextConnection,
      remote,
      socket,
      openedAt: Date.now(),
      clientId: null,
      privileged: false,
      signedIn: null,
      connectedAt: null,
      connect: null,
      subscriptions: new Set(),
      device: null,
      lastPacketAt: Date.now(),
      pings: 0,
      endReason: null,
      graceful: false,
      peerEnded: false,
      socketError: null,
    };
    this.#connections.set(socket, conn);
    this.#counters.connections++;

    // Before any MQTT: whether a device opens a socket at all is the first
    // question when it seems not to reconnect. Loopback is the server or a
    // port check, never a device, so it stays out of the story.
    this.#journal.write({
      level: loopback(remote) ? 'debug' : 'info',
      kind: 'tcp.open',
      message: `TCP connection #${conn.n} opened from ${remote}`,
      remote,
      data: { connection: conn.n },
    });

    socket.on('end', () => {
      conn.peerEnded = true;
    });
    socket.on('error', (error) => {
      conn.socketError ??= error.message;
    });
    socket.on('close', () => this.#onClose(conn));

    this.#aedes?.handle(socket);
  }

  #onConnack(returnCode: number, client: Client): void {
    const conn = this.#of(client);
    if (!conn) return;

    if (returnCode !== 0) {
      this.#journal.warn({
        kind: 'mqtt.rejected',
        message: `Rejected MQTT connection #${conn.n} from ${conn.remote} (client id ${client.id}): ${CONNACK[returnCode] ?? `code ${returnCode}`}`,
        clientId: client.id,
        remote: conn.remote,
        data: { returnCode, connect: conn.connect },
      });
      return;
    }

    conn.connectedAt = Date.now();
    const c = conn.connect;
    const details = c
      ? [
          `keepalive ${c.keepalive} s`,
          c.clean ? 'clean session' : 'persistent session',
          c.username ? `user "${c.username}"` : 'no username',
          c.passwordBytes ? `${c.passwordBytes}-byte password` : 'no password',
          c.will ? `will on ${c.will.topic}` : 'no will',
          c.protocol,
        ].join(', ')
      : '';

    // The server's own session is journalled, but below the story: it says
    // its own comings and goings in its own terminal.
    this.#journal.write({
      level: conn.privileged ? 'debug' : 'info',
      kind: 'mqtt.connected',
      message: conn.privileged
        ? `The kraftverk server connected as ${client.id} from ${conn.remote}`
        : `Client ${client.id} connected on #${conn.n} from ${conn.remote} (${details})`,
      clientId: client.id,
      remote: conn.remote,
      data: { connection: conn.n, privileged: conn.privileged, connect: conn.connect },
    });
  }

  #onSubscribe(subscriptions: { topic: string; qos: number }[], client: Client): void {
    const conn = this.#of(client);
    if (!conn) return;
    conn.lastPacketAt = Date.now();
    for (const { topic } of subscriptions) conn.subscriptions.add(topic);

    this.#journal.write({
      level: conn.privileged ? 'debug' : 'info',
      kind: 'mqtt.subscribe',
      message: `${this.#label(conn)} subscribed to ${subscriptions.map((s) => `${s.topic} (QoS ${s.qos})`).join(', ')}`,
      clientId: client.id,
      device: this.#addressOf(conn),
      data: { subscriptions },
    });

    // A device subscribing to its own command topic is the first sign of
    // which device it is — and the moment commands to it can arrive.
    if (conn.privileged) return;
    for (const { topic } of subscriptions) {
      for (const policy of this.options.policies) {
        const address = policy.subscribedBy(topic);
        if (!address) continue;
        /*
          A device spoken for by a client that signs in is not named by who
          listens: anyone may subscribe, and only the client that signed in —
          the first, while it is connected — is the device. Otherwise a
          listener would take its presence, and leaving, take it offline.
        */
        if (policy.signedIn && conn.signedIn !== policy.signedIn) continue;
        // A device on a live connection is not taken from it by a subscribe alone: a listener would take a station's presence, and leaving, take it offline.
        // One replaced by its own client id reconnecting has its ending said, and is taken.
        const holder = this.#devices.get(keyOf(policy.protocol, address))?.connection;
        if (holder && holder !== conn && !holder.socket.destroyed && !holder.endReason) continue;
        const device = this.#claim(conn, policy, address, `subscribed to ${topic}`);
        device.subscribed = true;
        this.#announce(device);
      }
    }
  }

  #onUnsubscribe(topics: string[], client: Client): void {
    const conn = this.#of(client);
    if (!conn) return;
    for (const topic of topics) conn.subscriptions.delete(topic);
    // aedes unsubscribes everything on its way out of a closing client; that
    // is not news, and the close is recorded with its reason instead.
    if (client.closed || conn.socket.destroyed) return;

    this.#journal.info({
      kind: 'mqtt.unsubscribe',
      message: `${this.#label(conn)} unsubscribed from ${topics.join(', ')}`,
      clientId: client.id,
      device: this.#addressOf(conn),
    });
    const device = conn.device ? this.#devices.get(conn.device) : null;
    if (!device || device.connection !== conn) return;
    const policy = this.#policyFor(device.protocol);
    if (policy && topics.some((topic) => policy.subscribedBy(topic) !== null)) {
      device.subscribed = false;
      this.#announce(device);
    }
  }

  #onError(client: Client, error: Error): void {
    const conn = this.#of(client);
    if (conn) conn.endReason ??= `error: ${error.message}`;
    // aedes follows a keepalive timeout with an error saying the same thing.
    if (error.message === 'keep alive timeout') return;
    this.#journal.write({
      // The server's socket resets every time it restarts; that is routine. And
      // an error for a connection already closed — aedes flushing what it had
      // queued, "connection closed" — adds nothing to the disconnect entry.
      level: !conn || conn.privileged ? 'debug' : 'warn',
      kind: 'mqtt.error',
      message: `${conn ? this.#label(conn) : (client.id ?? 'A connection')}: ${error.message}`,
      clientId: client.id ?? undefined,
      remote: conn?.remote,
      device: conn ? this.#addressOf(conn) : undefined,
    });
  }

  #onClose(conn: Connection): void {
    this.#connections.delete(conn.socket);
    const lasted = duration(Date.now() - conn.openedAt);
    const bytes = `${conn.socket.bytesRead} B in, ${conn.socket.bytesWritten} B out`;

    if (!conn.connectedAt) {
      this.#journal.write({
        level: loopback(conn.remote) ? 'debug' : 'info',
        kind: 'tcp.close',
        message: `TCP connection #${conn.n} from ${conn.remote} closed after ${lasted} without completing an MQTT handshake (${bytes})${conn.socketError ? `: ${conn.socketError}` : ''}`,
        remote: conn.remote,
        clientId: conn.clientId ?? undefined,
        data: { connection: conn.n, bytesIn: conn.socket.bytesRead, bytesOut: conn.socket.bytesWritten },
      });
      return;
    }

    const reason =
      conn.endReason ??
      (conn.graceful
        ? 'it disconnected cleanly'
        : conn.socketError
          ? `socket error: ${conn.socketError}`
          : conn.peerEnded
            ? 'it closed the TCP connection without an MQTT DISCONNECT'
            : 'the connection dropped');

    this.#journal.write({
      level: conn.privileged ? 'debug' : 'info',
      kind: 'mqtt.disconnected',
      message: `${this.#label(conn)} on #${conn.n} disconnected after ${lasted}: ${reason} (${bytes}, ${conn.pings} pings)`,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      device: this.#addressOf(conn),
      data: { connection: conn.n, reason, lastedMs: Date.now() - conn.openedAt, pings: conn.pings },
    });

    const device = conn.device ? this.#devices.get(conn.device) : null;
    if (!device || device.connection !== conn) return;

    device.connection = null;
    device.online = false;
    device.subscribed = false;
    device.disconnectedAt = new Date().toISOString();
    device.lastDisconnect = reason;
    device.pending.clear();
    device.alerted.clear();

    const entry = {
      kind: 'device.offline',
      message: `${describe(device)} went offline after ${lasted}: ${reason}`,
      device: device.address,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      data: { reason, lastedMs: Date.now() - conn.openedAt, protocol: device.protocol },
    };
    // A broker going down takes its devices with it; that is expected, not alarming.
    if (this.#stopping) this.#journal.info(entry);
    else this.#journal.warn(entry);

    this.#announce(device);
    this.#saveKnown();
  }

  // --- traffic --------------------------------------------------------------

  #onPublish(topic: string, payload: Uint8Array, client: Client, retain: boolean): void {
    const conn = this.#of(client);
    const from = deviceOf(this.options.policies, topic);

    /*
      A publish from a client that is closing is its last will, which aedes
      publishes on its behalf when it vanished without a DISCONNECT. A station
      leaves one on its state topic, so this is the device's own word that it
      did not leave on purpose — worth saying as that, not as a message.
    */
    if (client.closed || !conn) {
      this.#journal.info({
        kind: 'mqtt.will',
        message:
          `${conn ? this.#label(conn) : `Client ${client.id}`} left without saying goodbye, so the broker published ` +
          `its last will to ${topic}: ${printable(payload) !== null ? `"${printable(payload)}"` : `${payload.length} B`}`,
        clientId: client.id,
        device: from?.address,
        data: { topic, bytes: payload.length, hex: toHex(payload) },
      });
      return;
    }
    conn.lastPacketAt = Date.now();

    if (conn.privileged) {
      const command = commandOf(this.options.policies, topic);
      if (command) return this.#onCommand(command.policy, command.address, topic, payload, conn);
      // The server's own publishes that command nothing are its business, and below the story.
      this.#journal.debug({ kind: 'mqtt.publish', message: `The kraftverk server published ${payload.length} B to ${topic}`, data: { topic, retain, bytes: payload.length } });
      return;
    }

    if (from && !conn.privileged) {
      return this.#onDeviceMessage(from.policy, from.address, from.channel, topic, payload, conn);
    }

    // Anything else is no installed protocol's — which makes it exactly the
    // thing worth seeing: at info once a minute per client, so a client that
    // talks a lot (a bridge whose protocol is not installed yet) cannot bury
    // everything else; the rest at debug.
    const speaker = conn.clientId ?? `#${conn.n}`;
    const now = Date.now();
    const loud = now - (this.#unknownSaid.get(speaker) ?? 0) >= UNKNOWN_TRAFFIC_WINDOW_MS;
    if (loud) this.#unknownSaid.set(speaker, now);
    this.#journal.write({
      level: loud ? 'info' : 'debug',
      kind: 'mqtt.publish',
      message: `${this.#label(conn)} published ${payload.length} B to ${topic}${retain ? ' (retained)' : ''}`,
      clientId: client.id,
      device: this.#addressOf(conn),
      data: { topic, retain, bytes: payload.length, hex: toHex(payload), text: printable(payload) },
    });
  }

  #onCommand(policy: MessageBrokerPolicy, address: string, topic: string, payload: Uint8Array, conn: Connection): void {
    const note = policy.describeCommand(topic, payload);
    const deliveredTo = [...this.#connections.values()]
      .filter((other) => other !== conn && [...other.subscriptions].some((filter) => matches(filter, topic)))
      .map((other) => other.clientId ?? `#${other.n}`);

    this.#counters.commandsOut++;
    const key = keyOf(policy.protocol, address);
    const device = this.#devices.get(key);
    if (device) {
      device.commandsOut++;
      if (note.awaits) device.pending.set(note.awaits, Date.now());
    }

    const data = { topic, hex: toHex(payload), bytes: payload.length, command: note.summary, deliveredTo };

    if (deliveredTo.length === 0) {
      this.#counters.commandsUndelivered++;
      // Said once per absence. The server polls every few seconds, and a
      // warning each time would bury everything else in the journal.
      const first = !this.#undelivered.has(key);
      this.#undelivered.add(key);
      this.#journal.write({
        level: first ? 'warn' : 'debug',
        kind: 'command.undelivered',
        message:
          `→ ${address} ${note.summary}: nothing is subscribed to ${topic}, so it went nowhere — what serves it is not connected` +
          (first ? '. Further commands until it is are journalled at debug level.' : ''),
        device: address,
        data,
      });
      return;
    }
    this.#undelivered.delete(key);

    // Changes to hardware are always in plain sight; polls are an entry every
    // few seconds, and live in the file. The protocol says which is which.
    this.#journal.write({ level: note.level, kind: 'command', message: `→ ${address} ${note.summary}`, device: address, data });
  }

  #onDeviceMessage(
    policy: MessageBrokerPolicy,
    address: string,
    channel: string,
    topic: string,
    payload: Uint8Array,
    conn: Connection
  ): void {
    const device = this.#claim(conn, policy, address, `published to ${topic}`);
    const now = Date.now();
    device.lastMessageAt = new Date(now).toISOString();
    device.messagesIn++;
    this.#counters.messagesIn++;

    const note = policy.describeMessage(channel, payload);
    let summary = note.summary;

    if (note.answers) {
      const asked = device.pending.get(note.answers);
      if (asked !== undefined && now - asked < REPLY_WINDOW_MS) {
        device.pending.delete(note.answers);
        summary += `, reply in ${duration(now - asked)}`;
      } else if (note.periodic) {
        // Nobody asked. How often a device volunteers what it measures is
        // worth knowing, so it is measured.
        device.unprompted++;
        if (device.lastUnpromptedAt !== null) device.pushIntervalMs = now - device.lastUnpromptedAt;
        summary += device.lastUnpromptedAt !== null
          ? `, unprompted (${duration(now - device.lastUnpromptedAt)} since the last)`
          : ', unprompted';
        device.lastUnpromptedAt = now;
      }
    }

    this.#journal.write({
      level: note.level,
      kind: 'device.message',
      message: `← ${address} [${channel}] ${summary}`,
      device: address,
      clientId: conn.clientId ?? undefined,
      data: { topic, channel, bytes: payload.length, ...(isSecret(this.options.policies, topic) ? {} : { hex: toHex(payload) }), summary },
    });
  }

  // --- devices -------------------------------------------------------------

  /**
   * Records that `conn` speaks for the device at `address`, and brings it online.
   *
   * Learned from what a connection does rather than what it is called: a
   * device's client id is its own business, but the topics it uses name it.
   */
  #claim(conn: Connection, policy: MessageBrokerPolicy, address: string, how: string): DeviceRecord {
    const key = keyOf(policy.protocol, address);
    let device = this.#devices.get(key);
    if (!device) {
      device = blankDevice(policy.protocol, address);
      this.#devices.set(key, device);
    }
    if (conn.device === key && device.connection === conn) return device;

    conn.device = key;
    const previous = device.connection;
    // A takeover — the device reconnecting under its own client id — is
    // already explained on the old connection; only an unexplained second
    // connection is news.
    if (previous && previous !== conn && !previous.endReason) {
      this.#journal.warn({
        kind: 'device.duplicate',
        message: `${describe(device)} is now speaking on #${conn.n} from ${conn.remote}, while #${previous.n} from ${previous.remote} is still open`,
        device: device.address,
      });
    }

    const away = device.disconnectedAt ? Date.now() - Date.parse(device.disconnectedAt) : null;
    // Remembered from an earlier run, with no clean record of when it left.
    const remembered = away === null && device.remote !== null;
    device.connection = conn;
    device.online = true;
    device.clientId = conn.clientId;
    device.remote = conn.remote;
    device.connectedAt = new Date(conn.connectedAt ?? Date.now()).toISOString();
    device.keepalive = conn.connect?.keepalive ?? null;
    device.sessions++;
    device.alerted.clear();

    this.#journal.info({
      kind: 'device.online',
      message:
        `${describe(device)} is online from ${conn.remote} as ${conn.clientId} (${how})` +
        (away !== null
          ? `, back after ${duration(away)} away`
          : remembered
            ? `, ${duration(Date.now() - this.#startedAt)} after this broker started`
            : ', first time any broker here has seen it'),
      device: device.address,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      data: { awayMs: away, keepalive: device.keepalive, how, protocol: device.protocol },
    });

    this.#announce(device);
    this.#saveKnown();
    return device;
  }

  /**
   * Says, once per threshold, that a known device has not come back.
   *
   * The clock starts at whichever is later: when the device left, or when this
   * broker started — a device cannot reconnect to a broker that was not there.
   */
  #checkAbsences(): void {
    const now = Date.now();
    for (const device of this.#devices.values()) {
      if (device.online) continue;
      const left = device.disconnectedAt ? Date.parse(device.disconnectedAt) : 0;
      const since = Math.max(left, this.#startedAt);
      const away = now - since;
      const threshold = [...ABSENCE_ALERTS].reverse().find((ms) => away >= ms);
      if (threshold === undefined || device.alerted.has(threshold)) continue;
      for (const ms of ABSENCE_ALERTS) if (ms <= threshold) device.alerted.add(ms);

      const clock = left > this.#startedAt ? 'since it disconnected' : 'since this broker started';
      const advice = this.#policyFor(device.protocol)?.absenceAdvice;
      this.#journal.warn({
        kind: 'device.absent',
        message:
          `${describe(device)} has not connected in the ${duration(away)} ${clock}` +
          (device.remote ? ` (last from ${device.remote.split(':')[0]})` : '') +
          (advice ? `. ${advice}` : '.'),
        device: device.address,
        data: { awayMs: away, lastDisconnect: device.lastDisconnect, lastRemote: device.remote, protocol: device.protocol },
      });
    }
  }

  #announce(device: DeviceRecord): void {
    this.#publish(TOPIC.presence(device.protocol, device.address), JSON.stringify(presenceOf(device)), true);
  }

  #publish(topic: string, payload: string, retain: boolean): void {
    this.#aedes?.publish(
      { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain, dup: false } as never,
      () => undefined
    );
  }

  /**
   * Why `conn` may not publish `topic`, when it is a device topic of a
   * protocol whose devices are spoken for by a client that signed in, and
   * another connection holds that device now: the first holds it while it
   * is connected, so a second cannot take its presence or speak in its place.
   */
  #heldElsewhere(conn: Connection, topic: string): string | null {
    if (conn.privileged) return null;
    const from = deviceOf(this.options.policies, topic);
    if (!from?.policy.signedIn) return null;
    const holder = this.#devices.get(keyOf(from.policy.protocol, from.address))?.connection;
    if (!holder || holder === conn || holder.socket.destroyed) return null;
    return `${describe(this.#devices.get(keyOf(from.policy.protocol, from.address))!)} is spoken for by ${holder.clientId ?? `#${holder.n}`} on #${holder.n}`;
  }

  /**
   * MQTT hands a client id to the newest connection that asks for it, and
   * closes the one holding it. Said once the new one is let in, before the
   * old one is closed, so its ending has a reason instead of a mystery.
   */
  #takesOver(conn: Connection | null): void {
    if (!conn?.clientId) return;
    for (const other of this.#connections.values()) {
      if (other !== conn && other.clientId === conn.clientId && !other.endReason) {
        other.endReason = `replaced by a new connection with the same client id from ${conn.remote}`;
      }
    }
  }

  #of(client: Client | null | undefined): Connection | null {
    if (!client?.conn) return null;
    return this.#connections.get(client.conn as Socket) ?? null;
  }

  #policyFor(protocol: string): MessageBrokerPolicy | null {
    return this.options.policies.find((policy) => policy.protocol === protocol) ?? null;
  }

  #addressOf(conn: Connection): string | undefined {
    return conn.device ? this.#devices.get(conn.device)?.address : undefined;
  }

  /** How a connection is named in a sentence: the device, the server, or its client id. */
  #label(conn: Connection): string {
    if (conn.privileged) return 'The kraftverk server';
    const device = conn.device ? this.#devices.get(conn.device) : null;
    if (device) return describe(device);
    return `Client ${conn.clientId ?? `#${conn.n}`}`;
  }

  /**
   * Writes what is kept on each topic within half a minute: every device's
   * state is retained and said many times a minute, so they are written
   * together — and on stop, so a broker recreated loses none of it.
   */
  #keepRetainedSoon(): void {
    if (!this.options.retainedFile || this.#saveRetainedTimer) return;
    this.#saveRetainedTimer = setTimeout(() => this.#keepRetained(), KEEP_RETAINED_MS);
    this.#saveRetainedTimer.unref?.();
  }

  #keepRetained(): void {
    if (this.#saveRetainedTimer) clearTimeout(this.#saveRetainedTimer);
    this.#saveRetainedTimer = null;
    const file = this.options.retainedFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      // What carries a secret is never on disk: its bridge says it again when it connects.
      const kept = Object.fromEntries([...this.#retained].filter(([topic]) => !isSecret(this.options.policies, topic)).map(([topic, payload]) => [topic, Buffer.from(payload).toString('base64')]));
      // Whole or not at all: a broker killed mid-write leaves the last one, not half of this.
      writeFileSync(`${file}.new`, JSON.stringify(kept));
      renameSync(`${file}.new`, file);
    } catch {
      // Kept for the next broker's sake, not this one's: failing to write it costs nothing now.
    }
  }

  /** What the last broker kept on each topic, published again as retained — by the broker itself, before anyone is there to receive it. */
  async #restoreRetained(aedes: Aedes): Promise<void> {
    const file = this.options.retainedFile;
    if (!file) return;
    let kept: Record<string, string> = {};
    try {
      kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return;
    }
    for (const [topic, base64] of Object.entries(kept)) {
      // The broker's own topics it says afresh; the rest are the devices'.
      if (topic.startsWith('$') || typeof base64 !== 'string' || isSecret(this.options.policies, topic)) continue;
      const payload = Buffer.from(base64, 'base64');
      if (!payload.length) continue;
      this.#retained.set(topic, new Uint8Array(payload));
      await new Promise<void>((resolve) => aedes.publish({ cmd: 'publish', topic, payload, qos: 0, retain: true, dup: false } as never, () => resolve()));
    }
    if (this.#retained.size) this.#journal.info({ kind: 'broker.retained', message: `Kept again what the last broker kept on ${this.#retained.size} topic(s)` });
  }

  #loadKnown(): DeviceRecord[] {
    const restore = (saved: Partial<DevicePresence> & { protocol: string; address: string }): DeviceRecord => ({
      ...blankDevice(saved.protocol, saved.address),
      remote: saved.remote ?? null,
      clientId: saved.clientId ?? null,
      lastMessageAt: saved.lastMessageAt ?? null,
      /*
        Saved as online means the last broker was killed outright — a clean
        stop records the disconnect. Its `disconnectedAt` then belongs to an
        older session, and the absence clock starts at this broker's start
        anyway, so it is dropped rather than reported as though it were news.
      */
      disconnectedAt: saved.online ? null : (saved.disconnectedAt ?? null),
      lastDisconnect: saved.online
        ? 'the previous broker stopped without shutting down cleanly while it was connected'
        : (saved.lastDisconnect ?? 'the previous broker stopped'),
    });

    const read = (file: string | null | undefined): unknown[] | null => {
      if (!file) return null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };

    return (read(this.options.devicesFile) ?? [])
      .filter((d): d is Partial<DevicePresence> & { protocol: string; address: string } =>
        typeof (d as DevicePresence).protocol === 'string' && typeof (d as DevicePresence).address === 'string'
      )
      .map(restore);
  }

  #saveKnown(): void {
    const file = this.options.devicesFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.devices, null, 2));
    } catch {
      // Remembering devices is a convenience for the next run, not this one.
    }
  }
}

const CONNACK: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

function blankDevice(protocol: string, address: string): DeviceRecord {
  return {
    protocol,
    address,
    online: false,
    clientId: null,
    remote: null,
    connectedAt: null,
    disconnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    keepalive: null,
    subscribed: false,
    sessions: 0,
    connection: null,
    messagesIn: 0,
    commandsOut: 0,
    unprompted: 0,
    lastUnpromptedAt: null,
    pushIntervalMs: null,
    pending: new Map(),
    alerted: new Set(),
  };
}

function presenceOf(d: DeviceRecord): DevicePresence {
  return {
    protocol: d.protocol,
    address: d.address,
    online: d.online,
    clientId: d.clientId,
    remote: d.remote,
    connectedAt: d.connectedAt,
    disconnectedAt: d.disconnectedAt,
    lastDisconnect: d.lastDisconnect,
    lastMessageAt: d.lastMessageAt,
    keepalive: d.keepalive,
    subscribed: d.subscribed,
    sessions: d.sessions,
  };
}

/** A device in a sentence: "Device AABBCC001122 (sydpower)". */
const describe = (device: DevicePresence) => `Device ${device.address} (${device.protocol})`;

const loopback = (remote: string) => /^(127\.|::1|localhost)/.test(remote);

/** How much of a payload the journal keeps, in bytes: a bridge's device list is hundreds of kB, and its first 200 say what it was. */
const HEX_BYTES = 200;

/** A payload's first bytes in hex, with how many more there were. */
const toHex = (bytes: Uint8Array) =>
  [...bytes.subarray(0, HEX_BYTES)].map((b) => b.toString(16).padStart(2, '0')).join('') + (bytes.length > HEX_BYTES ? `…(+${bytes.length - HEX_BYTES} B)` : '');
function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  return new Uint8Array();
}

/** The payload as text, when it is short printable ASCII — like a station's `"1"`. */
function printable(payload: Uint8Array): string | null {
  if (payload.length === 0 || payload.length > 200) return null;
  for (const byte of payload) if (byte < 0x20 || byte > 0x7e) return null;
  return new TextDecoder().decode(payload);
}

/** MQTT topic matching with `+` and `#`, for telling who a command reaches. */
export function matches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i > 0 || !topic.startsWith('$');
    if (i >= t.length) return false;
    if (f[i] === '+') {
      if (i === 0 && topic.startsWith('$')) return false;
      continue;
    }
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
