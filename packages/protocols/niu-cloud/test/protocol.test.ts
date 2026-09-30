import { describe, expect, test } from 'bun:test';

import protocol, { md5Hex, NIU_ACCOUNT, NIU_API, NIU_APP_ID, NiuClient, parseScooters, parseState, signIn, timeOf, type NiuHttp } from '../src/index.ts';

/**
 * The NIU cloud as those before us found it (README.md): a sign-in that takes
 * an MD5 of the password, one envelope for every answer, a session NIU ends
 * with status 1131, and serials that some models call `sn_id`. Answered by a
 * fake NIU; every serial and token here is made up.
 */

describe('MD5, as the sign-in wants the password', () => {
  test('the RFC 1321 test suite', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
    // Not only ASCII: a password is UTF-8.
    expect(md5Hex('lösenord')).toHaveLength(32);
  });
});

/** A made-up scooter's state, as `index_info` sends it: strings and numbers mixed, as NIU does. */
const STATE = {
  isCharging: 1,
  isConnected: true,
  leftTime: '1.5',
  estimatedMileage: 38,
  nowSpeed: 0,
  isAccOn: 0,
  isFortificationOn: '1',
  lockStatus: 0,
  gsm: 4,
  gps: 3,
  centreCtrlBattery: '100',
  infoTimestamp: 1_790_000_000_000,
  batteries: { compartmentA: { isConnected: true, batteryCharging: 74, gradeBattery: '96.0' } },
};

type Asked = { url: string; method: string; body: string; token: string | null };

/** A fake NIU cloud: signs in one account, and serves one scooter's state from v3 only when `v5` is off. */
function niu(options: { v5?: boolean; expireAfter?: number } = {}) {
  const asked: Asked[] = [];
  let issued = 0;
  let served = 0;
  const http: NiuHttp = async (url, init) => {
    const body = String(init?.body ?? '');
    const headers = new Headers(init?.headers);
    asked.push({ url, method: init?.method ?? 'GET', body, token: headers.get('token') });
    const answer = (status: number, data?: unknown) => new Response(JSON.stringify({ status, desc: status ? 'no' : 'ok', data }));

    if (url === `${NIU_ACCOUNT}/v3/api/oauth2/token`) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'password') {
        if (form.get('account') !== 'rider@example.test' || form.get('password') !== md5Hex('correct horse')) return answer(2003);
        if (form.get('app_id') !== NIU_APP_ID) return answer(2004);
      }
      issued += 1;
      return answer(0, { token: { access_token: `token-${issued}`, refresh_token: `refresh-${issued}`, token_expires_in: 7200, refresh_token_expires_in: 2_592_000 } });
    }
    const token = headers.get('token');
    if (token !== `token-${issued}`) return answer(1131);
    if (url === `${NIU_API}/v5/scooter/list`) return answer(0, { items: [{ sn_id: 'N0TAREALSERIAL01', scooter_name: 'Blixten', sku_name: 'Model One' }] });
    if (url.startsWith(`${NIU_API}/v5/scooter/motor_data/index_info`)) {
      if (options.v5 === false) return new Response('', { status: 404 });
      served += 1;
      if (options.expireAfter !== undefined && served === options.expireAfter + 1) {
        issued += 1; // NIU ends the session: the token held is no longer the one it knows.
        return answer(1131);
      }
      return answer(0, STATE);
    }
    if (url.startsWith(`${NIU_API}/v3/motor_data/index_info`)) return answer(0, STATE);
    if (url === `${NIU_API}/motoinfo/overallTally`) return answer(0, { totalMileage: '1234.5', bindDaysCount: 1800 });
    return answer(404);
  };
  return { http, asked };
}

