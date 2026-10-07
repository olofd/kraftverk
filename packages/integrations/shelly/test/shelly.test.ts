import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { needsSignIn, validateProtocol, type DeviceContext, type DeviceSession, type Sighting } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import { describeShelly, SHELLY_WAYS, shellySwitch } from '../src/index.ts';
import protocol, { authOf, clientFrame, merged, readFrames, shellyIdentity, switchesOf } from '../src/protocol/index.ts';
import { MAC, playedShelly } from './played.ts';

/*
  The first port from Home Assistant (docs/PORTING-FROM-HOME-ASSISTANT.md):
  Shelly's RPC over its WebSocket, against a device played byte for byte
  (played.ts), and the switch type that describes itself from it.
*/

const until = async (holds: () => boolean, what: string) => {
  for (let tries = 0; tries < 200 && !holds(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!holds()) throw new Error(`Waited for ${what}`);
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the protocol', () => {
  test('is a valid protocol, ridden over the home network', () => {
    expect(validateProtocol(protocol)).toEqual([]);
    expect(protocol.bindings.lan!.open('192.0.2.60')).toEqual({ port: 80 });
    expect(protocol.bindings.lan!.parseAddress!(' 192.0.2.60 ')).toBe('192.0.2.60');
    expect(protocol.bindings.lan!.parseAddress!('999.0.0.1')).toBeNull();
  });

  test('recognises a Shelly of Gen2 and later by what it announces over mDNS, its MAC its identity', () => {
    const sighting = (instance: string, txt: Record<string, string>): Sighting => ({
      transport: 'lan',
      address: '192.0.2.60',
      seenAt: '2026-10-07T00:00:00.000Z',
      heard: [{ kind: 'mdns', service: '_shelly._tcp', instance, port: 80, txt }],
    });
    expect(protocol.bindings.lan!.recognise(sighting('shellyplusplugs-c4dee2a1b2c3', { gen: '2', app: 'PlusPlugS', ver: '1.4.2' }))).toEqual({
      name: 'Shelly PlusPlugS',
      identity: shellyIdentity(MAC),
      model: 'PlusPlugS',
      detail: '192.0.2.60 · Gen 2 · 1.4.2',
    });
    expect(shellyIdentity('C4:DE:E2:A1:B2:C3')).toBe('shelly-rpc:c4dee2a1b2c3');
    expect(protocol.bindings.lan!.recognise(sighting('shellyplug-s-c4dee2', { gen: '1' }))).toBeNull();
    expect(protocol.bindings.lan!.recognise(sighting('living-room-tv', { gen: '2' }))).toBeNull();
  });

  test('frames: a client’s masked, read back whole at every length a header changes at', () => {
    for (const length of [0, 1, 125, 126, 127, 65535, 65536]) {
      const payload = new Uint8Array(length).map((_, index) => index % 251);
      const frame = clientFrame(0x1, payload);
      expect(frame[1]! & 0x80).toBe(0x80);
      const read = readFrames(frame);
      expect(read.used).toBe(frame.length);
      expect(read.frames[0]?.payload).toEqual(payload);
    }
    // A frame cut short is waited for, never half read.
    expect(readFrames(clientFrame(0x1, new Uint8Array(300)).subarray(0, 100))).toEqual({ frames: [], used: 0 });
  });

  test('signs in by digest, as Shelly applies it: admin, its realm, SHA-256', () => {
    const challenge = { realm: 'shellyplusplugs-c4dee2a1b2c3', nonce: 1_700_000_000, algorithm: 'SHA-256' };
    const ha1 = sha('admin:shellyplusplugs-c4dee2a1b2c3:secret');
    const ha2 = sha('dummy_method:dummy_uri');
    expect(authOf(challenge, 'secret', 42)).toEqual({ realm: challenge.realm, username: 'admin', nonce: challenge.nonce, cnonce: 42, response: sha(`${ha1}:1700000000:1:42:auth:${ha2}`), algorithm: 'SHA-256' });
  });

  test('a change it tells of is merged into all it said', () => {
    const status = { 'switch:0': { id: 0, output: false, apower: 0, aenergy: { total: 10, by_minute: [1, 2, 3] } }, wifi: { rssi: -60 } };
    const next = merged(status, { 'switch:0': { output: true, aenergy: { total: 11 } } });
    expect(switchesOf(next)).toEqual([{ id: 0, output: true, apower: 0, aenergy: { total: 11, by_minute: [1, 2, 3] } } as never]);
    expect(next.wifi).toEqual({ rssi: -60 });
  });
});

