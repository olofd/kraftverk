import { describe, expect, test } from 'bun:test';

import { memoryHeld, memoryKept, validateProtocol, type Channel, type SetupContext, type Sighting } from '@kraftverk/device-sdk';

import { COMPANION_LAN } from '../src/index.ts';
import protocol, {
  appleIdentity,
  CompanionLink,
  CompanionSession,
  hasVolume,
  playingOf,
  FrameType,
  Framer,
  pack,
  PairingRefused,
  PairSetup,
  readCredentials,
  unpack,
  writeCredentials,
  type Credentials,
} from '../src/protocol/index.ts';
import { PIN, playedAppleTv, TV_ID } from './played.ts';

/*
  Companion, against an Apple TV played: OPACK and frames as pyatv writes
  them, pairing with the PIN it shows — and refused with another — every
  connection after verified and sealed, and the remote's session over it.
*/

const fromHex = (hex: string): Uint8Array => new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function paired(tv: ReturnType<typeof playedAppleTv>): Promise<Credentials> {
  const link = new CompanionLink(tv.connect());
  const setup = new PairSetup();
  const started = await link.startPairing(setup);
  const credentials = await link.finishPairing(setup, started, PIN, 'kraftverk');
  await link.close();
  return credentials;
}

describe('OPACK', () => {
  test('writes as pyatv writes', () => {
    expect(hexOf(pack(true))).toBe('01');
    expect(hexOf(pack(null))).toBe('04');
    expect(hexOf(pack(7))).toBe('0f');
    expect(hexOf(pack(0x27))).toBe('2f');
    expect(hexOf(pack(0x28))).toBe('3028');
    expect(hexOf(pack(0x1234))).toBe('313412');
    expect(hexOf(pack('a'))).toBe('4161');
    expect(hexOf(pack(new Uint8Array([0xac])))).toBe('71ac');
    expect(hexOf(pack([1, 2]))).toBe('d2090a');
    expect(hexOf(pack({ a: 'b' }))).toBe('e141614162');
    expect(hexOf(pack(1.5))).toBe('36000000000000f83f');
  });

  test('reads what it wrote, and what refers back to a value read before', () => {
    const message = { _i: '_launchApp', _x: 40000, _t: 2, _c: { _bundleID: 'com.example.Films', _vol: 0.25, list: [true, false, null], data: new Uint8Array([1, 2, 3]) } };
    expect(unpack(pack(message)).value).toEqual(message);
    // ["a", "a"], the second as a reference to the first.
    expect(unpack(fromHex('d24161a0')).value).toEqual(['a', 'a']);
    // A 64-bit session id stays exact.
    expect(unpack(pack(0x1234_0000_5678n << 16n)).value).toBe(0x1234_0000_5678n << 16n);
    // Containers of fifteen or more end with a terminator.
    const long = Array.from({ length: 16 }, (_, index) => index);
    expect(unpack(pack(long)).value).toEqual(long);
  });
});

describe('frames', () => {
  test('gathered whole from bytes however they arrive, and sealed once keys are set', () => {
    const out = new Framer();
    const into = new Framer();
    const one = out.write(FrameType.PlainOpack, pack({ a: 1 }));
    const two = out.write(FrameType.PlainOpack, pack({ b: 2 }));
    const both = new Uint8Array([...one, ...two]);
    expect(into.read(both.subarray(0, 3))).toEqual([]);
    expect(into.read(both.subarray(3)).map((frame) => unpack(frame.payload).value)).toEqual([{ a: 1 }, { b: 2 }]);

    const key = (fill: number) => new Uint8Array(32).fill(fill);
    out.encrypt({ output: key(1), input: key(2) });
    into.encrypt({ output: key(2), input: key(1) });
    const sealed = out.write(FrameType.SealedOpack, pack({ secret: 'yes' }));
    expect(sealed.length).toBe(4 + pack({ secret: 'yes' }).length + 16);
    expect(unpack(into.read(sealed)[0]!.payload).value).toEqual({ secret: 'yes' });
    // Each frame its own nonce: the same message seals differently the second time.
    expect(hexOf(out.write(FrameType.SealedOpack, pack({ secret: 'yes' })))).not.toBe(hexOf(sealed));
  });
});