describe('signing in', () => {
  test('with the account and an MD5 of its password, as a form, naming the app', async () => {
    const { http, asked } = niu();
    const tokens = await signIn(http, 'rider@example.test', 'correct horse', 1_000_000);
    expect(tokens).toEqual({ accessToken: 'token-1', refreshToken: 'refresh-1', expiresAt: 1_000_000 + 7_200_000, refreshExpiresAt: 1_000_000 + 2_592_000_000 });
    // The password itself never leaves: only its hash.
    expect(asked[0]!.body).not.toContain('correct');
    expect(new URLSearchParams(asked[0]!.body).get('grant_type')).toBe('password');
  });

  test('a wrong password says so', async () => {
    const { http } = niu();
    await expect(signIn(http, 'rider@example.test', 'wrong')).rejects.toThrow('did not accept that account and password');
  });

  test('the setup action lists the scooters on the account: its serial is sn_id on some models', async () => {
    const { http } = niu();
    const action = protocol.credentials!.actions![0]!;
    const result = await action.run({ http, draft: {}, connection: {}, address: null, secrets: { get: () => null }, sightings: [], log: { debug() {}, info() {}, warn() {}, error() {} } } as never, {
      account: 'rider@example.test',
      password: 'correct horse',
    });
    expect(result.ok).toBe(true);
    expect(result.choices).toEqual([
      expect.objectContaining({ id: 'N0TAREALSERIAL01', label: 'Blixten', name: 'Blixten', address: NIU_API, config: { account: 'rider@example.test', password: 'correct horse', serial: 'N0TAREALSERIAL01' } }),
    ]);
  });

  test('the scooter list takes sn or sn_id, as a list or as items', () => {
    expect(parseScooters([{ sn: 'A1', name: 'One' }])).toEqual([{ serial: 'A1', name: 'One', model: null }]);
    expect(parseScooters({ items: [{ sn_id: 'B2', sku_name: 'Model One' }, { nothing: true }] })).toEqual([{ serial: 'B2', name: null, model: 'Model One' }]);
  });
});

describe('a signed-in client', () => {
  const credentials = { account: 'rider@example.test', password: 'correct horse' };

  test('reads the state, signing in once for several calls', async () => {
    const { http, asked } = niu();
    const client = new NiuClient(http, credentials);
    const state = await client.state('N0TAREALSERIAL01');
    await client.totals('N0TAREALSERIAL01');
    expect(asked.filter((call) => call.url.startsWith(NIU_ACCOUNT))).toHaveLength(1);
    expect(state).toMatchObject({ soc: 74, charging: true, chargerConnected: true, minutesToFull: 90, rangeKm: 38, alarmArmed: true, poweredOn: false, controlUnitBattery: 100 });
    expect(state.at).toBe(new Date(1_790_000_000_000).toISOString());
  });

  test('signed out by NIU midway, it signs in again and asks once more', async () => {
    const { http, asked } = niu({ expireAfter: 1 });
    const client = new NiuClient(http, credentials);
    await client.state('N0TAREALSERIAL01');
    expect((await client.state('N0TAREALSERIAL01')).soc).toBe(74);
    expect(asked.filter((call) => call.url.startsWith(NIU_ACCOUNT))).toHaveLength(2);
  });

  test('renews a token about to run out with its refresh token, not the password', async () => {
    let now = 1_000_000;
    const { http, asked } = niu();
    const client = new NiuClient(http, credentials, () => now);
    await client.state('N0TAREALSERIAL01');
    now += 7_200_000 - 60_000; // a minute before it runs out
    await client.state('N0TAREALSERIAL01');
    const signIns = asked.filter((call) => call.url.startsWith(NIU_ACCOUNT)).map((call) => new URLSearchParams(call.body).get('grant_type'));
    expect(signIns).toEqual(['password', 'refresh_token']);
  });

  test('a scooter the v5 call does not answer is read with the v3 one', async () => {
    const { http } = niu({ v5: false });
    const read = await new NiuClient(http, credentials).stateRaw('N0TAREALSERIAL01');
    expect(read.from).toBe('v3');
  });
});

describe('reading the state', () => {
  test('nothing said is null, never a guess', () => {
    const empty = parseState({});
    expect(Object.values({ ...empty, batteries: null }).every((value) => value === null)).toBe(true);
    expect(empty.batteries).toEqual([]);
  });

  test('two batteries: the mean of those in; one taken out does not count', () => {
    expect(parseState({ batteries: { compartmentA: { isConnected: true, batteryCharging: 80 }, compartmentB: { isConnected: true, batteryCharging: 60 } } }).soc).toBe(70);
    expect(parseState({ batteries: { compartmentA: { isConnected: true, batteryCharging: 80 }, compartmentB: { isConnected: false, batteryCharging: 0 } } }).soc).toBe(80);
  });

  test('time to full only while charging, and not NIU’s "none" value', () => {
    expect(parseState({ isCharging: 0, leftTime: 2 }).minutesToFull).toBeNull();
    expect(parseState({ isCharging: 1, leftTime: 999 }).minutesToFull).toBeNull();
  });

  test('a time is seconds or milliseconds, and none is null', () => {
    expect(timeOf(1_790_000_000)).toBe(timeOf(1_790_000_000_000));
    expect(timeOf(0)).toBeNull();
    expect(timeOf('soon')).toBeNull();
  });

  test('the HTTPS binding reaches the sign-in host beside the API, and nothing is found on a network', () => {
    expect(protocol.bindings.https!.open(NIU_API)).toEqual({ alsoOrigins: [NIU_ACCOUNT] });
    expect(protocol.bindings.https!.recognise({} as never)).toBeNull();
  });
});
