import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import { Aedes } from 'aedes';
import type { Client } from 'aedes';

import { describeCommand, parseCommand, parseFrame, toHex, FN } from '@kraftverk/protocol';

import { duration, type Journal } from './journal.ts';
import { isCommandTopic, refusalFor, RESPONSE_TOPIC, STATION_COMMAND_FILTER } from './policy.ts';
import {
  RESERVED_CLIENT_PREFIX,
  SERVER_USERNAME,
  sameSecret,
  TOPIC,
  type StationPresence,
} from './shared.ts';

/**
 * The MQTT broker a power station talks to instead of the vendor cloud.
 *
 * Two ways to get a station here, both on port 1883 in plain MQTT: BrightEMS
 * 1.6.0+ has a *Local MQTT Broker* setting that takes this machine's address
 * directly, and older firmware can be caught by pointing `mqtt.sydpower.com` at
 * this machine in the router or a Pi-hole.
 *
 * It runs in its own process (see `main.ts`) and knows nothing about saved
 * devices, drivers or the database. It does three things:
 *
 * 1. **Carries frames.** Stations publish on `<MAC>/device/response/...`; the
 *    server, connected as a privileged client, subscribes to those and
 *    publishes commands on `<MAC>/client/request/data`.
 * 2. **Refuses what must never reach a station** — see `policy.ts`.
 * 3. **Writes down everything** — every socket, handshake, subscription, frame
 *    and disconnect, with the reason — because the station's behaviour is
 *    undocumented and the journal is how it gets documented.
 *
 * Bind it to your LAN, never the internet.
 */

export type StationBrokerOptions = {
  host: string;
  port: number;
  /** The secret the server proves itself with. */
  token: string;
  journal: Journal;
  /** Where known stations are remembered between runs. Null to forget them. */
  stationsFile: string | null;
  /** How often to check for stations that have not come back. */
  watchdogMs?: number;
};

/** A publish the broker refused, for diagnostics. */
export type RefusedPublish = {
  at: string;
  clientId: string | null;
  remote: string | null;
  topic: string;
  reason: string;
  /** The frame, when it was one, in words. */
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
  /** The station this connection speaks for, once it has said. */
  station: string | null;
  lastPacketAt: number;
  pings: number;
  /** The first known cause of the end, if one was seen before the socket closed. */
  endReason: string | null;
  graceful: boolean;
  peerEnded: boolean;
  socketError: string | null;
};

type StationRecord = StationPresence & {
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

/** How long a gap before the broker says a station has not come back. */
const ABSENCE_ALERTS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000];

/** A reply later than this is treated as an unprompted push rather than an answer. */
const REPLY_WINDOW_MS = 10_000;

export class StationBroker {
  #aedes: Aedes | null = null;
  #server: Server | null = null;
  #connections = new Map<Socket, Connection>();
  #stations = new Map<string, StationRecord>();
  #refusals: RefusedPublish[] = [];
  /** Stations already warned about during the current run of undeliverable commands. */
  #undelivered = new Set<string>();
  #nextConnection = 0;
  #startedAt = Date.now();
  #stopping = false;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #unsubscribeJournal: (() => void) | null = null;
  #counters = { connections: 0, messagesIn: 0, commandsOut: 0, commandsUndelivered: 0, refused: 0 };

