import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';

import { fakeByteChannel } from '@kraftverk/device-sdk/testing';

import { concat, readU32, text, toHex, utf8 } from './bytes.ts';
import { isRegion, REGIONS, signRequest, stringToSign } from './cloud.ts';
import { aesEcbDecrypt, aesEcbEncrypt } from './crypto/aes.ts';
import { crc32, hmacSha256 } from './crypto/hash.ts';
import { decodeBroadcast, DISCOVERY_KEY } from './discovery.ts';
import { CMD, encodeFrame, FrameReader, PREFIX_55AA, SUFFIX_55AA, type ProtocolVersion } from './frame.ts';
import protocol, { cidOfAddress, linkOver, parseTuyaAddress, tuyaIdentity } from './index.ts';
import { parseDps, sessionKeyOf, TuyaLink } from './session.ts';
import { datapointRaw, datapointValue, decodeSocket, encodeSocket, relayDps, type ProfileDatapoint, type SocketProfile } from './socket.ts';

/**
 * The Tuya LAN protocol, checked against the published specification — and a
 * device on the other end of a byte channel that speaks it, so a conversation
 * is proven end to end with no network at all.
 */

const KEY = utf8('0123456789abcdef');

describe('framing', () => {
  test('CRC-32 matches the known check value', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });

  test('a 3.3 status query round-trips', () => {
    const payload = utf8(JSON.stringify({ gwId: 'abc', devId: 'abc' }));
    const frame = encodeFrame({ version: '3.3', key: KEY, sequence: 7, command: CMD.DP_QUERY, payload });

    expect(readU32(frame, 0)).toBe(PREFIX_55AA);
    expect(readU32(frame, 4)).toBe(7);
    expect(readU32(frame, 8)).toBe(CMD.DP_QUERY);
    expect(readU32(frame, frame.length - 4)).toBe(SUFFIX_55AA);

    const frames = new FrameReader('3.3', KEY).push(frame);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(text(frames[0]!.payload))).toMatchObject({ gwId: 'abc' });
  });

  test('a 3.3 control frame carries the 15-byte version header, a query does not', () => {
    const payload = utf8('{"dps":{"1":true}}');
    const control = encodeFrame({ version: '3.3', key: KEY, sequence: 1, command: CMD.CONTROL, payload });
    const query = encodeFrame({ version: '3.3', key: KEY, sequence: 1, command: CMD.DP_QUERY, payload });

    expect(text(control.subarray(16, 19))).toBe('3.3');
    expect(text(query.subarray(16, 19))).not.toBe('3.3');
    expect(control.length).toBe(query.length + 15);
  });

  test('3.4 signs with HMAC-SHA256 instead of a CRC', () => {
    const payload = utf8('{}');
    const frame = encodeFrame({ version: '3.4', key: KEY, sequence: 2, command: CMD.DP_QUERY_NEW, payload });
    const encryptedLength = aesEcbEncrypt(KEY, payload).length;
    expect(frame.length).toBe(16 + encryptedLength + 32 + 4);
    expect(readU32(frame, 12)).toBe(encryptedLength + 32 + 4);
    // The signature covers everything before it, so a flipped byte invalidates it.
    const signed = frame.subarray(0, 16 + encryptedLength);
    expect(frame.subarray(16 + encryptedLength, 16 + encryptedLength + 32)).toEqual(hmacSha256(KEY, signed));
  });

  test('3.4 puts the version header inside the encryption on a control, and not on a query', () => {
    const control = encodeFrame({ version: '3.4', key: KEY, sequence: 1, command: CMD.CONTROL_NEW, payload: utf8('{"data":{"dps":{"1":true}}}') });
    const query = encodeFrame({ version: '3.4', key: KEY, sequence: 1, command: CMD.DP_QUERY_NEW, payload: utf8('{}') });
    const bodyOf = (frame: Uint8Array) => aesEcbDecrypt(KEY, frame.subarray(16, frame.length - 36));
    expect(text(bodyOf(control).subarray(0, 3))).toBe('3.4');
    expect(text(bodyOf(query).subarray(0, 3))).not.toBe('3.4');
    // And the reader takes it off again.
    expect(parseDps(new FrameReader('3.4', KEY).push(control)[0]!.payload)).toEqual({ '1': true });
  });

  test('a 3.4 frame is read only with the session key', () => {
    const sessionKey = aesEcbEncrypt(KEY, new Uint8Array(16).fill(7)).subarray(0, 16);
    const payload = utf8(JSON.stringify({ protocol: 4, data: { dps: { '1': true } } }));
    const frame = encodeFrame({ version: '3.4', key: sessionKey, sequence: 9, command: CMD.DP_QUERY_NEW, payload });

    const frames = new FrameReader('3.4', sessionKey).push(frame);
    expect(frames).toHaveLength(1);
    expect(parseDps(frames[0]!.payload)).toEqual({ '1': true });

    const wrong = new FrameReader('3.4', KEY).push(frame);
    expect(wrong.length === 0 || parseDps(wrong[0]!.payload)).not.toEqual({ '1': true });
  });

  test('a 3.5 frame round-trips under AES-GCM', () => {
    const payload = utf8('{"dps":{"1":false}}');
    const frame = encodeFrame({ version: '3.5', key: KEY, sequence: 1, command: CMD.CONTROL_NEW, payload, iv: new Uint8Array(12).fill(3) });
    const frames = new FrameReader('3.5', KEY).push(frame);
    expect(frames).toHaveLength(1);
    expect(parseDps(frames[0]!.payload)).toEqual({ '1': false });
  });

  test('a split response still assembles, and junk between frames is skipped', () => {
    const frame = encodeFrame({ version: '3.3', key: KEY, sequence: 3, command: CMD.DP_QUERY, payload: utf8('{"dps":{"1":true}}') });
    const reader = new FrameReader('3.3', KEY);
    expect(reader.push(frame.subarray(0, 9))).toHaveLength(0);
    expect(reader.push(frame.subarray(9))).toHaveLength(1);
    expect(reader.push(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).toHaveLength(0);
    expect(reader.push(frame)).toHaveLength(1);
  });
});