describe('a Shelly switch', () => {
  test('keeps the device-type contract, and is reached the way it is found', async () => {
    expect(await checkDeviceTypeContract(shellySwitch, { settleMs: 300 })).toEqual([]);
    expect(SHELLY_WAYS[0]).toMatchObject({ protocol: 'shelly-rpc', transport: 'lan', reach: 'local', updates: 'push', discovery: [{ kind: 'mdns', service: '_shelly._tcp' }] });
  }, 30_000);

  test('describes itself: an outlet for each output, with the meter it has', () => {
    const description = describeShelly([{ id: 0, output: true, apower: 5 }, { id: 1, output: false }]);
    expect(description.parts?.map((part) => [part.id, part.label, part.offers ?? []])).toEqual([
      ['main', 'Shelly', []],
      ['switch.0', 'Output 1', ['switch']],
      ['switch.1', 'Output 2', ['switch']],
    ]);
    expect(description.attributes.map((attribute) => attribute.key)).toEqual(['switch.0.on', 'switch.0.power', 'switch.1.on', 'signal']);
  });

  test('is read once at the check: who it is, and what it does now', async () => {
    const played = playedShelly();
    const identified = await shellySwitch.identify(played.connection(), { config: {}, log: { info: () => {}, warn: () => {}, error: () => {} }, signal: AbortSignal.timeout(5_000) });
    expect(identified).toEqual({ identity: shellyIdentity(MAC), model: 'PlusPlugS', summary: 'A Shelly PlusPlugS (SNPL-00112EU), firmware 1.4.2: off, drawing 0 W.' });
  });

  test('with a password: signed in when it is right, waiting on a person when it is missing or wrong', async () => {
    const quiet = { config: {}, log: { info: () => {}, warn: () => {}, error: () => {} }, signal: AbortSignal.timeout(5_000) };
    const right = playedShelly({ password: 'correct horse' });
    expect((await shellySwitch.identify(right.connection({ password: 'correct horse' }), quiet)).identity).toBe(shellyIdentity(MAC));
    for (const secrets of [{}, { password: 'wrong' }] as Record<string, string>[]) {
      const thrown = await shellySwitch.identify(playedShelly({ password: 'correct horse' }).connection(secrets), quiet).catch((error: unknown) => error);
      expect(needsSignIn(thrown)).toBe(true);
    }
  });

  test('a first-generation Shelly is said to be one, not mistaken for another', async () => {
    const quiet = { config: {}, log: { info: () => {}, warn: () => {}, error: () => {} }, signal: AbortSignal.timeout(5_000) };
    await expect(shellySwitch.identify(playedShelly({ gen: 1 }).connection(), quiet)).rejects.toThrow('first generation');
  });

  test('its session: readings as it says them, kept current by what it tells of, switched through Switch.Set', async () => {
    const played = playedShelly();
    let changed = 0;
    const timers: ReturnType<typeof setInterval>[] = [];
    const ctx = {
      deviceId: 'd-1' as never,
      config: {},
      connection: played.connection(),
      simulation: null,
      clock: { now: () => Date.now() },
      store: { get: () => null, set: () => {}, delete: () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      readOnly: false,
      allowRawFrames: false,
      platform: 'system',
      schedule: (ms: number, task: () => void) => void timers.push(setInterval(task, ms)),
      changed: () => void changed++,
      event: () => {},
    } as unknown as DeviceContext<Record<string, never>>;
    const session: DeviceSession = await shellySwitch.createSession(ctx);
    const reading = (key: string) => session.readings().find((each) => each.key === key)?.value;
    await until(() => reading('switch.0.on') === false, 'its first status');
    expect(reading('switch.0.voltage')).toBe(231.2);
    expect(reading('switch.0.energy')).toBe(1.235);
    expect(reading('signal')).toBe(-61);
    expect(session.health().status).toBe('connected');
    expect(session.identity?.()).toEqual({ id: shellyIdentity(MAC), name: null });
    expect(session.info?.()).toEqual({ manufacturer: 'Shelly', model: 'SNPL-00112EU', firmware: { main: '1.4.2' } });
    expect(session.description?.()?.parts?.map((part) => part.id)).toEqual(['main', 'switch.0']);

    // Switched on someone else's word — at the plug, in its app: it tells, unasked.
    played.notify({ 'switch:0': { output: true, apower: 830.4 } });
    await until(() => reading('switch.0.power') === 830.4, 'what it told of');
    expect(reading('switch.0.on')).toBe(true);
    expect(reading('switch.0.voltage')).toBe(231.2);

    expect(await session.command({ part: 'switch.0', capability: 'switch', command: 'set', args: { on: false } })).toEqual({ accepted: true });
    expect(played.switches.get(0)?.output).toBe(false);
    expect(reading('switch.0.on')).toBe(false);
    expect(await session.command({ part: 'main', capability: 'switch', command: 'set', args: { on: false } })).toMatchObject({ accepted: false });

    for (const timer of timers) clearInterval(timer);
    await session.close();
    expect(changed).toBeGreaterThan(0);
  });
});
