import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';

import { isRegion, REGIONS, signRequest, stringToSign } from './cloud.ts';
import { aesEcbEncrypt, crc32, DISCOVERY_KEY, hmacSha256, md5 } from './crypto.ts';
import { runSetupAction, SETUP_ACTIONS } from './setup.ts';
import { decodeBroadcast } from './discovery.ts';
import { CMD, encodeFrame, FrameReader, PREFIX_55AA, SUFFIX_55AA } from './frame.ts';
import { ATORCH_S1, decode, relayCandidates } from './profiles.ts';
import { parseDps } from './session.ts';

/**
 * The Tuya LAN protocol, checked against the published specification.
 *
 * Same approach as the station's MODBUS tests: build a frame, take it apart
 * again, and assert the parts that a subtle mistake would silently corrupt.
 */

const KEY = Buffer.from('0123456789abcdef', 'utf8');

describe('framing', () => {
  test('CRC-32 matches the known check value', () => {
    // The standard CRC-32/ISO-HDLC check: "123456789" -> 0xCBF43926.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  test('the discovery key is the published constant', () => {
    expect(DISCOVERY_KEY).toEqual(md5('yGAdlopoPVldABfn'));
  });

  test('a 3.3 status query round-trips', () => {
    const payload = Buffer.from(JSON.stringify({ gwId: 'abc', devId: 'abc' }));
    const frame = encodeFrame({ version: '3.3', key: KEY, sequence: 7, command: CMD.DP_QUERY, payload });

    expect(frame.readUInt32BE(0)).toBe(PREFIX_55AA);
    expect(frame.readUInt32BE(4)).toBe(7);
    expect(frame.readUInt32BE(8)).toBe(CMD.DP_QUERY);
    expect(frame.readUInt32BE(frame.length - 4)).toBe(SUFFIX_55AA);

    const frames = new FrameReader('3.3', KEY).push(frame);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.payload.toString())).toMatchObject({ gwId: 'abc' });
  });

  test('a 3.3 control frame carries the 15-byte version header, a query does not', () => {
    const payload = Buffer.from('{"dps":{"1":true}}');
    const control = encodeFrame({ version: '3.3', key: KEY, sequence: 1, command: CMD.CONTROL, payload });
    const query = encodeFrame({ version: '3.3', key: KEY, sequence: 1, command: CMD.DP_QUERY, payload });

    expect(control.subarray(16, 19).toString('ascii')).toBe('3.3');
    expect(query.subarray(16, 19).toString('ascii')).not.toBe('3.3');
    expect(control.length).toBe(query.length + 15);
  });

  test('3.4 signs with HMAC-SHA256 instead of a CRC', () => {
    const payload = Buffer.from('{}');
    const frame = encodeFrame({ version: '3.4', key: KEY, sequence: 2, command: CMD.DP_QUERY_NEW, payload });

    // 16 header + encrypted payload + 32 HMAC + 4 suffix.
    const encryptedLength = aesEcbEncrypt(KEY, payload).length;
    expect(frame.length).toBe(16 + encryptedLength + 32 + 4);
    expect(frame.readUInt32BE(12)).toBe(encryptedLength + 32 + 4);

    // The signature covers everything before it, so a flipped byte invalidates it.
    const signed = frame.subarray(0, 16 + encryptedLength);
    expect(frame.subarray(16 + encryptedLength, 16 + encryptedLength + 32)).toEqual(hmacSha256(KEY, signed));
  });

  test('a 3.4 frame round-trips under the session key', () => {
    // After negotiation both sides use the session key, not the local key —
    // reading a 3.4 reply with the wrong one of the two is the classic mistake.
    const sessionKey = aesEcbEncrypt(KEY, Buffer.alloc(16, 7)).subarray(0, 16);
    const payload = Buffer.from(JSON.stringify({ protocol: 4, data: { dps: { '1': true } } }));

    const frame = encodeFrame({
      version: '3.4',
      key: sessionKey,
      sequence: 9,
      command: CMD.DP_QUERY_NEW,
      payload,
    });

    const frames = new FrameReader('3.4', sessionKey).push(frame);
    expect(frames).toHaveLength(1);
    expect(parseDps(frames[0]!.payload)).toEqual({ '1': true });

    // The same bytes read with the local key produce nothing usable.
    const wrong = new FrameReader('3.4', KEY).push(frame);
    expect(wrong.length === 0 || parseDps(wrong[0]!.payload)).not.toEqual({ '1': true });
  });

  test('the 3.4 session key is derived from both nonces', () => {
    // START/RESP/FINISH exchange nonces; the key is AES(localKey, a XOR b).
    const localNonce = Buffer.alloc(16, 0x0f);
    const remoteNonce = Buffer.alloc(16, 0xf0);
    const mixed = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) mixed[i] = localNonce[i]! ^ remoteNonce[i]!;

    expect(mixed).toEqual(Buffer.alloc(16, 0xff));
    const sessionKey = aesEcbEncrypt(KEY, mixed).subarray(0, 16);
    expect(sessionKey).toHaveLength(16);
    // Derived, not either input: a session cannot be replayed with the static key.
    expect(sessionKey.equals(KEY)).toBe(false);
  });

  test('a split response still assembles, and junk between frames is skipped', () => {
    const frame = encodeFrame({
      version: '3.3',
      key: KEY,
      sequence: 3,
      command: CMD.DP_QUERY,
      payload: Buffer.from('{"dps":{"1":true}}'),
    });

    const reader = new FrameReader('3.3', KEY);
    expect(reader.push(frame.subarray(0, 9))).toHaveLength(0);
    expect(reader.push(frame.subarray(9))).toHaveLength(1);

    expect(reader.push(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toHaveLength(0);
    expect(reader.push(frame)).toHaveLength(1);
  });
});

