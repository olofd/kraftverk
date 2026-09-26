import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHoldingRegisters, readInputRegisters, writeRegister } from '@kraftverk/protocol';

import { BrokerBus, type DeviceMessage } from '../mqtt/bus.ts';
import { MqttClient } from '../mqtt/client.ts';
import { matches, StationBroker } from './broker.ts';
import { Journal } from './journal.ts';
import { refusalFor } from './policy.ts';
import { sameSecret, SERVER_USERNAME } from './shared.ts';

/**
 * The broker, exercised the way it runs: a real TCP listener, a fake station
 * speaking raw MQTT, and the server's own bus as the privileged client.
 *
 * Who may command a station: the server, and no one else — and not even the
 * server may send the frame these tests keep forging, because holding register
 * 68 set to 0 permanently bricks a P280.
 */

const STATION = 'AC276E629BEA';
const COMMANDS = `${STATION}/client/request/data`;
/** The eight bytes that destroy the station. Built by the unguarded frame builder. */
const BRICK = writeRegister(68, 0);
const TOKEN = 'test-token-not-a-secret';

describe('refusalFor', () => {
  const frame = readHoldingRegisters(0, 80);

  test('refuses a command topic to anyone but the server, however it is spelled', () => {
    for (const topic of [COMMANDS, COMMANDS.toLowerCase(), `${STATION}/Client/Request/data`, `${STATION}/client/request`]) {
      expect(refusalFor(topic, frame, false)).not.toBeNull();
      expect(refusalFor(topic, frame, true)).toBeNull();
    }
  });

  test('refuses the brick write even to the server', () => {
    expect(refusalFor(COMMANDS, BRICK, true)).toContain('bricks');
  });

  test('lets a station say everything it has been seen saying', () => {
    for (const channel of ['state', 'client/04', 'client/data']) {
      expect(refusalFor(`${STATION}/device/response/${channel}`, frame, false)).toBeNull();
    }
  });

  test('keeps $SYS and the broker’s own topics reserved', () => {
    expect(refusalFor('$SYS/broker/heartbeat', frame, false)).not.toBeNull();
    expect(refusalFor(`$kraftverk/station/${STATION}`, frame, false)).not.toBeNull();
    expect(refusalFor('$kraftverk/journal', frame, true)).not.toBeNull();
  });
});

describe('matches', () => {
  test('follows MQTT wildcard rules, including $ topics', () => {
    expect(matches(`${STATION}/client/request/#`, COMMANDS)).toBe(true);
    expect(matches('+/client/request/data', COMMANDS)).toBe(true);
    expect(matches('#', COMMANDS)).toBe(true);
    expect(matches('#', '$kraftverk/journal')).toBe(false);
    expect(matches('+/journal', '$kraftverk/journal')).toBe(false);
    expect(matches(`${STATION}/client/request/data`, `${STATION}/client/request/other`)).toBe(false);
  });
});