  constructor(private options: StationBrokerOptions) {
    for (const record of this.#loadKnown()) this.#stations.set(record.station, record);
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

  get stations(): StationPresence[] {
    return [...this.#stations.values()].map(presenceOf);
  }

  /** Everything the admin API's `/status` reports. */
  status() {
    const now = Date.now();
    return {
      counters: { ...this.#counters },
      clients: [...this.#connections.values()].map((c) => ({
        connection: c.n,
        clientId: c.clientId,
        remote: c.remote,
        role: c.privileged ? 'server' : c.station ? 'station' : c.clientId ? 'client' : 'handshaking',
        station: c.station,
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
      stations: [...this.#stations.values()].map((s) => ({
        ...presenceOf(s),
        messagesIn: s.messagesIn,
        commandsOut: s.commandsOut,
        unpromptedPushes: s.unprompted,
        pushIntervalMs: s.pushIntervalMs,
      })),
      refusals: this.#refusals,
    };
  }

  async start(): Promise<void> {
    const aedes = await Aedes.createBroker({
      /*
        aedes turns away client ids over 23 characters by default — the minimum
        MQTT 3.1.1 obliges a broker to accept, not a maximum anyone has to keep
        to. A station from a model we have not met yet could use a longer one,
        and being refused at the door would look exactly like a station that
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
            // Never the password itself. A P280 sends none, but another client may.
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

          // MQTT hands a client id to the newest connection that asks for it,
          // and closes the old one. Said here, before it happens, so the old
          // connection's ending has a reason instead of a mystery.
          for (const other of this.#connections.values()) {
            if (other !== conn && other.clientId === clientId && !other.endReason) {
              other.endReason = `replaced by a new connection with the same client id from ${conn.remote}`;
            }
          }
        }
        callback(null, true);
      },

      authenticate: (client, username, password, done) => {
        const conn = this.#of(client);
        const who = `${conn?.remote ?? 'a client'} (client id ${client.id})`;

        if (username === SERVER_USERNAME) {
          if (sameSecret(password, this.options.token)) {
            if (conn) conn.privileged = true;
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

        // A P280 connects with no username and no password — seen, not
        // assumed — so there is nothing to check a station by. Everyone else
        // is let in, and then held to `policy.ts`.
        done(null, true);
      },

      authorizePublish: (client, packet, callback) => {
        const conn = client ? this.#of(client) : null;
        const payload = toBytes(packet.payload);
        const reason = refusalFor(packet.topic, payload, conn?.privileged ?? false);
        if (!reason) return callback(null);

        const frame = isCommandTopic(packet.topic) ? describeCommand(payload) : null;
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
          station: stationOf(packet.topic),
          data: { ...refused, hex: toHex(payload).slice(0, 400) },
        };
        // The server itself being refused means something upstream failed to
        // stop a frame that destroys hardware. That is an error, not a warning.
        if (conn?.privileged) this.#journal.error(entry);
        else this.#journal.warn(entry);

        if (conn) conn.endReason ??= `cut off for publishing to ${packet.topic}`;
        // aedes drops the publish and closes this client's connection.
        callback(new Error(reason));
      },

      /*
        The journal names stations, their addresses and their MQTT usernames,
        so it is the server's to read, not the LAN's. A `#` subscription never
        matches `$` topics; this refuses asking for them by name. A refused
        subscription is answered with a failure code, not a disconnect, so a
        station that asked for something odd is not cut off for it.
      */
      authorizeSubscribe: (client, subscription, callback) => {
        const conn = this.#of(client);
        if (subscription.topic.startsWith('$kraftverk/') && !conn?.privileged) {
          this.#journal.warn({
            kind: 'mqtt.subscribe-refused',
            message: `Refused ${conn ? label(conn) : client.id} a subscription to ${subscription.topic}: broker topics are the server's`,
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
      this.#journal.debug({ kind: 'mqtt.ping', message: `${label(conn)} pinged`, clientId: client.id, station: conn.station ?? undefined });
    });
    aedes.on('keepaliveTimeout', (client) => {
      const conn = this.#of(client);
      const keepalive = conn?.connect?.keepalive ?? 0;
      if (conn) conn.endReason ??= `keepalive timeout: nothing heard for ${duration(keepalive * 1500)} (it asked for ${keepalive} s)`;
      this.#journal.warn({
        kind: 'mqtt.keepalive-timeout',
        message: `${conn ? label(conn) : client.id} went silent past its keepalive of ${keepalive} s; closing it`,
        clientId: client.id,
        station: conn?.station ?? undefined,
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
    // console can say what the station is doing without polling for it.
    this.#unsubscribeJournal = this.#journal.onEntry((entry) => {
      if (entry.level === 'debug' || !this.#aedes || this.#aedes.closed) return;
      this.#publish(TOPIC.journal, JSON.stringify(entry), false);
    });

    const server = createServer((socket) => this.#onSocket(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    // Every known station's presence, retained, so a server that connects
    // later learns the whole picture from its first subscription.
    for (const station of this.#stations.values()) this.#announce(station);

    this.#watchdog = setInterval(() => this.#checkAbsences(), this.options.watchdogMs ?? 15_000);
    this.#watchdog.unref?.();
  }

  async stop(reason = 'stopped'): Promise<void> {
    this.#stopping = true;
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;

    for (const conn of this.#connections.values()) conn.endReason ??= `the broker shut down (${reason})`;

    // Stop accepting, then close every open connection: `server.close` alone
    // waits for them, and a station never closes its side on its own.
    const closed = new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    for (const conn of this.#connections.values()) conn.socket.destroy();
    await closed;
    await new Promise<void>((resolve) => (this.#aedes ? this.#aedes.close(() => resolve()) : resolve()));

    this.#unsubscribeJournal?.();
    this.#server = null;
    this.#aedes = null;
    this.#saveKnown();
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
      connectedAt: null,
      connect: null,
      subscriptions: new Set(),
      station: null,
      lastPacketAt: Date.now(),
      pings: 0,
      endReason: null,
      graceful: false,
      peerEnded: false,
      socketError: null,
    };
    this.#connections.set(socket, conn);
    this.#counters.connections++;

    // Before any MQTT: whether the station opens a socket at all is the first
    // question when it seems not to reconnect. Loopback is the server or a
    // port check, never a station, so it stays out of the story.
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
      message: `${label(conn)} subscribed to ${subscriptions.map((s) => `${s.topic} (QoS ${s.qos})`).join(', ')}`,
      clientId: client.id,
      station: conn.station ?? undefined,
      data: { subscriptions },
    });

    // A station subscribing to its own command topic is the first sign of
    // which station it is — and the moment commands to it can arrive.
    for (const { topic } of subscriptions) {
      const match = STATION_COMMAND_FILTER.exec(topic);
      if (!match || conn.privileged) continue;
      const station = this.#claim(conn, match[1]!.toUpperCase(), `subscribed to ${topic}`);
      station.subscribed = true;
      this.#announce(station);
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
      message: `${label(conn)} unsubscribed from ${topics.join(', ')}`,
      clientId: client.id,
      station: conn.station ?? undefined,
    });
    const station = conn.station ? this.#stations.get(conn.station) : null;
    if (station && station.connection === conn && topics.some((t) => STATION_COMMAND_FILTER.test(t))) {
      station.subscribed = false;
      this.#announce(station);
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
      message: `${conn ? label(conn) : (client.id ?? 'A connection')}: ${error.message}`,
      clientId: client.id ?? undefined,
      remote: conn?.remote,
      station: conn?.station ?? undefined,
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
      message: `${label(conn)} on #${conn.n} disconnected after ${lasted}: ${reason} (${bytes}, ${conn.pings} pings)`,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      station: conn.station ?? undefined,
      data: { connection: conn.n, reason, lastedMs: Date.now() - conn.openedAt, pings: conn.pings },
    });

    const station = conn.station ? this.#stations.get(conn.station) : null;
    if (!station || station.connection !== conn) return;

    station.connection = null;
    station.online = false;
    station.subscribed = false;
    station.disconnectedAt = new Date().toISOString();
    station.lastDisconnect = reason;
    station.pending.clear();
    station.alerted.clear();

    const entry = {
      kind: 'station.offline',
      message: `Station ${station.station} went offline after ${lasted}: ${reason}`,
      station: station.station,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      data: { reason, lastedMs: Date.now() - conn.openedAt },
    };
    // A broker going down takes its stations with it; that is expected, not alarming.
    if (this.#stopping) this.#journal.info(entry);
    else this.#journal.warn(entry);

    this.#announce(station);
    this.#saveKnown();
  }

  // --- traffic --------------------------------------------------------------

  #onPublish(topic: string, payload: Uint8Array, client: Client, retain: boolean): void {
    const conn = this.#of(client);
    const match = RESPONSE_TOPIC.exec(topic);

    /*
      A publish from a client that is closing is its last will, which aedes
      publishes on its behalf when it vanished without a DISCONNECT. A P280
      leaves one on its state topic, so this is the station's own word that it
      did not leave on purpose — worth saying as that, not as a message.
    */
    if (client.closed || !conn) {
      this.#journal.info({
        kind: 'mqtt.will',
        message:
          `${conn ? label(conn) : `Client ${client.id}`} left without saying goodbye, so the broker published ` +
          `its last will to ${topic}: ${printable(payload) !== null ? `"${printable(payload)}"` : `${payload.length} B`}`,
        clientId: client.id,
        station: match ? match[1]!.toUpperCase() : undefined,
        data: { topic, bytes: payload.length, hex: toHex(payload).slice(0, 400) },
      });
      return;
    }
    conn.lastPacketAt = Date.now();

    if (conn.privileged && isCommandTopic(topic)) return this.#onCommand(topic, payload, conn);

    if (match && !conn.privileged) {
      return this.#onStationMessage(match[1]!.toUpperCase(), match[2]!, topic, payload, conn);
    }

    // Anything else is not the protocol this broker exists for — which makes it
    // exactly the thing worth seeing.
    this.#journal.info({
      kind: 'mqtt.publish',
      message: `${label(conn)} published ${payload.length} B to ${topic}${retain ? ' (retained)' : ''}`,
      clientId: client.id,
      station: conn.station ?? undefined,
      data: { topic, retain, bytes: payload.length, hex: toHex(payload).slice(0, 400), text: printable(payload) },
    });
  }

  #onCommand(topic: string, payload: Uint8Array, conn: Connection): void {
    const mac = topic.split('/')[0]!.toUpperCase();
    const command = parseCommand(payload);
    const summary = describeCommand(payload);
    const deliveredTo = [...this.#connections.values()]
      .filter((other) => other !== conn && [...other.subscriptions].some((filter) => matches(filter, topic)))
      .map((other) => other.clientId ?? `#${other.n}`);

    this.#counters.commandsOut++;
    const station = this.#stations.get(mac);
    if (station) {
      station.commandsOut++;
      if (command?.kind === 'read') station.pending.set(command.fn === FN.READ_INPUT ? 'input' : 'holding', Date.now());
      if (command?.kind === 'write') station.pending.set(`write:${command.register}`, Date.now());
    }

    const data = { topic, hex: toHex(payload), bytes: payload.length, command: summary, deliveredTo };

    if (deliveredTo.length === 0) {
      this.#counters.commandsUndelivered++;
      // Said once per absence. The server polls every few seconds, and a
      // warning each time would bury everything else in the journal.
      const first = !this.#undelivered.has(mac);
      this.#undelivered.add(mac);
      this.#journal.write({
        level: first ? 'warn' : 'debug',
        kind: 'command.undelivered',
        message:
          `→ ${mac} ${summary}: nothing is subscribed to ${topic}, so it went nowhere — the station is not connected` +
          (first ? '. Further commands until it is are journalled at debug level.' : ''),
        station: mac,
        data,
      });
      return;
    }
    this.#undelivered.delete(mac);

    // Writes are the events that change hardware, so they are always in plain
    // sight. Polls are an entry every few seconds, and live in the file.
    const entry = { kind: 'command', message: `→ ${mac} ${summary}`, station: mac, data };
    if (command?.kind === 'read') this.#journal.debug(entry);
    else this.#journal.info(entry);
  }

  #onStationMessage(mac: string, channel: string, topic: string, payload: Uint8Array, conn: Connection): void {
    const station = this.#claim(conn, mac, `published to ${topic}`);
    const now = Date.now();
    station.lastMessageAt = new Date(now).toISOString();
    station.messagesIn++;
    this.#counters.messagesIn++;

    const frame = parseFrame(payload);
    let summary: string;
    let level: 'debug' | 'info' | 'warn' = 'debug';

    if (channel === 'state') {
      summary = `state "${printable(payload) ?? toHex(payload)}"`;
      level = 'info';
    } else if (frame?.kind === 'registers') {
      const block = frame.fn === FN.READ_INPUT ? 'input' : 'holding';
      summary = `${block} registers ${frame.start}+${frame.values.length}`;
      const asked = station.pending.get(block);
      if (asked !== undefined && now - asked < REPLY_WINDOW_MS) {
        station.pending.delete(block);
        summary += `, reply in ${duration(now - asked)}`;
      } else {
        // Nobody asked. How often a station volunteers its telemetry is one of
        // the open questions about this protocol, so it is measured.
        station.unprompted++;
        if (station.lastUnpromptedAt !== null) station.pushIntervalMs = now - station.lastUnpromptedAt;
        summary += station.lastUnpromptedAt !== null
          ? `, unprompted (${duration(now - station.lastUnpromptedAt)} since the last)`
          : ', unprompted';
        station.lastUnpromptedAt = now;
      }
    } else if (frame?.kind === 'writeAck') {
      station.pending.delete(`write:${frame.register}`);
      summary = `acknowledged write holding ${frame.register} = ${frame.value}`;
      level = 'info';
    } else if (frame?.kind === 'error') {
      summary = `MODBUS exception ${frame.code} for function 0x${frame.fn.toString(16).padStart(2, '0')}`;
      level = 'warn';
    } else {
      summary = `${payload.length} B that do not parse as a frame (bad CRC or unknown shape)`;
      level = 'info';
    }

    this.#journal.write({
      level,
      kind: 'station.message',
      message: `← ${mac} [${channel}] ${summary}`,
      station: mac,
      clientId: conn.clientId ?? undefined,
      data: { topic, channel, bytes: payload.length, hex: toHex(payload), summary },
    });
  }

  // --- stations -------------------------------------------------------------

  /**
   * Records that `conn` speaks for station `mac`, and brings it online.
   *
   * Learned from what a connection does rather than what it is called: the
   * station's client id is its own business, but the topics it uses name it.
   */
  #claim(conn: Connection, mac: string, how: string): StationRecord {
    let station = this.#stations.get(mac);
    if (!station) {
      station = blankStation(mac);
      this.#stations.set(mac, station);
    }
    if (conn.station === mac && station.connection === conn) return station;

    conn.station = mac;
    const previous = station.connection;
    // A takeover — the station reconnecting under its own client id — is
    // already explained on the old connection; only an unexplained second
    // connection is news.
    if (previous && previous !== conn && !previous.endReason) {
      this.#journal.warn({
        kind: 'station.duplicate',
        message: `Station ${mac} is now speaking on #${conn.n} from ${conn.remote}, while #${previous.n} from ${previous.remote} is still open`,
        station: mac,
      });
    }

    const away = station.disconnectedAt ? Date.now() - Date.parse(station.disconnectedAt) : null;
    // Remembered from an earlier run, with no clean record of when it left.
    const remembered = away === null && station.remote !== null;
    station.connection = conn;
    station.online = true;
    station.clientId = conn.clientId;
    station.remote = conn.remote;
    station.connectedAt = new Date(conn.connectedAt ?? Date.now()).toISOString();
    station.keepalive = conn.connect?.keepalive ?? null;
    station.sessions++;
    station.alerted.clear();

    this.#journal.info({
      kind: 'station.online',
      message:
        `Station ${mac} is online from ${conn.remote} as ${conn.clientId} (${how})` +
        (away !== null
          ? `, back after ${duration(away)} away`
          : remembered
            ? `, ${duration(Date.now() - this.#startedAt)} after this broker started`
            : ', first time any broker here has seen it'),
      station: mac,
      clientId: conn.clientId ?? undefined,
      remote: conn.remote,
      data: { awayMs: away, keepalive: station.keepalive, how },
    });

    this.#announce(station);
    this.#saveKnown();
    return station;
  }

  /**
   * Says, once per threshold, that a known station has not come back.
   *
   * The clock starts at whichever is later: when the station left, or when this
   * broker started — a station cannot reconnect to a broker that was not there.
   */
  #checkAbsences(): void {
    const now = Date.now();
    for (const station of this.#stations.values()) {
      if (station.online) continue;
      const left = station.disconnectedAt ? Date.parse(station.disconnectedAt) : 0;
      const since = Math.max(left, this.#startedAt);
      const away = now - since;
      const threshold = [...ABSENCE_ALERTS].reverse().find((ms) => away >= ms);
      if (threshold === undefined || station.alerted.has(threshold)) continue;
      for (const ms of ABSENCE_ALERTS) if (ms <= threshold) station.alerted.add(ms);

      const clock = left > this.#startedAt ? 'since it disconnected' : 'since this broker started';
      this.#journal.warn({
        kind: 'station.absent',
        message:
          `Station ${station.station} has not connected in the ${duration(away)} ${clock}` +
          (station.remote ? ` (last from ${station.remote.split(':')[0]})` : '') +
          '. A P280 has been seen to stop retrying after a long broker outage: if it still answers pings, ' +
          'power-cycle it, or re-save the Local MQTT Broker setting in BrightEMS.',
        station: station.station,
        data: { awayMs: away, lastDisconnect: station.lastDisconnect, lastRemote: station.remote },
      });
    }
  }

  #announce(station: StationRecord): void {
    this.#publish(TOPIC.presence(station.station), JSON.stringify(presenceOf(station)), true);
  }

  #publish(topic: string, payload: string, retain: boolean): void {
    this.#aedes?.publish(
      { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain, dup: false } as never,
      () => undefined
    );
  }

  #of(client: Client | null | undefined): Connection | null {
    if (!client?.conn) return null;
    return this.#connections.get(client.conn as Socket) ?? null;
  }

  #loadKnown(): StationRecord[] {
    const file = this.options.stationsFile;
    if (!file) return [];
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<StationPresence>[];
      return saved
        .filter((s): s is Partial<StationPresence> & { station: string } => typeof s.station === 'string')
        .map((s) => ({
          ...blankStation(s.station),
          remote: s.remote ?? null,
          clientId: s.clientId ?? null,
          lastMessageAt: s.lastMessageAt ?? null,
          /*
            Saved as online means the last broker was killed outright — a clean
            stop records the disconnect. Its `disconnectedAt` then belongs to an
            older session, and the absence clock starts at this broker's start
            anyway, so it is dropped rather than reported as though it were news.
          */
          disconnectedAt: s.online ? null : (s.disconnectedAt ?? null),
          lastDisconnect: s.online
            ? 'the previous broker stopped without shutting down cleanly while it was connected'
            : (s.lastDisconnect ?? 'the previous broker stopped'),
        }));
    } catch {
      return [];
    }
  }

  #saveKnown(): void {
    const file = this.options.stationsFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.stations, null, 2));
    } catch {
      // Remembering stations is a convenience for the next run, not this one.
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

function blankStation(station: string): StationRecord {
  return {
    station,
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

function presenceOf(s: StationRecord): StationPresence {
  return {
    station: s.station,
    online: s.online,
    clientId: s.clientId,
    remote: s.remote,
    connectedAt: s.connectedAt,
    disconnectedAt: s.disconnectedAt,
    lastDisconnect: s.lastDisconnect,
    lastMessageAt: s.lastMessageAt,
    keepalive: s.keepalive,
    subscribed: s.subscribed,
    sessions: s.sessions,
  };
}

/** How a connection is named in a sentence: the station, the server, or its client id. */
function label(conn: Connection): string {
  if (conn.privileged) return 'The kraftverk server';
  if (conn.station) return `Station ${conn.station}`;
  return `Client ${conn.clientId ?? `#${conn.n}`}`;
}

const loopback = (remote: string) => /^(127\.|::1|localhost)/.test(remote);

function stationOf(topic: string): string | undefined {
  const first = topic.split('/')[0] ?? '';
  return /^[0-9A-Fa-f]{12}$/.test(first) ? first.toUpperCase() : undefined;
}

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  return new Uint8Array();
}

/** The payload as text, when it is short printable ASCII — like the station's `"1"`. */
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