/** The broadcast a device sends: a 55AA frame encrypted with the public key. */
function broadcast(json: object): Uint8Array {
  const body = aesEcbEncrypt(DISCOVERY_KEY, utf8(JSON.stringify(json)));
  const header = concat(Uint8Array.of(0, 0, 0x55, 0xaa), new Uint8Array(4), Uint8Array.of(0, 0, 0, 0x13), new Uint8Array(4));
  new DataView(header.buffer).setUint32(12, body.length + 8 + 4);
  return concat(header, new Uint8Array(4), body, new Uint8Array(8));
}

describe('discovery', () => {
  test('reads a device out of an encrypted announcement', () => {
    const device = decodeBroadcast(broadcast({ ip: '192.0.2.74', gwId: 'bf8dc9', version: '3.4', productKey: 'keym55', active: 2 }));
    expect(device).toMatchObject({ ip: '192.0.2.74', gwId: 'bf8dc9', version: '3.4', encrypted: true, active: true });
  });

  test('reads a 3.5 device out of its own frame: AES-GCM under the same public key', () => {
    const payload = utf8(JSON.stringify({ ip: '192.0.2.196', gwId: 'bfefca', version: '3.5', productKey: 'pl28o0', active: 2 }));
    const frame = encodeFrame({ version: '3.5', key: DISCOVERY_KEY, sequence: 0, command: 0x13, payload, iv: new Uint8Array(12).fill(7) });
    expect(decodeBroadcast(frame)).toMatchObject({ ip: '192.0.2.196', gwId: 'bfefca', version: '3.5', productKey: 'pl28o0', encrypted: true });
  });

  test('ignores traffic that is not a Tuya frame', () => {
    expect(decodeBroadcast(utf8('hello'))).toBeNull();
  });

  test('the binding recognises it as a sighting, with its identity and what to connect with', () => {
    const recognised = protocol.bindings.lan!.recognise({
      transport: 'lan',
      address: '192.0.2.74',
      seenAt: new Date().toISOString(),
      facts: { port: 6667, payload: toHex(broadcast({ ip: '192.0.2.74', gwId: 'bf8dc9', version: '3.4', productKey: 'keym55', active: 2 })) },
    });
    expect(recognised).toMatchObject({
      identity: tuyaIdentity('bf8dc9'),
      model: 'keym55',
      config: { deviceId: 'bf8dc9', protocolVersion: '3.4' },
    });
    expect(protocol.bindings.lan!.parseAddress!('192.0.2.300')).toBeNull();
    expect(protocol.bindings.lan!.parseAddress!(' 192.0.2.30 ')).toBe('192.0.2.30');
  });
});