describe('the broker', () => {
  let broker: StationBroker;
  let journal: Journal;
  let port: number;
  let bus: BrokerBus;

  beforeAll(async () => {
    journal = new Journal({ dir: null, consoleLevel: 'off' });
    broker = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: null });
    await broker.start();
    port = broker.port!;
    bus = new BrokerBus({ host: '127.0.0.1', port, token: () => TOKEN });
    bus.start();
    expect(await bus.waitForConnect(3000)).toBe(true);
  });

  afterAll(async () => {
    await bus.stop();
    await broker.stop();
  });

  test('a client cannot command a station: the brick write never arrives', async () => {
    const station = await mqttClient(port, 'station-a');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.subscribed === true, 'the station’s presence to arrive');

    const intruder = await mqttClient(port, 'intruder-a');
    intruder.publish(COMMANDS, BRICK);
    await until(() => intruder.isClosed, 'the broker to cut the intruder off');

    // The server can still command it — and its frame is the only one that
    // lands. Had the forged write got through, it would be first in this list.
    const poll = readHoldingRegisters(0, 80);
    await bus.send(STATION, poll);
    await until(() => station.received.length > 0, 'the server’s frame to arrive');

    expect(station.received.map((message) => [...message.payload])).toEqual([[...poll]]);
    expect(broker.refusals.at(-1)).toMatchObject({ clientId: 'intruder-a', topic: COMMANDS });
    station.close();
  });

  /*
    The way round a publish check that forgets wills: connect with a last will
    aimed at the station's command topic, then drop the socket without saying
    goodbye. The broker publishes the will itself — so it has to be refused too.
  */
  test('nor can a last will aimed at a station, left behind by a vanishing client', async () => {
    const station = await mqttClient(port, 'station-b');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-b' && bus.presence(STATION)!.online, 'presence');

    const refusedBefore = broker.refusals.length;
    const intruder = await mqttClient(port, 'intruder-b', { topic: COMMANDS, payload: BRICK });
    intruder.drop();
    await until(() => broker.refusals.length > refusedBefore, 'the will to be refused');

    const poll = readHoldingRegisters(0, 80);
    await bus.send(STATION, poll);
    await until(() => station.received.length > 0, 'the server’s frame to arrive');

    expect(station.received.map((message) => [...message.payload])).toEqual([[...poll]]);
    expect(broker.refusals.at(-1)?.topic).toBe(COMMANDS);
    station.close();
  });

  test('the server cannot brick it either: refused before it leaves, and at the broker', async () => {
    const station = await mqttClient(port, 'station-c');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-c' && bus.presence(STATION)!.online, 'presence');

    // The bus refuses it without sending, so its own connection survives.
    await expect(bus.send(STATION, BRICK)).rejects.toThrow('bricks');
    expect(bus.connected).toBe(true);

    // A privileged client that skipped that check is still stopped by the broker.
    const rogue = new MqttClient({
      host: '127.0.0.1',
      port,
      clientId: 'kraftverk-server-rogue',
      username: SERVER_USERNAME,
      password: () => TOKEN,
      subscriptions: ['nothing/here'],
    });
    rogue.start();
    expect(await rogue.waitForConnect(3000)).toBe(true);
    await rogue.publish(COMMANDS, BRICK);
    await until(() => broker.refusals.at(-1)?.clientId === 'kraftverk-server-rogue', 'the broker to refuse the server');
    await rogue.stop();

    await Bun.sleep(100);
    expect(station.received).toEqual([]);
    expect(journal.query({ level: 'error', kinds: ['mqtt.refused'] }).length).toBeGreaterThan(0);
    station.close();
  });

  test('a client with the server’s name but not its token is turned away', async () => {
    const impostor = new MqttClient({
      host: '127.0.0.1',
      port,
      clientId: 'impostor',
      username: SERVER_USERNAME,
      password: () => 'guessed',
      subscriptions: ['#'],
    });
    const refused = new Promise<Error>((resolve) => impostor.once('failed', resolve));
    impostor.start();
    expect((await refused).message).toContain('token');
    await impostor.stop();
  });

  test('nobody else may take the server’s client id', async () => {
    const squatter = new MqttClient({
      host: '127.0.0.1',
      port,
      clientId: 'kraftverk-server-1',
      subscriptions: ['#'],
    });
    const refused = new Promise<Error>((resolve) => squatter.once('failed', resolve));
    squatter.start();
    expect((await refused).message).toContain('client id');
    await squatter.stop();
  });

  test('a station can report, and is not cut off for it', async () => {
    const station = await mqttClient(port, 'station-d');
    const heard = new Promise<DeviceMessage>((resolve) => bus.once('message', resolve));

    station.publish(`${STATION}/device/response/state`, new TextEncoder().encode('1'));
    const message = await heard;

    expect(message.mac).toBe(STATION);
    expect(message.channel).toBe('state');
    expect(station.isClosed).toBe(false);
    station.close();
  });

  test('presence says when a station leaves, and why', async () => {
    const station = await mqttClient(port, 'station-e');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-e' && bus.presence(STATION)!.online, 'online');

    station.drop();
    await until(() => bus.presence(STATION)?.online === false, 'offline');
    expect(bus.presence(STATION)?.lastDisconnect).toContain('without an MQTT DISCONNECT');

    // A command to an absent station fails at once, saying so, instead of timing out.
    await expect(bus.send(STATION, readHoldingRegisters(0, 80))).rejects.toThrow('not connected to the broker');
  });

  test('a station that vanishes has its last will journalled as that, not as a message', async () => {
    // What a real P280 registers: a will on its own state topic (seen 2026-09-26).
    const station = await mqttClient(port, 'device_WILL', { topic: `${STATION}/device/response/state`, payload: new TextEncoder().encode('0') });
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'device_WILL' && bus.presence(STATION)!.online, 'online');

    const before = journal.lastSeq;
    station.drop();
    await until(() => journal.query({ after: before, kinds: ['mqtt.will'] }).length > 0, 'the will');
    expect(journal.query({ after: before, kinds: ['mqtt.will'] })[0]?.message).toContain('"0"');
    await until(() => bus.presence(STATION)?.online === false, 'offline');
  });

  test('presence is retained: a server that connects later learns it at once', async () => {
    const station = await mqttClient(port, 'station-f');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-f' && bus.presence(STATION)!.online, 'online');

    const late = new BrokerBus({ host: '127.0.0.1', port, token: () => TOKEN });
    late.start();
    await late.waitForConnect(3000);
    await until(() => late.presence(STATION)?.online === true, 'the retained presence');
    await late.stop();
    station.close();
  });

  test('the journal tells a reply from an unprompted push, and a command that went nowhere', async () => {
    const station = await mqttClient(port, 'station-g');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-g' && bus.presence(STATION)!.online, 'online');

    // A reply: asked for, answered.
    const response = readInputRegisters(0, 2); // shape is irrelevant to the broker's bookkeeping
    const reply = inputResponse([1, 2]);
    const answered = bus.request(STATION, response, '04', 2000);
    await until(() => station.received.length > 0, 'the poll');
    station.publish(`${STATION}/device/response/client/04`, reply);
    await answered;

    // Unprompted: nobody asked.
    station.publish(`${STATION}/device/response/client/04`, reply);
    await until(() => journal.query({ level: 'debug', kinds: ['station.message'] }).some((e) => e.message.includes('unprompted')), 'the push');
    expect(journal.query({ level: 'debug', kinds: ['station.message'] }).some((e) => e.message.includes('reply in'))).toBe(true);

    station.close();
    await until(() => bus.presence(STATION)?.online === false, 'offline');
  });

  test('a command to a station the broker has never seen fails at once', async () => {
    await expect(bus.send('0000000000AA', readHoldingRegisters(0, 80))).rejects.toThrow('has not connected');
  });

  test('commands that go nowhere are warned about once, not on every poll', async () => {
    // Privileged, and without the bus's fail-fast — the way a poll reaches the
    // broker in the moment before presence says the station has gone.
    const sender = new MqttClient({
      host: '127.0.0.1',
      port,
      clientId: 'kraftverk-server-poller',
      username: SERVER_USERNAME,
      password: () => TOKEN,
      subscriptions: ['nothing/here'],
    });
    sender.start();
    expect(await sender.waitForConnect(3000)).toBe(true);

    const absent = '0000000000BB';
    const before = journal.lastSeq;
    for (let i = 0; i < 3; i++) await sender.publish(`${absent}/client/request/data`, readInputRegisters(0, 80));
    await until(() => journal.query({ after: before, level: 'debug', kinds: ['command.undelivered'] }).length === 3, 'all three');

    const undelivered = journal.query({ after: before, level: 'debug', kinds: ['command.undelivered'] });
    expect(undelivered.map((entry) => entry.level)).toEqual(['warn', 'debug', 'debug']);
    await sender.stop();
  });

  test('a write is journalled at info level, with who received it', async () => {
    const station = await mqttClient(port, 'station-h');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.clientId === 'station-h' && bus.presence(STATION)!.online, 'online');

    await bus.send(STATION, writeRegister(26, 1));
    await until(() => station.received.length > 0, 'the write');
    const entry = journal.query({ level: 'info', kinds: ['command'] }).at(-1);
    expect(entry?.message).toContain('write holding 26 = 1');
    expect(entry?.data?.deliveredTo).toEqual(['station-h']);
    station.close();
  });
});