describe('pairing', () => {
  test('with the PIN the TV shows: each side keeps the other’s key, and the TV lists it by name', async () => {
    const tv = playedAppleTv();
    const credentials = await paired(tv);
    expect(credentials.tvKey.length).toBe(32);
    expect(new TextDecoder().decode(credentials.tvId)).toBe(TV_ID);
    expect([...tv.pairings.values()]).toEqual([{ key: expect.any(Uint8Array), name: 'kraftverk' }]);
    // Kept as pyatv keeps them: four parts, hex.
    const written = writeCredentials(credentials);
    expect(written.split(':')).toHaveLength(4);
    expect(readCredentials(written)).toEqual(credentials);
    expect(readCredentials('not:paired')).toBeNull();
    expect(readCredentials(null)).toBeNull();
  });

  test('with another PIN: refused, in words that say what to do', async () => {
    const tv = playedAppleTv();
    const link = new CompanionLink(tv.connect());
    const setup = new PairSetup();
    const started = await link.startPairing(setup);
    const refused = await link.finishPairing(setup, started, '9999', 'kraftverk').catch((error: Error) => error);
    expect(refused).toBeInstanceOf(PairingRefused);
    expect((refused as Error).message).toBe('That was not the PIN the TV shows: start again, and type the new one');
    expect(tv.pairings.size).toBe(0);
  });

  test('a connection verified with what pairing left — and refused with a pairing the TV does not keep', async () => {
    const tv = playedAppleTv();
    const credentials = await paired(tv);
    const link = new CompanionLink(tv.connect());
    await link.verify(credentials);
    expect(link.verified).toBe(true);
    await link.close();

    const other = playedAppleTv();
    const stranger = new CompanionLink(other.connect());
    await expect(stranger.verify(credentials)).rejects.toThrow(PairingRefused);
  });
});