describe('a socket profile', () => {
  const profile: SocketProfile = {
    id: 'example',
    label: 'Example',
    relay: { dp: 1 },
    metrics: { amps: { dp: 18, scale: 3 }, watts: { dp: 19, scale: 2 }, volts: { dp: 20, scale: 2 }, kwh: { dp: 123, scale: 2 } },
  };
  const dps = { '1': true, '18': 3260, '19': 74500, '20': 23120, '123': 1250 };

  test('decodes to engineering units', () => {
    expect(decodeSocket(profile, dps)).toMatchObject({ relayOn: true, amps: 3.26, watts: 745, volts: 231.2, kwh: 12.5 });
  });

  test('encodes as a plug of the profile sends it, which decodes to the same reading', () => {
    expect(encodeSocket(profile, { relayOn: true, amps: 3.26, watts: 745, volts: 231.2, kwh: 12.5 })).toEqual(dps);
    expect(decodeSocket(profile, encodeSocket(profile, { relayOn: false, watts: 0 }))).toMatchObject({ relayOn: false, watts: 0 });
  });

  test('missing datapoints stay undefined rather than becoming zero', () => {
    const sparse = decodeSocket(profile, { '1': false });
    expect(sparse.relayOn).toBe(false);
    expect(sparse.watts).toBeUndefined();
  });
});

describe('a relay switched in words, with a separate status', () => {
  // DP 131 switches, open or close; DP 1 only reports; in auto, DP 132 names the mode that cut it.
  const profile: SocketProfile = {
    id: 'words',
    label: 'Words',
    relay: { dp: 131, on: 'open', off: 'close', status: 1, cutWhile: { dp: 132, clear: 'off' } },
    metrics: {},
  };

  test('is written as its words, not as a boolean on the status datapoint', () => {
    expect(relayDps(profile.relay, true)).toEqual({ '131': 'open' });
    expect(relayDps(profile.relay, false)).toEqual({ '131': 'close' });
  });

  test('the switching datapoint is the truth: a status that disagrees is not believed', () => {
    // Written to DP 1 once, the plug reports false there while the relay stays on.
    expect(decodeSocket(profile, { '131': 'open', '1': false }).relayOn).toBe(true);
    expect(decodeSocket(profile, { '131': 'close', '1': true }).relayOn).toBe(false);
  });

  test('in auto, a mode that cut it is off even when the status was not pushed; otherwise the status says', () => {
    expect(decodeSocket(profile, { '131': 'auto', '1': true, '132': 'outage_a' }).relayOn).toBe(false);
    expect(decodeSocket(profile, { '131': 'auto', '1': true, '132': 'off' }).relayOn).toBe(true);
    expect(decodeSocket(profile, { '131': 'auto', '132': 'off' }).relayOn).toBeUndefined();
  });

  test('a simulated plug of the profile answers in the same words', () => {
    expect(encodeSocket(profile, { relayOn: false })).toEqual({ '131': 'close', '1': false });
  });
});