describe('the server’s connection', () => {
  test('comes back by itself when the broker is restarted under it', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const first = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: null });
    await first.start();
    const port = first.port!;

    const bus = new BrokerBus({ host: '127.0.0.1', port, token: () => TOKEN });
    bus.start();
    expect(await bus.waitForConnect(3000)).toBe(true);

    const station = await mqttClient(port, 'station-restart');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.online === true, 'the station online');

    await first.stop();
    await until(() => !bus.connected, 'the bus to notice');
    // What the old broker said about the station is not carried across: this
    // one has never seen it, and "online" from before would be a lie.
    expect(bus.presence(STATION)).toBeNull();

    const second = new StationBroker({ host: '127.0.0.1', port, token: TOKEN, journal, stationsFile: null });
    await second.start();
    expect(await bus.waitForConnect(8000)).toBe(true);
    await expect(bus.send(STATION, readHoldingRegisters(0, 80))).rejects.toThrow('has not connected');

    await bus.stop();
    await second.stop();
  }, 15_000);

  test('gives up on a port that accepts TCP but never speaks MQTT, and says so', async () => {
    // Accepts, and says nothing. Its sockets are tracked because `close` waits
    // for accepted sockets that were never read from, and would never return.
    const accepted = new Set<Socket>();
    const mute = createServer((socket) => accepted.add(socket));
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    const client = new MqttClient({
      host: '127.0.0.1',
      port: (mute.address() as { port: number }).port,
      clientId: 'patient',
      subscriptions: ['x'],
      handshakeTimeoutMs: 200,
    });
    const failed = new Promise<Error>((resolve) => client.once('failed', resolve));
    client.start();
    expect((await failed).message).toContain('did not complete an MQTT handshake');
    await client.stop();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => mute.close(() => resolve()));
  });

  test('a token that cannot be read fails the attempt instead of crashing the server', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: null });
    await broker.start();
    const client = new MqttClient({
      host: '127.0.0.1',
      port: broker.port!,
      clientId: 'tokenless',
      username: SERVER_USERNAME,
      password: () => {
        throw new Error('The broker token is empty');
      },
      subscriptions: ['x'],
    });
    const failed = new Promise<Error>((resolve) => client.once('failed', resolve));
    client.start();
    expect((await failed).message).toContain('token is empty');
    await client.stop();
    await broker.stop();
  });
});

