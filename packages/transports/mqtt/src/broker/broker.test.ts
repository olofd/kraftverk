import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memoryTransportStore, type MessageBrokerPolicy, type Sighting } from '@kraftverk/device-sdk';

import { BrokerBus, type BusMessage } from '../bus.ts';
import { MqttClient } from '../client.ts';
import createMqttTransport from '../system.ts';
import { matches, MessageBroker } from './broker.ts';
import { Journal } from './journal.ts';
import { loadPolicies, refusalFor, type Publisher } from './policy.ts';
import { sameSecret, SERVER_USERNAME } from './shared.ts';

/**
 * The broker, exercised the way it runs: a real TCP listener, a fake station
 * speaking raw MQTT, and the server's own bus as the privileged client.
 *
 * Who may command a device: the server, and no one else — and not even the
 * server may send the frame these tests keep forging, because a Sydpower
 * station's holding register 68 set to 0 permanently bricks it.
 *
 * The broker knows no protocol of its own, so these tests load the installed
 * ones exactly as the broker does at start-up — and build their frames from
 * bytes, because a transport's tests may not reach into an integration.
 */

const STATION = 'AABBCC001122';
const COMMANDS = `${STATION}/client/request/data`;
const TOKEN = 'test-token-not-a-secret';

/** A MODBUS frame with its CRC appended big-endian, as a Sydpower station expects. */
function frame(bytes: number[]): Uint8Array {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return Uint8Array.from([...bytes, (crc >> 8) & 0xff, crc & 0xff]);
}
const readHolding = (start: number, count: number) => frame([0x11, 0x03, start >> 8, start & 0xff, count >> 8, count & 0xff]);
const readInput = (start: number, count: number) => frame([0x11, 0x04, start >> 8, start & 0xff, count >> 8, count & 0xff]);
const writeHolding = (register: number, value: number) => frame([0x11, 0x06, register >> 8, register & 0xff, value >> 8, value & 0xff]);
/** A read-input response in the echoed-header shape a P280 sends. */
const inputResponse = (values: number[]) =>
  frame([0x11, 0x04, 0x00, 0x00, 0x00, values.length, ...values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff])]);

/** The eight bytes that destroy the station. */
const BRICK = writeHolding(68, 0);

const ANYONE: Publisher = { privileged: false, signedIn: null };
const SERVER: Publisher = { privileged: true, signedIn: null };
const BRIDGE_CLIENT: Publisher = { privileged: false, signedIn: 'bridge' };

/**
 * A protocol spoken by a bridge: one client for every device behind it, its
 * topics under one root, its devices spoken for only by a client that signed
 * in — the shape of a bridge client, named for no product.
 */
const BRIDGE: MessageBrokerPolicy = {
  protocol: 'bridge-test',
  root: 'bridge-test/',
  signedIn: true,
  fromDevice: (topic) => (topic.startsWith('bridge-test/') ? { address: 'bridge-test', channel: topic.slice('bridge-test/'.length) } : null),
  subscribedBy: (filter) => (filter === 'bridge-test/#' ? 'bridge-test' : null),
  commandFor: (topic) => (/^bridge-test\/.+\/set$/.test(topic) ? 'bridge-test' : null),
  refuse: (topic) => (topic.endsWith('/forbidden/set') ? 'that is never sent' : null),
  describeCommand: (topic) => ({ summary: `set ${topic}`, level: 'info' }),
  describeMessage: (channel) => ({ summary: channel, level: 'debug' }),
};
const BRIDGE_PASSWORD = 'bridge-password-not-a-secret';

let policies: MessageBrokerPolicy[];
beforeAll(async () => {
  policies = await loadPolicies();
});

const newBroker = (journal: Journal, extra: Partial<ConstructorParameters<typeof MessageBroker>[0]> = {}) =>
  new MessageBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, policies, devicesFile: null, ...extra });