describe('a profile datapoint', () => {
  const boot: ProfileDatapoint = {
    dp: 138,
    key: 'bootBehaviour',
    label: 'After a power cut',
    value: { type: 'enum', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }, { value: 'last', label: 'As it was' }] },
    wire: { on: 'open', off: 'colse', last: 'memory' },
    example: 'last',
  };
  const limit: ProfileDatapoint = { dp: 104, key: 'overVoltage', label: 'Over-voltage', value: { type: 'number', unit: 'V' }, scale: 1, example: 265 };

  test('text is translated both ways through its wire words, the plug’s spelling included', () => {
    expect(datapointValue(boot, { '138': 'colse' })).toBe('off');
    expect(datapointRaw(boot, 'off')).toBe('colse');
    expect(datapointValue(boot, { '138': 'memory' })).toBe('last');
  });

  test('numbers are scaled, and what the plug has not said, or says unknowably, is null', () => {
    expect(datapointValue(limit, { '104': 2577 })).toBe(257.7);
    expect(datapointRaw(limit, 257.7)).toBe(2577);
    expect(datapointValue(limit, {})).toBeNull();
    expect(datapointValue(boot, { '138': 'sideways' })).toBeNull();
  });
});

describe('cloud signing', () => {
  test('the canonical string is method, body hash, headers, path — in that order', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(stringToSign('GET', '/v1.0/token?grant_type=1')).toBe(`GET\n${emptyHash}\n\n/v1.0/token?grant_type=1`);
  });

  test('a token request signs client id and timestamp; a business request adds the token', () => {
    const base = { clientId: 'id', secret: 'secret', timestamp: 1_700_000_000_000, method: 'GET', path: '/v1.0/devices/x' };
    const token = signRequest(base);
    const business = signRequest({ ...base, accessToken: 'abc' });
    expect(token).toMatch(/^[0-9A-F]{64}$/);
    expect(token).not.toBe(business);
    expect(business).toBe(
      createHmac('sha256', 'secret')
        .update('id' + 'abc' + '1700000000000' + stringToSign('GET', '/v1.0/devices/x'))
        .digest('hex')
        .toUpperCase()
    );
  });

  test('every documented data centre is offered, and unknown ones are rejected', () => {
    expect(isRegion('eu')).toBe(true);
    expect(isRegion('mars')).toBe(false);
    expect(REGIONS.eu.host).toBe('openapi.tuyaeu.com');
  });

  test('the local key is a secret credential, and the cloud account is never one kept', () => {
    expect(protocol.credentials!.schema.fields.localKey).toMatchObject({ type: 'string', presentation: 'secret' });
    const fetch = protocol.credentials!.actions!.find((action) => action.id === 'fetchKey')!;
    expect(fetch.input!.fields.clientSecret).toMatchObject({ type: 'string', presentation: 'secret' });
  });
});

describe('response parsing', () => {
  test('reads the 3.3 shape, the 3.4 wrapped shape, and nothing as nothing', () => {
    expect(parseDps(utf8('{"dps":{"1":true}}'))).toEqual({ '1': true });
    expect(parseDps(utf8('{"protocol":4,"t":1,"data":{"dps":{"20":2300}}}'))).toEqual({ '20': 2300 });
    expect(parseDps(new Uint8Array())).toEqual({});
  });
});

// --- a device on the other end --------------------------------------------------

/**
 * A Tuya plug that speaks `version` with `key`, answering queries with `dps`
 * and applying controls to them. On 3.4 it runs the device's half of the
 * session handshake, then speaks with the negotiated key.
 */