describe('hardening', () => {
  test('an empty secret matches nothing, not even another empty one', () => {
    expect(sameSecret('', '')).toBe(false);
    expect(sameSecret(Buffer.alloc(0), '')).toBe(false);
    expect(sameSecret(TOKEN, TOKEN)).toBe(true);
    expect(sameSecret(`${TOKEN}x`, TOKEN)).toBe(false);
  });

  test('a command topic is refused however it is dressed up', () => {
    const frame = readHoldingRegisters(0, 80);
    for (const topic of [`/${COMMANDS}`, `x/${COMMANDS}`, `${STATION}/client/request/data/extra`]) {
      expect(refusalFor(topic, frame, false)).not.toBeNull();
    }
  });

  test('the journal treats a limit or cursor that is not a number as absent', () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    for (let i = 0; i < 300; i++) journal.info({ kind: 'test', message: String(i) });
    expect(journal.query({ limit: Number('abc') })).toHaveLength(200);
    expect(journal.query({ after: Number('abc'), limit: 5 }).map((e) => e.message)).toEqual(['295', '296', '297', '298', '299']);
  });

  test('a station with a client id longer than 23 characters is let in', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: null });
    await broker.start();
    const station = await mqttClient(broker.port!, 'a-station-with-a-rather-long-client-identifier');
    expect(station.isClosed).toBe(false);
    station.close();
    await broker.stop();
  });

  test('only the server may subscribe to the broker’s own topics', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: null });
    await broker.start();
    const snoop = new MqttClient({ host: '127.0.0.1', port: broker.port!, clientId: 'snoop', subscriptions: ['$kraftverk/journal'] });
    const refused = new Promise<Error>((resolve) => snoop.once('failed', resolve));
    snoop.start();
    expect((await refused).message).toContain('refused the subscription');
    // Refused, not cut off: a station asking for something odd keeps its connection.
    expect(snoop.connected).toBe(true);
    await snoop.stop();
    await broker.stop();
  });

  test('a station remembered from a broker that was killed is not given a stale departure time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-stations-'));
    const file = join(dir, 'stations.json');
    writeFileSync(
      file,
      JSON.stringify([{ station: STATION, online: true, remote: '192.168.50.12:51000', disconnectedAt: '2026-01-01T00:00:00.000Z' }])
    );
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = new StationBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, stationsFile: file });
    const [remembered] = broker.stations;
    expect(remembered).toMatchObject({ station: STATION, online: false, disconnectedAt: null });
    expect(remembered?.lastDisconnect).toContain('without shutting down cleanly');
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A read-input response in the echoed-header shape a P280 sends. */
function inputResponse(values: number[]): Uint8Array {
  const body = [0x11, 0x04, 0x00, 0x00, 0x00, values.length, ...values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff])];
  let crc = 0xffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return Uint8Array.from([...body, (crc >> 8) & 0xff, crc & 0xff]);
}