describe('discovery', () => {
  /** Builds the broadcast a device sends: a 55AA frame encrypted with the public key. */
  const broadcast = (json: object): Buffer => {
    const body = aesEcbEncrypt(DISCOVERY_KEY, Buffer.from(JSON.stringify(json)));
    const header = Buffer.alloc(20);
    header.writeUInt32BE(PREFIX_55AA, 0);
    header.writeUInt32BE(0, 4);
    header.writeUInt32BE(0x13, 8);
    header.writeUInt32BE(body.length + 8 + 4, 12);
    return Buffer.concat([header, body, Buffer.alloc(8)]);
  };

  test('reads a device out of an encrypted announcement', () => {
    const device = decodeBroadcast(
      broadcast({ ip: '192.168.50.74', gwId: 'bf8dc9', version: '3.4', productKey: 'keym55', active: 2 })
    );

    expect(device).toMatchObject({
      ip: '192.168.50.74',
      gwId: 'bf8dc9',
      version: '3.4',
      encrypted: true,
      active: true,
    });
  });

  test('ignores traffic that is not a Tuya frame', () => {
    expect(decodeBroadcast(Buffer.from('hello'))).toBeNull();
  });
});

describe('the ATORCH profile', () => {
  // Raw values in the shape the published datapoint map describes: current in
  // milliamps, power and voltage in hundredths.
  const dps = { '1': true, '18': 3260, '19': 74500, '20': 23120, '123': 1250, '133': 5000, '134': 98 };

  test('decodes to engineering units', () => {
    expect(decode(ATORCH_S1, dps)).toMatchObject({
      relayOn: true,
      amps: 3.26,
      watts: 745,
      volts: 231.2,
      kwh: 12.5,
      hz: 50,
    });
  });

  test('an overridden relay datapoint is honoured', () => {
    // The disputed case: firmware where DP 131 is the real relay and DP 1 lies.
    const disputed = { ...dps, '1': true, '131': false };
    expect(decode(ATORCH_S1, disputed, 131).relayOn).toBe(false);
    expect(decode(ATORCH_S1, disputed, 1).relayOn).toBe(true);
  });

  test('relay candidates put the documented datapoints first', () => {
    expect(relayCandidates({ '7': true, '131': false, '1': true, '19': 100 })).toEqual([1, 131, 7]);
  });

  test('missing datapoints stay undefined rather than becoming zero', () => {
    const sparse = decode(ATORCH_S1, { '1': false });
    expect(sparse.relayOn).toBe(false);
    expect(sparse.watts).toBeUndefined();
  });
});

describe('cloud signing', () => {
  test('the canonical string is method, body hash, headers, path — in that order', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(stringToSign('GET', '/v1.0/token?grant_type=1')).toBe(
      `GET\n${emptyHash}\n\n/v1.0/token?grant_type=1`
    );
  });

  test('a token request signs client id and timestamp; a business request adds the token', () => {
    const base = { clientId: 'id', secret: 'secret', timestamp: 1_700_000_000_000, method: 'GET', path: '/v1.0/devices/x' };

    const token = signRequest(base);
    const business = signRequest({ ...base, accessToken: 'abc' });

    // Uppercase hex, and the access token genuinely changes the signature —
    // signing the wrong payload is the failure Tuya reports only as "sign invalid".
    expect(token).toMatch(/^[0-9A-F]{64}$/);
    expect(business).toMatch(/^[0-9A-F]{64}$/);
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
    expect(isRegion('sg')).toBe(true);
    expect(isRegion('mars')).toBe(false);
    expect(REGIONS.eu.host).toBe('openapi.tuyaeu.com');
  });
});

describe('setup actions', () => {
  test('both helpers are declared with input schemas the app can render', () => {
    expect(SETUP_ACTIONS.map((action) => action.id)).toEqual(['discover', 'fetchKeys']);
    for (const action of SETUP_ACTIONS) {
      expect(action.title.length).toBeGreaterThan(0);
      expect(Object.keys(action.input?.fields ?? {}).length).toBeGreaterThan(0);
    }
  });

  test('the credential field is a secret, so the app masks it and never stores it', () => {
    const keys = SETUP_ACTIONS.find((action) => action.id === 'fetchKeys');
    expect(keys?.input?.fields.clientSecret?.type).toBe('secret');
  });

  test('an unknown action is refused rather than ignored', async () => {
    const result = await runSetupAction('nope', {});
    expect(result.ok).toBe(false);
  });
});

describe('response parsing', () => {
  test('reads the 3.3 shape', () => {
    expect(parseDps(Buffer.from('{"dps":{"1":true}}'))).toEqual({ '1': true });
  });

  test('reads the 3.4 wrapped shape', () => {
    expect(parseDps(Buffer.from('{"protocol":4,"t":1,"data":{"dps":{"20":2300}}}'))).toEqual({ '20': 2300 });
  });

  test('an empty payload is not an error', () => {
    expect(parseDps(Buffer.alloc(0))).toEqual({});
  });
});