function fakePlug(version: ProtocolVersion, key: Uint8Array, dps: Record<string, string | number | boolean>) {
  let reader = new FrameReader(version, key);
  let sessionKey = key;
  let remoteNonce: Uint8Array | null = null;
  let sequence = 100;
  const reply = (command: number, payload: Uint8Array, withKey = sessionKey) =>
    encodeFrame({ version, key: withKey, sequence: sequence++, command, payload, iv: version === '3.5' ? new Uint8Array(12).fill(1) : undefined });

  const channel = fakeByteChannel((bytes) => {
    const out: Uint8Array[] = [];
    for (const frame of reader.push(bytes)) {
      if (frame.command === CMD.SESS_KEY_NEG_START) {
        remoteNonce = utf8('fedcba9876543210');
        out.push(reply(CMD.SESS_KEY_NEG_RESP, concat(remoteNonce, hmacSha256(key, frame.payload)), key));
        // The client's nonce, kept to derive the session key once it finishes.
        (channel as { clientNonce?: Uint8Array }).clientNonce = frame.payload;
      } else if (frame.command === CMD.SESS_KEY_NEG_FINISH) {
        const clientNonce = (channel as { clientNonce?: Uint8Array }).clientNonce!;
        const mixed = new Uint8Array(16);
        for (let i = 0; i < 16; i++) mixed[i] = clientNonce[i]! ^ remoteNonce![i]!;
        sessionKey = sessionKeyOf(version, key, clientNonce, mixed);
        reader = new FrameReader(version, sessionKey);
      } else if (frame.command === CMD.DP_QUERY || frame.command === CMD.DP_QUERY_NEW) {
        out.push(reply(frame.command, utf8(JSON.stringify(version === '3.3' ? { dps } : { protocol: 4, data: { dps } }))));
      } else if (frame.command === CMD.CONTROL || frame.command === CMD.CONTROL_NEW) {
        const asked = JSON.parse(text(frame.payload)) as { dps?: typeof dps; data?: { dps: typeof dps } };
        Object.assign(dps, asked.dps ?? asked.data?.dps ?? {});
        out.push(reply(CMD.STATUS, utf8(JSON.stringify(version === '3.3' ? { dps } : { protocol: 4, data: { dps } }))));
      }
    }
    return out;
  });
  return Object.assign(channel, {
    reset: async () => {
      // A fresh connection: whatever was negotiated belongs to the old one.
      reader = new FrameReader(version, key);
      sessionKey = key;
      channel.setConnected(false);
      channel.setConnected(true);
    },
  });
}

/**
 * A Tuya Zigbee gateway, as the RSH GW018-DM behaves (a Zigbee plug's README):
 * 3.4, its own datapoints, and devices behind it by cid. A query naming a
 * device answers what the gateway last heard, then pushes what the device
 * says now; a control is acknowledged empty, then the change is pushed.
 */
function fakeGateway(key: Uint8Array, children: Record<string, Record<string, string | number | boolean>>, fresh: Record<string, Record<string, number>> = {}) {
  let reader = new FrameReader('3.4', key);
  let sessionKey = key;
  let clientNonce: Uint8Array | null = null;
  const remoteNonce = utf8('fedcba9876543210');
  let sequence = 200;
  const own = { '4': false, '32': 'normal' };
  const frame = (command: number, body: unknown, withKey = sessionKey) =>
    encodeFrame({ version: '3.4', key: withKey, sequence: sequence++, command, payload: body instanceof Uint8Array ? body : utf8(JSON.stringify(body)) });
  const channel = fakeByteChannel((bytes) => {
    const out: Uint8Array[] = [];
    for (const got of reader.push(bytes)) {
      if (got.command === CMD.SESS_KEY_NEG_START) {
        clientNonce = got.payload;
        out.push(frame(CMD.SESS_KEY_NEG_RESP, concat(remoteNonce, hmacSha256(key, got.payload)), key));
      } else if (got.command === CMD.SESS_KEY_NEG_FINISH) {
        const mixed = new Uint8Array(16).map((_, i) => clientNonce![i]! ^ remoteNonce[i]!);
        sessionKey = sessionKeyOf('3.4', key, clientNonce!, mixed);
        reader = new FrameReader('3.4', sessionKey);
      } else if (got.command === CMD.DP_QUERY_NEW) {
        const asked = JSON.parse(text(got.payload)) as { cid?: string };
        const child = asked.cid ? children[asked.cid] : undefined;
        if (!asked.cid) out.push(frame(CMD.DP_QUERY_NEW, { dps: own }));
        else if (child) {
          out.push(frame(CMD.DP_QUERY_NEW, { dps: child, cid: asked.cid }));
          const now = fresh[asked.cid];
          if (now) {
            Object.assign(child, now);
            out.push(frame(CMD.STATUS, { protocol: 4, t: 1, data: { dps: now, cid: asked.cid, type: 'query' } }));
          }
        }
      } else if (got.command === CMD.CONTROL_NEW) {
        const asked = JSON.parse(text(got.payload)) as { data: { cid: string; dps: Record<string, boolean> } };
        Object.assign(children[asked.data.cid]!, asked.data.dps);
        out.push(frame(CMD.CONTROL_NEW, new Uint8Array()));
        out.push(frame(CMD.STATUS, { protocol: 4, t: 1, data: { dps: asked.data.dps, cid: asked.data.cid } }));
      }
    }
    return out;
  });
  return Object.assign(channel, {
    /** Something the gateway says unasked: a change at a device, or who it can reach. */
    say: (command: number, body: unknown) => channel.push(frame(command, body)),
  });
}