// --- a minimal MQTT 3.1.1 client ---------------------------------------------
//
// Hand-rolled rather than a dependency: three packet types are all these tests
// send, and the wire format they spell out is the one the station speaks.

type Received = { topic: string; payload: Buffer };

type TestClient = {
  received: Received[];
  readonly isClosed: boolean;
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array): void;
  /** Destroys the socket without a DISCONNECT, which is what makes a broker send a will. */
  drop(): void;
  close(): void;
};

const PACKET = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, DISCONNECT: 14 } as const;

/** A UTF-8 string or byte run, prefixed with its 16-bit length. */
function prefixed(value: string | Uint8Array): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** MQTT's variable-length "remaining length": seven bits per byte, high bit means more. */
function remainingLength(length: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

function packet(firstByte: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), remainingLength(body.length), body]);
}

async function mqttClient(
  port: number,
  clientId: string,
  will?: { topic: string; payload: Uint8Array }
): Promise<TestClient> {
  const socket = connect(port, '127.0.0.1');
  const received: Received[] = [];
  const waiting = new Map<number, () => void>();
  let pending = Buffer.alloc(0);
  let isClosed = false;

  socket.on('close', () => {
    isClosed = true;
  });
  socket.on('error', () => {
    // A refused client is disconnected mid-write; that is the expected outcome.
  });

  // No encoding is ever set on this socket, so every chunk is a Buffer.
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;

      let length = 0;
      let multiplier = 1;
      let index = 1;
      let byte: number;
      do {
        if (index >= pending.length) return; // the length itself has not all arrived
        byte = pending[index++]!;
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
      } while (byte & 0x80);
      if (pending.length < index + length) return;

      const type = pending[0]! >> 4;
      const body = pending.subarray(index, index + length);
      pending = pending.subarray(index + length);

      if (type === PACKET.PUBLISH) {
        // QoS 0, which is all this broker delivers: topic, then payload, no id.
        const topicLength = body.readUInt16BE(0);
        received.push({
          topic: body.subarray(2, 2 + topicLength).toString('utf8'),
          payload: Buffer.from(body.subarray(2 + topicLength)),
        });
      }

      waiting.get(type)?.();
      waiting.delete(type);
    }
  });

  const next = (type: number) => new Promise<void>((resolve) => waiting.set(type, resolve));

  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

  // Clean session, plus a will when one is asked for; keepalive 60 s.
  const flags = 0x02 | (will ? 0x04 : 0);
  const connect_ = packet(
    PACKET.CONNECT << 4,
    Buffer.concat([
      prefixed('MQTT'),
      Buffer.from([0x04, flags, 0x00, 0x3c]),
      prefixed(clientId),
      ...(will ? [prefixed(will.topic), prefixed(will.payload)] : []),
    ])
  );
  const acknowledged = next(PACKET.CONNACK);
  socket.write(connect_);
  await acknowledged;

  return {
    received,
    get isClosed() {
      return isClosed;
    },
    async subscribe(topic) {
      const acked = next(PACKET.SUBACK);
      // SUBSCRIBE carries a fixed flag nibble of 0b0010, a packet id, then filter + QoS.
      socket.write(
        packet((PACKET.SUBSCRIBE << 4) | 0x02, Buffer.concat([Buffer.from([0, 1]), prefixed(topic), Buffer.from([0])]))
      );
      await acked;
    },
    publish(topic, payload) {
      socket.write(packet(PACKET.PUBLISH << 4, Buffer.concat([prefixed(topic), Buffer.from(payload)])));
    },
    drop() {
      socket.destroy();
    },
    close() {
      if (!isClosed) socket.end(packet(PACKET.DISCONNECT << 4, Buffer.alloc(0)));
    },
  };
}

/** Waits for something the broker does asynchronously, and says what never happened. */
async function until(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