describe('the protocols the broker applies', () => {
  test('are found the way the broker finds them, and include the Sydpower stations’', () => {
    expect(policies.map((policy) => policy.protocol)).toContain('sydpower');
  });

  test('a broker with no protocol refuses to exist', () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    expect(() => new MessageBroker({ host: '127.0.0.1', port: 0, token: TOKEN, journal, policies: [], devicesFile: null })).toThrow();
  });

  test('a protocol that cannot be loaded stops the broker starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-protocols-'));
    const broken = join(dir, 'broken');
    await Bun.write(join(broken, 'package.json'), JSON.stringify({ kraftverk: { integration: { protocols: ['./missing.ts'] } } }));
    await expect(loadPolicies(dir)).rejects.toThrow('could not be loaded');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('refusalFor', () => {
  const poll = () => readHolding(0, 80);

  test('refuses a command topic to anyone but the server, however it is spelled', () => {
    for (const topic of [COMMANDS, COMMANDS.toLowerCase(), `${STATION}/Client/Request/data`, `${STATION}/client/request`]) {
      expect(refusalFor(policies, topic, poll(), ANYONE)).not.toBeNull();
      expect(refusalFor(policies, topic, poll(), SERVER)).toBeNull();
    }
  });

  test('refuses the brick write even to the server', () => {
    expect(refusalFor(policies, COMMANDS, BRICK, SERVER)).toContain('bricks');
  });

  test('lets a station say everything it has been seen saying', () => {
    for (const channel of ['state', 'client/04', 'client/data']) {
      expect(refusalFor(policies, `${STATION}/device/response/${channel}`, poll(), ANYONE)).toBeNull();
    }
  });

  test('keeps $SYS and the broker’s own topics reserved', () => {
    expect(refusalFor(policies, '$SYS/broker/heartbeat', poll(), ANYONE)).not.toBeNull();
    expect(refusalFor(policies, `$kraftverk/device/sydpower/${STATION}`, poll(), ANYONE)).not.toBeNull();
    expect(refusalFor(policies, '$kraftverk/journal', poll(), SERVER)).not.toBeNull();
  });
});