describe('the remote’s session', () => {
  test('begun, then the remote’s keys, media control, volume, apps and whether it is awake', async () => {
    const tv = playedAppleTv();
    const link = new CompanionLink(tv.connect());
    const flags: unknown[] = [];
    link.onEvent('_iMC', (content) => flags.push(content._mcF));
    const session = await CompanionSession.begin(link, await paired(tv));
    expect(tv.asked.map((each) => each.id)).toEqual(['_systemInfo', '_sessionStart']);
    expect(tv.interests).toEqual(['_iMC', 'SystemStatus', 'TVSystemStatus']);
    expect(session.sessionId >> 32n).toBe(0x1234n);

    await session.media('pause');
    expect(tv.state.playing).toBe(false);
    // What can be done, said when asked for and again when it changed: playing, then paused.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(flags.map((each) => playingOf(each as number))).toEqual([true, false]);
    expect(hasVolume(flags[1] as number)).toBe(true);
    expect(playingOf(null)).toBeNull();
    expect(await session.volume()).toBe(30);
    await session.setVolume(55);
    expect(tv.state.volume).toBeCloseTo(0.55);
    expect(await session.apps()).toEqual({ 'com.apple.TVWatchList': 'TV', 'com.example.Films': 'Films' });
    await session.launch('com.example.Films');
    expect(tv.asked.at(-1)).toEqual({ id: '_launchApp', content: { _bundleID: 'com.example.Films' } });

    expect(await session.attention()).toBe('awake');
    await session.sleep();
    expect(await session.attention()).toBe('asleep');
    await session.wake();
    expect(tv.asked.filter((each) => each.id === '_hidC').map((each) => each.content)).toEqual([
      { _hBtS: 1, _hidC: 12 },
      { _hBtS: 2, _hidC: 12 },
      { _hBtS: 1, _hidC: 13 },
      { _hBtS: 2, _hidC: 13 },
    ]);

    // What it tells unasked.
    const told: unknown[] = [];
    session.link.onEvent('SystemStatus', (content) => told.push(content));
    tv.tell('SystemStatus', { state: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(told).toEqual([{ state: 1 }]);

    // A request it has no answer for: refused, not hung.
    await expect(session.link.request('_unknown')).rejects.toThrow('The TV refused: No handler for _unknown');
    await session.end();
    expect(tv.asked.at(-1)?.id).toBe('_sessionStop');
    await link.close();
  });

  test('pairing waits for the connection, made in the background', async () => {
    const tv = playedAppleTv();
    const channel = tv.connect();
    channel.setConnected(false);
    const link = new CompanionLink(channel);
    const setup = new PairSetup();
    const started = link.startPairing(setup);
    setTimeout(() => channel.setConnected(true), 10);
    expect((await started).length).toBeGreaterThan(0);
    await link.close();
  });

  test('a request the TV never answers ends, said', async () => {
    const tv = playedAppleTv();
    const credentials = await paired(tv);
    const link = new CompanionLink(tv.connect(), 30);
    await link.verify(credentials);
    tv.connections.at(-1)!.setConnected(false);
    await expect(link.request('_systemInfo')).rejects.toThrow();
  });
});

describe('the protocol, as setup meets it', () => {
  const pairAction = protocol.credentials!.actions!.find((action) => action.id === 'pair')!;
  // One setup's: what its first turn holds open, its next takes back.
  const held = memoryHeld();
  const contextFor = (open?: () => Promise<Channel>): SetupContext => ({
    adding: { typeId: 'apple-media.tv', kind: 'hardware' },
    kept: memoryKept(),
    draft: {},
    connection: {},
    address: '192.0.2.70',
    secrets: { get: () => null },
    http: () => Promise.reject(new Error('No HTTP here')),
    sightings: [],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    held,
    signal: AbortSignal.timeout(10_000),
    platform: 'system',
    ...(open ? { open } : {}),
  });

  test('valid, opened on the port the TV announced', () => {
    expect(validateProtocol(protocol)).toEqual([]);
    expect(protocol.bindings.lan!.open('192.0.2.70')).toEqual({ port: 49153 });
    expect(protocol.bindings.lan!.open('192.0.2.70', { port: 49154 })).toEqual({ port: 49154 });
    expect(COMPANION_LAN).toMatchObject({ id: 'companion', protocol: protocol.id, transport: 'lan', updates: 'push' });
  });

  test('recognises what speaks Companion by what it announces: its name, its model code, its port', () => {
    const sighting = (txt: Record<string, string>): Sighting => ({
      transport: 'lan',
      address: '192.0.2.70',
      seenAt: '2026-10-07T00:00:00.000Z',
      heard: [{ kind: 'mdns', service: '_companion-link._tcp', instance: 'Living Room', port: 49154, txt }],
    });
    // Its TXT keys in any case: mDNS's are not case-sensitive.
    expect(protocol.bindings.lan!.recognise(sighting({ rpmd: 'AppleTV11,1', rpVr: '540.30' }))).toEqual({
      name: 'Living Room',
      model: 'AppleTV11,1',
      detail: '192.0.2.70 · AppleTV11,1',
      config: { port: 49154 },
    });
    // Saying no model, it is nothing a type could be for.
    expect(protocol.bindings.lan!.recognise(sighting({ rpVr: '540.30' }))).toBeNull();
  });

  test('an Apple TV is known by the pairing id it verifies with', async () => {
    const credentials = await paired(playedAppleTv());
    expect(appleIdentity(credentials)).toBe(`apple-media:${TV_ID.toLowerCase()}`);
  });

  test('pairs in two turns: the TV shows a PIN, it is asked for, and what pairing left is kept', async () => {
    const tv = playedAppleTv();
    const first = await pairAction.run(contextFor(async () => tv.connect()), {});
    expect(first).toMatchObject({ ok: true, detail: 'The TV shows a PIN', ask: { schema: { fields: { pin: { type: 'string' } } } } });
    const carry = first.ask!.carry!;

    // Not four digits: asked again, on the same connection, held anew.
    const again = await pairAction.run(contextFor(), { ...carry, pin: '12' });
    // Taken before it is matched: Bun's toMatchObject writes an asymmetric matcher over what it matched.
    const heldAgain = { ...again.ask!.carry! };
    expect(again).toMatchObject({ ok: false, detail: 'Type the four digits the TV shows', ask: { carry: { pairing: expect.any(String) } } });
    expect(tv.connections[0]!.connected).toBe(true);

    const done = await pairAction.run(contextFor(), { ...heldAgain, pin: ` ${PIN} ` });
    expect(done).toMatchObject({ ok: true, detail: 'Paired: the TV lists it as “kraftverk”.' });
    expect(readCredentials(done.suggestedConfig!.credentials as string)).not.toBeNull();
    expect(tv.pairings.size).toBe(1);
    expect(tv.connections[0]!.connected).toBe(false);

    // Its turn is over: the same carry again finds nothing waiting.
    expect(await pairAction.run(contextFor(), { ...carry, pin: PIN })).toEqual({ ok: false, detail: 'The pairing ended before the PIN came: pair again' });
  });

  test('says what is wrong when it cannot pair', async () => {
    expect(await pairAction.run(contextFor(), {})).toEqual({ ok: false, detail: 'Choose the TV first' });
    const tv = playedAppleTv();
    const first = await pairAction.run(contextFor(async () => tv.connect()), {});
    const wrong = await pairAction.run(contextFor(), { ...first.ask!.carry!, pin: '9999' });
    expect(wrong).toEqual({ ok: false, detail: 'That was not the PIN the TV shows: start again, and type the new one' });
  });
});