describe('a device behind a gateway', () => {
  const GATEWAY_KEY = '0123456789abcdef';
  const PLUG = 'a4c1380000000001';
  const OTHER = 'a4c1380000000002';

  test('is read and switched through the gateway, named by its cid; the gateway’s own datapoints are not its', async () => {
    const gateway = fakeGateway(utf8(GATEWAY_KEY), { [PLUG]: { '1': false, '19': 0 }, [OTHER]: { '1': true } });
    const link = new TuyaLink(gateway, { deviceId: 'bfplug', localKey: GATEWAY_KEY, version: '3.4', cid: PLUG });
    expect(await link.status()).toEqual({ '1': false, '19': 0 });
    expect(await link.set({ '1': true })).toEqual({});
    expect(await link.status()).toEqual({ '1': true, '19': 0 });
    const asked = gateway.written.map((bytes) => new FrameReader('3.4', utf8(GATEWAY_KEY)).push(bytes)).flat();
    expect(asked.length).toBeGreaterThan(0);
    await link.close();
  });

  test('hears what the gateway says of it — the fresh reading after a query, a change — and nothing of another device', async () => {
    const gateway = fakeGateway(utf8(GATEWAY_KEY), { [PLUG]: { '1': true, '19': 0 }, [OTHER]: { '1': true } }, { [PLUG]: { '19': 9970, '18': 4310 } });
    const pushed: Record<string, unknown>[] = [];
    const presence: boolean[] = [];
    const link = new TuyaLink(gateway, { deviceId: 'bfplug', localKey: GATEWAY_KEY, version: '3.4', cid: PLUG, onPush: (dps) => pushed.push(dps), onPresence: (online) => presence.push(online) });
    // A query is answered with what the gateway last heard; what the plug says now follows as a push — heard.
    expect(await link.status()).toMatchObject({ '1': true });
    await Bun.sleep(5);
    expect(pushed).toContainEqual({ '19': 9970, '18': 4310 });

    gateway.say(CMD.STATUS, { protocol: 4, t: 2, data: { dps: { '1': false }, cid: OTHER } });
    gateway.say(CMD.STATUS, { protocol: 4, t: 2, data: { dps: { '1': false }, cid: PLUG } });
    gateway.say(CMD.LAN_EXT_STREAM, { reqType: 'subdev_online_stat_report', data: { online: [], offline: [PLUG] } });
    await Bun.sleep(5);
    expect(pushed.filter((dps) => dps['1'] === false)).toHaveLength(1);
    expect(presence).toEqual([false]);
    await link.close();
  });

  test('its address is its gateway’s, # its Zigbee address; typed, it is checked as such', () => {
    expect(parseTuyaAddress('192.0.2.30')).toBe('192.0.2.30');
    expect(parseTuyaAddress(' 192.0.2.30#A4C1380000000001 ')).toBe('192.0.2.30#a4c1380000000001');
    expect(parseTuyaAddress('192.0.2.30#plug')).toBeNull();
    expect(parseTuyaAddress('192.0.2.30#a4c1380000000001#x')).toBeNull();
    expect(parseTuyaAddress('example.com')).toBeNull();
    expect(cidOfAddress('192.0.2.30#a4c1380000000001')).toBe('a4c1380000000001');
    expect(cidOfAddress('192.0.2.30')).toBeNull();
  });

  test('a connection to it builds a link that names it, from its address', async () => {
    const gateway = fakeGateway(utf8(GATEWAY_KEY), { [PLUG]: { '1': true } });
    const link = linkOver({
      method: 'lan',
      protocol: 'tuya-local',
      transport: 'lan',
      address: `192.0.2.30#${PLUG}`,
      channel: gateway,
      config: { deviceId: 'bfplug', protocolVersion: '3.4' },
      secrets: { get: (field) => (field === 'localKey' ? GATEWAY_KEY : null) },
      platform: 'server',
    });
    expect(await link.status()).toEqual({ '1': true });
    await link.close();
  });

  test('a device the gateway does not have is said to be that, not a wrong key', async () => {
    const gateway = fakeGateway(utf8(GATEWAY_KEY), { [OTHER]: { '1': true } });
    const link = new TuyaLink(gateway, { deviceId: 'bfplug', localKey: GATEWAY_KEY, version: '3.4', cid: PLUG });
    await expect(link.status()).rejects.toThrow('says nothing of');
    await link.close();
  }, 30_000);
});