describe('a protocol spoken by a bridge', () => {
  test('its root is its own: a device named like a station’s command is not one', () => {
    const all = [...policies, BRIDGE];
    expect(refusalFor(all, 'bridge-test/lamp/client/request/data', readHolding(0, 1), BRIDGE_CLIENT)).toBeNull();
  });

  test('only a client that signed in may speak for its devices; only the server may command them', () => {
    const all = [...policies, BRIDGE];
    expect(refusalFor(all, 'bridge-test/lamp', new Uint8Array(), ANYONE)).toContain('signed in');
    expect(refusalFor(all, 'bridge-test/lamp', new Uint8Array(), BRIDGE_CLIENT)).toBeNull();
    expect(refusalFor(all, 'bridge-test/lamp/set', new Uint8Array(), BRIDGE_CLIENT)).toContain('Only the kraftverk server');
    expect(refusalFor(all, 'bridge-test/lamp/set', new Uint8Array(), SERVER)).toBeNull();
  });

  test('its refusals see the topic: the server is refused what the protocol never sends', () => {
    expect(refusalFor([...policies, BRIDGE], 'bridge-test/forbidden/set', new Uint8Array(), SERVER)).toBe('that is never sent');
  });

  test('signs in with its password, holds its device, and a second client cannot speak for it', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal, { policies: [...policies, BRIDGE], clients: new Map([['bridge', BRIDGE_PASSWORD]]) });
    await broker.start();

    await expect(mqttClient(broker.port!, 'wrong', undefined, { username: 'bridge', password: 'not-it' })).rejects.toThrow('refused');

    const bridge = await mqttClient(broker.port!, 'bridge-1', undefined, { username: 'bridge', password: BRIDGE_PASSWORD });
    bridge.publish('bridge-test/bridge/state', new TextEncoder().encode('online'));
    await until(() => broker.devices.some((device) => device.address === 'bridge-test' && device.online), 'the bridge online');

    // Someone listening — anyone may — is not the bridge: subscribing takes nothing, and leaving takes it nowhere.
    const listener = await mqttClient(broker.port!, 'listener');
    await listener.subscribe('bridge-test/#');
    expect(broker.devices.find((device) => device.address === 'bridge-test')).toMatchObject({ online: true, clientId: 'bridge-1' });
    listener.drop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broker.devices.find((device) => device.address === 'bridge-test')).toMatchObject({ online: true, clientId: 'bridge-1' });

    const impostor = await mqttClient(broker.port!, 'impostor');
    impostor.publish('bridge-test/lamp', new TextEncoder().encode('{"state":"ON"}'));
    await until(() => impostor.isClosed, 'the impostor cut off');

    const second = await mqttClient(broker.port!, 'bridge-2', undefined, { username: 'bridge', password: BRIDGE_PASSWORD });
    second.publish('bridge-test/lamp', new TextEncoder().encode('{"state":"ON"}'));
    await until(() => second.isClosed, 'the second bridge cut off');
    expect(broker.devices.find((device) => device.address === 'bridge-test')?.clientId).toBe('bridge-1');

    bridge.close();
    await broker.stop();
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
  let broker: MessageBroker;
  let journal: Journal;
  let port: number;
  let bus: BrokerBus;

  beforeAll(async () => {
    journal = new Journal({ dir: null, consoleLevel: 'off' });
    broker = newBroker(journal);
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

  const online = (clientId: string) => () => bus.presence(STATION)?.clientId === clientId && bus.presence(STATION)!.online;

  test('a client cannot command a station: the brick write never arrives', async () => {
    const station = await mqttClient(port, 'station-a');
    await station.subscribe(COMMANDS);
    await until(() => bus.presence(STATION)?.subscribed === true, 'the station’s presence to arrive');

    const intruder = await mqttClient(port, 'intruder-a');
    intruder.publish(COMMANDS, BRICK);
    await until(() => intruder.isClosed, 'the broker to cut the intruder off');

    // The server can still command it — and its frame is the only one that
    // lands. Had the forged write got through, it would be first in this list.
    const poll = readHolding(0, 80);
    await bus.publish(COMMANDS, poll);
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
    await until(online('station-b'), 'presence');

    const refusedBefore = broker.refusals.length;
    const intruder = await mqttClient(port, 'intruder-b', { topic: COMMANDS, payload: BRICK });
    intruder.drop();
    await until(() => broker.refusals.length > refusedBefore, 'the will to be refused');

    const poll = readHolding(0, 80);
    await bus.publish(COMMANDS, poll);
    await until(() => station.received.length > 0, 'the server’s frame to arrive');

    expect(station.received.map((message) => [...message.payload])).toEqual([[...poll]]);
    expect(broker.refusals.at(-1)?.topic).toBe(COMMANDS);
    station.close();
  });

  test('the server cannot brick it either: the broker refuses the server too', async () => {
    const station = await mqttClient(port, 'station-c');
    await station.subscribe(COMMANDS);
    await until(online('station-c'), 'presence');

    // A privileged client whose own guard failed is still stopped by the broker.
    // (The server's links refuse it before it leaves: see the protocol's tests.)
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
    const squatter = new MqttClient({ host: '127.0.0.1', port, clientId: 'kraftverk-server-1', subscriptions: ['#'] });
    const refused = new Promise<Error>((resolve) => squatter.once('failed', resolve));
    squatter.start();
    expect((await refused).message).toContain('client id');
    await squatter.stop();
  });

  test('a station can report, and is not cut off for it', async () => {
    const station = await mqttClient(port, 'station-d');
    const heard = new Promise<BusMessage>((resolve) => {
      const listener = (message: BusMessage) => {
        if (!message.topic.startsWith(STATION)) return;
        bus.off('message', listener);
        resolve(message);
      };
      bus.on('message', listener);
    });

    station.publish(`${STATION}/device/response/state`, new TextEncoder().encode('1'));
    const message = await heard;

    expect(message.topic).toBe(`${STATION}/device/response/state`);
    expect(new TextDecoder().decode(message.payload)).toBe('1');
    expect(station.isClosed).toBe(false);
    station.close();
  });

  test('presence says when a station leaves, and why', async () => {
    const station = await mqttClient(port, 'station-e');
    await station.subscribe(COMMANDS);
    await until(online('station-e'), 'online');
    expect(bus.presence(STATION)?.protocol).toBe('sydpower');

    station.drop();
    await until(() => bus.presence(STATION)?.online === false, 'offline');
    expect(bus.presence(STATION)?.lastDisconnect).toContain('without an MQTT DISCONNECT');
  });

  test('a station that vanishes has its last will journalled as that, not as a message', async () => {
    // What a real P280 registers: a will on its own state topic (seen 2026-09-26).
    const station = await mqttClient(port, 'device_WILL', { topic: `${STATION}/device/response/state`, payload: new TextEncoder().encode('0') });
    await station.subscribe(COMMANDS);
    await until(online('device_WILL'), 'online');

    const before = journal.lastSeq;
    station.drop();
    await until(() => journal.query({ after: before, kinds: ['mqtt.will'] }).length > 0, 'the will');
    expect(journal.query({ after: before, kinds: ['mqtt.will'] })[0]?.message).toContain('"0"');
    await until(() => bus.presence(STATION)?.online === false, 'offline');
  });

  test('presence is retained: a server that connects later learns it at once', async () => {
    const station = await mqttClient(port, 'station-f');
    await station.subscribe(COMMANDS);
    await until(online('station-f'), 'online');

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
    await until(online('station-g'), 'online');

    // A reply: asked for, answered.
    const reply = inputResponse([1, 2]);
    await bus.publish(COMMANDS, readInput(0, 2));
    await until(() => station.received.length > 0, 'the poll');
    station.publish(`${STATION}/device/response/client/04`, reply);
    await until(() => journal.query({ level: 'debug', kinds: ['device.message'] }).some((e) => e.message.includes('reply in')), 'the reply');

    // Unprompted: nobody asked.
    station.publish(`${STATION}/device/response/client/04`, reply);
    await until(() => journal.query({ level: 'debug', kinds: ['device.message'] }).some((e) => e.message.includes('unprompted')), 'the push');

    station.close();
    await until(() => bus.presence(STATION)?.online === false, 'offline');
  });

  test('commands that go nowhere are warned about once, not on every poll', async () => {
    const before = journal.lastSeq;
    const absent = '0000000000BB';
    for (let i = 0; i < 3; i++) await bus.publish(`${absent}/client/request/data`, readInput(0, 80));
    await until(() => journal.query({ after: before, level: 'debug', kinds: ['command.undelivered'] }).length === 3, 'all three');

    const undelivered = journal.query({ after: before, level: 'debug', kinds: ['command.undelivered'] });
    expect(undelivered.map((entry) => entry.level)).toEqual(['warn', 'debug', 'debug']);
  });

  test('a write is journalled at info level, with who received it', async () => {
    const station = await mqttClient(port, 'station-h');
    await station.subscribe(COMMANDS);
    await until(online('station-h'), 'online');

    await bus.publish(COMMANDS, writeHolding(26, 1));
    await until(() => station.received.length > 0, 'the write');
    const entry = journal.query({ level: 'info', kinds: ['command'] }).at(-1);
    expect(entry?.message).toContain('write holding 26 = 1');
    expect(entry?.data?.deliveredTo).toEqual(['station-h']);
    station.close();
  });
});

describe('the transport’s channel to one device', () => {
  test('is connected while the device is, and carries its topics both ways', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal);
    await broker.start();
    const port = broker.port!;

    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-broker-dir-'));
    await Bun.write(join(dir, 'token'), TOKEN);
    const lines: string[] = [];
    const transport = createMqttTransport({
      env: {
        MQTT_PORT: String(port),
        BROKER_HOST: '127.0.0.1',
        BROKER_SPAWN: '0',
        // Nothing answers here: this broker has no admin API, and the channel does not need one.
        BROKER_ADMIN_URL: 'http://127.0.0.1:9',
        KRAFTVERK_BROKER_DIR: dir,
      },
      log: (_level, message) => lines.push(message),
      audit: () => undefined,
      store: memoryTransportStore(),
    });
    await transport.start();

    const channel = await transport.open(STATION, {});
    if (channel.kind !== 'messages') throw new Error('expected a messages channel');
    expect(channel.connected).toBe(false);
    await expect(transport.open(STATION, {})).rejects.toThrow('already open');

    const changes: boolean[] = [];
    channel.onConnectedChange((connected) => changes.push(connected));
    const station = await mqttClient(port, 'station-channel');
    await station.subscribe(COMMANDS);
    await until(() => channel.connected, 'the channel to see the station');

    const heard: string[] = [];
    channel.subscribe(`${STATION}/device/response/#`, (message) => heard.push(message.topic));
    await channel.publish(COMMANDS, readInput(0, 80));
    await until(() => station.received.length > 0, 'the command');
    station.publish(`${STATION}/device/response/client/04`, inputResponse([7]));
    await until(() => heard.length > 0, 'the answer');
    expect(heard).toEqual([`${STATION}/device/response/client/04`]);

    // What the broker keeps on a topic reaches a subscription made after it was said, as MQTT promises.
    station.publish(`${STATION}/device/response/state`, new TextEncoder().encode('1'), { retain: true });
    await until(() => heard.length > 1, 'the retained state, live');
    const late: string[] = [];
    channel.subscribe(`${STATION}/device/response/state`, (message) => late.push(new TextDecoder().decode(message.payload)));
    await until(() => late.length > 0, 'the retained state, to a late subscription');
    expect(late).toEqual(['1']);

    // What the transport sees is what the add flow lists.
    let seen: readonly Sighting[] = [];
    const stop = transport.watch!([], (sightings) => (seen = sightings));
    expect(seen.find((s) => s.address === STATION)?.heard).toEqual([{ kind: 'client', protocol: 'sydpower', online: true }]);
    stop();

    station.drop();
    await until(() => !channel.connected, 'the channel to see it leave');
    expect(changes).toEqual([true, false]);

    await channel.close();
    await transport.stop();
    await broker.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the server’s connection', () => {
  test('comes back by itself when the broker is restarted under it', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const first = newBroker(journal);
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

    const second = newBroker(journal, { port });
    await second.start();
    expect(await bus.waitForConnect(8000)).toBe(true);
    expect(bus.presence(STATION)).toBeNull();

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
    const broker = newBroker(journal);
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
    const poll = readHolding(0, 80);
    for (const topic of [`/${COMMANDS}`, `x/${COMMANDS}`, `${STATION}/client/request/data/extra`]) {
      expect(refusalFor(policies, topic, poll, ANYONE)).not.toBeNull();
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
    const broker = newBroker(journal);
    await broker.start();
    const station = await mqttClient(broker.port!, 'a-station-with-a-rather-long-client-identifier');
    expect(station.isClosed).toBe(false);
    station.close();
    await broker.stop();
  });

  test('only the server may subscribe to the broker’s own topics', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal);
    await broker.start();
    const snoop = new MqttClient({ host: '127.0.0.1', port: broker.port!, clientId: 'snoop', subscriptions: ['$kraftverk/journal'] });
    const refused = new Promise<Error>((resolve) => snoop.once('failed', resolve));
    snoop.start();
    expect((await refused).message).toContain('refused the subscription');
    // Refused, not cut off: a device asking for something odd keeps its connection.
    expect(snoop.connected).toBe(true);
    await snoop.stop();
    await broker.stop();
  });

  test('a device remembered from a broker that was killed is not given a stale departure time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-devices-'));
    const file = join(dir, 'devices.json');
    writeFileSync(
      file,
      JSON.stringify([{ protocol: 'sydpower', address: STATION, online: true, remote: '192.0.2.12:51000', disconnectedAt: '2026-01-01T00:00:00.000Z' }])
    );
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal, { devicesFile: file });
    const [remembered] = broker.devices;
    expect(remembered).toMatchObject({ protocol: 'sydpower', address: STATION, online: false, disconnectedAt: null });
    expect(remembered?.lastDisconnect).toContain('without shutting down cleanly');
    rmSync(dir, { recursive: true, force: true });
  });

  test('what is kept on a topic outlives the broker: a new one keeps it again, for whoever subscribes next', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraftverk-retained-'));
    const file = join(dir, 'retained.json');
    const first = newBroker(new Journal({ dir: null, consoleLevel: 'off' }), { retainedFile: file });
    await first.start();
    const station = await mqttClient(first.port!, 'kept-state');
    station.publish(`${STATION}/device/response/state`, new TextEncoder().encode('1'), { retain: true });
    station.publish('somewhere/cleared', new TextEncoder().encode('x'), { retain: true });
    station.publish('somewhere/cleared', new Uint8Array(), { retain: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    station.close();
    await first.stop();

    const second = newBroker(new Journal({ dir: null, consoleLevel: 'off' }), { retainedFile: file });
    await second.start();
    const reader = await mqttClient(second.port!, 'reader');
    await reader.subscribe('#');
    await until(() => reader.received.some((message) => message.topic === `${STATION}/device/response/state`), 'the kept state');
    expect(reader.received.find((message) => message.topic === `${STATION}/device/response/state`)?.payload.toString()).toBe('1');
    expect(reader.received.some((message) => message.topic === 'somewhere/cleared')).toBe(false);
    reader.close();
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a client’s traffic that no protocol knows is said at info once a minute, not on every message', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal);
    await broker.start();
    const chatty = await mqttClient(broker.port!, 'chatty');
    for (let i = 0; i < 5; i++) chatty.publish(`somewhere/else/${i}`, new TextEncoder().encode(String(i)));
    await until(() => journal.query({ level: 'debug', kinds: ['mqtt.publish'] }).length === 5, 'all five');
    expect(journal.query({ level: 'info', kinds: ['mqtt.publish'] })).toHaveLength(1);
    chatty.close();
    await broker.stop();
  });

  test('the journal keeps a payload’s first bytes, not all of a large one', async () => {
    const journal = new Journal({ dir: null, consoleLevel: 'off' });
    const broker = newBroker(journal);
    await broker.start();
    const big = await mqttClient(broker.port!, 'big');
    big.publish('somewhere/large', new Uint8Array(5000));
    await until(() => journal.query({ kinds: ['mqtt.publish'] }).length === 1, 'the publish');
    const hex = String(journal.query({ kinds: ['mqtt.publish'] })[0]?.data?.hex);
    expect(hex.endsWith('…(+4800 B)')).toBe(true);
    expect(hex.length).toBeLessThan(500);
    big.close();
    await broker.stop();
  });
});