describe('a conversation with a plug', () => {
  const PLUG_KEY = '0123456789abcdef';

  test('over 3.3: read, then switch, and the answer is the plug’s own', async () => {
    const plug = fakePlug('3.3', utf8(PLUG_KEY), { '1': true, '19': 1520 });
    const link = new TuyaLink(plug, { deviceId: 'bf1', localKey: PLUG_KEY, version: '3.3' });
    expect(await link.status()).toEqual({ '1': true, '19': 1520 });
    expect(await link.set({ '1': false })).toMatchObject({ '1': false });
    expect(link.version).toBe('3.3');
    await link.close();
  });

  test('over 3.4: the handshake, then everything under the session key', async () => {
    const plug = fakePlug('3.4', utf8(PLUG_KEY), { '1': false });
    const link = new TuyaLink(plug, { deviceId: 'bf2', localKey: PLUG_KEY, version: '3.4' });
    expect(await link.status()).toEqual({ '1': false });
    expect(await link.set({ '1': true })).toMatchObject({ '1': true });
    await link.close();
  });

  test('over 3.5: the handshake and AES-GCM framing', async () => {
    const plug = fakePlug('3.5', utf8(PLUG_KEY), { '1': true, '19': 830 });
    const link = new TuyaLink(plug, { deviceId: 'bf7', localKey: PLUG_KEY, version: '3.5' });
    expect(await link.status()).toEqual({ '1': true, '19': 830 });
    expect(await link.set({ '1': false })).toMatchObject({ '1': false });
    await link.close();
  });

  test('detecting the version: a 3.3 plug is found after 3.4 fails, on a fresh connection', async () => {
    const plug = fakePlug('3.3', utf8(PLUG_KEY), { '1': true });
    const lines: string[] = [];
    const link = new TuyaLink(plug, { deviceId: 'bf3', localKey: PLUG_KEY, version: 'auto', log: (line) => lines.push(line) });
    expect(await link.status()).toEqual({ '1': true });
    expect(link.version).toBe('3.3');
    expect(lines).toContain('speaking protocol 3.3');
    await link.close();
  }, 30_000);

  test('a wrong key is reported as that, not as a healthy plug with no data', async () => {
    const plug = fakePlug('3.3', utf8(PLUG_KEY), { '1': true });
    const link = new TuyaLink(plug, { deviceId: 'bf4', localKey: 'ffffffffffffffff', version: '3.3' });
    await expect(link.status()).rejects.toThrow();
    await link.close();
  }, 30_000);

  test('a key of the wrong length is refused before anything is sent', async () => {
    const plug = fakePlug('3.3', utf8(PLUG_KEY), {});
    const link = new TuyaLink(plug, { deviceId: 'bf5', localKey: 'short', version: '3.3' });
    await expect(link.status()).rejects.toThrow('16 characters');
    expect(plug.written).toEqual([]);
  });

  test('a connection builds its link from what setup stored', async () => {
    const plug = fakePlug('3.3', utf8(PLUG_KEY), { '1': true });
    const link = linkOver({
      method: 'lan',
      protocol: 'tuya-local',
      transport: 'lan',
      address: '192.0.2.41',
      channel: plug,
      config: { deviceId: 'bf6', protocolVersion: '3.3' },
      secrets: { get: (field) => (field === 'localKey' ? PLUG_KEY : null) },
      platform: 'server',
    });
    expect(await link.status()).toEqual({ '1': true });
    await link.close();
  });
});