// --- a minimal MQTT 3.1.1 client ---------------------------------------------
//
// Hand-rolled rather than a dependency: three packet types are all these tests
// send, and the wire format they spell out is the one the station speaks.

type Received = { topic: string; payload: Buffer };

type TestClient = {
  received: Received[];
  readonly isClosed: boolean;
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: Uint8Array, options?: { retain?: boolean }): void;
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
  will?: { topic: string; payload: Uint8Array },
  login?: { username: string; password: string }
): Promise<TestClient> {
  const socket = connect(port, '127.0.0.1');
  const received: Received[] = [];
  const waiting = new Map<number, () => void>();
  let pending = Buffer.alloc(0);
  let isClosed = false;
  let refusedWith = 0;

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

      // The CONNACK's return code: anything but 0 is the broker turning the connection away.
      if (type === PACKET.CONNACK) refusedWith = body[1] ?? 0;

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

  // Clean session, plus a will and a sign-in when asked for; keepalive 60 s.
  const flags = 0x02 | (will ? 0x04 : 0) | (login ? 0xc0 : 0);
  const connect_ = packet(
    PACKET.CONNECT << 4,
    Buffer.concat([
      prefixed('MQTT'),
      Buffer.from([0x04, flags, 0x00, 0x3c]),
      prefixed(clientId),
      ...(will ? [prefixed(will.topic), prefixed(will.payload)] : []),
      ...(login ? [prefixed(login.username), prefixed(login.password)] : []),
    ])
  );
  const acknowledged = next(PACKET.CONNACK);
  socket.write(connect_);
  await Promise.race([
    acknowledged,
    new Promise((_, reject) => socket.once('close', () => reject(new Error('The broker refused the connection')))),
  ]);
  if (isClosed || refusedWith !== 0) throw new Error(`The broker refused the connection (code ${refusedWith})`);

  return {
    received,
    get isClosed() {
      return isClosed;
    },
    async subscribe(topic) {
      const acked = next(PACKET.SUBACK);
      // SUBSCRIBE carries a fixed flag nibble of 0b0010, a packet id, then filter + QoS.
      socket.write(packet((PACKET.SUBSCRIBE << 4) | 0x02, Buffer.concat([Buffer.from([0, 1]), prefixed(topic), Buffer.from([0])])));
      await acked;
    },
    publish(topic, payload, options) {
      socket.write(packet((PACKET.PUBLISH << 4) | (options?.retain ? 1 : 0), Buffer.concat([prefixed(topic), Buffer.from(payload)])));
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
