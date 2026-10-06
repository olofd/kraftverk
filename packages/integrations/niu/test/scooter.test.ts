import { describe, expect, test } from 'bun:test';

import { isCurrent, type HttpChannel } from '@kraftverk/device-sdk';
import { bridgedConnection, checkDeviceTypeContract, fakeConnection, simulatorContext } from '@kraftverk/device-sdk/testing';
import { md5Hex, NIU_ACCOUNT, NIU_API, parseState } from '../src/protocol/index.ts';

import account from '../src/account.ts';
import scooter, { chargingEventOf, confirmedSince, isParked, readingsOf, withoutPlace } from '../src/scooter.ts';

/**
 * The NIU scooter keeps the device-type contract, and reads what NIU's cloud
 * says the way README.md records it. Every serial and account here is made up.
 */

const STATE = {
  isCharging: 1,
  isConnected: true,
  leftTime: 1.5,
  estimatedMileage: 38,
  nowSpeed: 0,
  isAccOn: 0,
  isFortificationOn: 1,
  lockStatus: 0,
  gsm: 4,
  gps: 3,
  centreCtrlBattery: 100,
  infoTimestamp: 1_790_000_000_000,
  postion: { lat: 59.3, lng: 18.0 },
  batteries: { compartmentA: { isConnected: true, batteryCharging: 74 } },
};

/** NIU's two hosts, answering one made-up account with one made-up scooter. */
function niu(): HttpChannel & { asked: string[] } {
  const asked: string[] = [];
  const answer = (data: unknown) => new Response(JSON.stringify({ status: 0, data }));
  return {
    kind: 'http',
    asked,
    connected: true,
    onConnectedChange: () => () => undefined,
    fetch: async (url, init) => {
      asked.push(url);
      if (url === `${NIU_ACCOUNT}/v3/api/oauth2/token`) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('password') !== md5Hex('correct horse')) return new Response(JSON.stringify({ status: 2003, desc: 'wrong' }));
        return answer({ token: { access_token: 't', refresh_token: 'r', token_expires_in: 7200 } });
      }
      if (url === `${NIU_API}/v5/scooter/list`) return answer({ items: [{ sn_id: 'N0TAREALSERIAL01', scooter_name: 'Blixten', sku_name: 'UQi GT Sport' }] });
      if (url.includes('/motor_data/index_info')) return answer(STATE);
      if (url.includes('/motor_data/battery_info')) return answer({ batteries: { compartmentA: { batteryCharging: 74, temperature: 19, gradeBattery: '96', chargedTimes: 212 } } });
      if (url.endsWith('/motoinfo/overallTally')) return answer({ totalMileage: 4180.4, bindDaysCount: 1800 });
      return new Response('', { status: 404 });
    },
    close: async () => undefined,
  };
}

/** The account's connection, to the fake cloud. */
const over = (channel = niu(), password = 'correct horse') =>
  fakeConnection({
    method: 'cloud',
    protocol: 'niu-cloud',
    transport: 'https',
    address: NIU_API,
    channel,
    config: { account: 'rider@example.test' },
    secrets: { password },
  });

/** The account opened over the fake cloud, as its holder opens it — and the scooter's connection through it. */
async function throughTheAccount() {
  const { context, stop } = simulatorContext(account);
  const session = await account.createSession({ ...context, connection: over() });
  // Its first look round: signed in, and the list read.
  for (let tries = 0; tries < 100 && !session.bridge!.members().length; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  const connection = bridgedConnection(session.bridge!, { method: 'account', address: 'N0TAREALSERIAL01' });
  return { session, connection, stop };
}

describe('NIU scooter', () => {
  test('keeps the device-type contract, as hardware under Vehicles, reached through its NIU account', async () => {
    expect(await checkDeviceTypeContract(scooter)).toEqual([]);
    expect(scooter.meta.category).toBe('vehicle');
    expect(scooter.connections.map((method) => [method.protocol, method.transport, method.reach, method.through])).toEqual([[undefined, undefined, 'cloud', ['niu.account']]]);
  });

  test('its charge is the scooter’s headline, and what "Charge between two levels" charges', () => {
    const description = scooter.describe({});
    const soc = description.attributes.find((attribute) => attribute.means === 'charge');
    expect([soc?.part ?? 'main', soc?.category]).toEqual(['main', 'primary']);
  });

  test('checked once, through its account: which scooter, its model and how it is', async () => {
    const { session, connection, stop } = await throughTheAccount();
    try {
      const identified = await scooter.identify(connection, { config: {}, log: console as never, signal: AbortSignal.timeout(5_000) });
      expect(identified).toMatchObject({ identity: 'niu-cloud:N0TAREALSERIAL01', model: 'UQi GT Sport', name: 'Blixten', info: { manufacturer: 'NIU', serial: 'N0TAREALSERIAL01' } });
      expect(identified.summary).toContain('74 % charged, charging, 38 km of range');
    } finally {
      stop();
      await session.close();
    }
  });

  test('opened through its account, it reads what the account is told — dated when the scooter reported it', async () => {
    const { session, connection, stop } = await throughTheAccount();
    const { context, stop: stopScooter } = simulatorContext(scooter);
    try {
      const opened = await scooter.createSession({ ...context, connection });
      for (let tries = 0; tries < 100 && !opened.readings().length; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(opened.readings().find((reading) => reading.key === 'soc')).toMatchObject({ value: 74, at: new Date(1_790_000_000_000).toISOString() });
      expect(opened.identity?.()).toEqual({ id: 'niu-cloud:N0TAREALSERIAL01', name: 'Blixten' });
      // Its raw tool asks the account, which asks NIU — and never says where it is.
      const raw = (await opened.tools!.raw!({})) as { state: string };
      expect(raw.state).toContain('estimatedMileage');
      expect(raw.state).not.toContain('postion');
      await opened.close();
    } finally {
      stopScooter();
      stop();
      await session.close();
    }
  });

  test('its readings carry the time the scooter reported, not when it was asked', () => {
    const state = parseState(STATE);
    const readings = readingsOf(state, [], null, state.at!, null);
    expect(readings.find((reading) => reading.key === 'soc')).toEqual({ key: 'soc', value: 74, at: new Date(1_790_000_000_000).toISOString() });
    // Its totals and battery health only once read.
    expect(readings.some((reading) => reading.key === 'odometer')).toBe(false);
  });

  test('parked, its last report stands for as long as NIU answers — still dated when the scooter made it; charging or switched on, it is as old as it is', () => {
    const reported = '2026-09-30T10:00:00.000Z';
    const answered = '2026-09-30T14:00:00.000Z';
    const parked = parseState({ ...STATE, isCharging: 0, isAccOn: 0 });
    expect(isParked(parked)).toBe(true);
    expect(confirmedSince(parked, reported, answered)).toBe(answered);
    expect(confirmedSince(parseState({ ...STATE, isCharging: 1 }), reported, answered)).toBeNull();
    expect(confirmedSince(parseState({ ...STATE, isCharging: 0, isAccOn: 1 }), reported, answered)).toBeNull();
    // Its reading keeps the time the scooter reported; it is current from when NIU last confirmed it.
    const soc = readingsOf(parked, [], null, reported, null, answered).find((reading) => reading.key === 'soc')!;
    expect(soc).toEqual({ key: 'soc', value: parked.soc, at: reported, confirmedAt: answered });
    const attribute = scooter.describe({} as never).attributes.find((candidate) => candidate.key === 'soc')!;
    expect(isCurrent(attribute, soc, Date.parse(answered) + 60_000)).toBe(true);
    expect(isCurrent(attribute, { ...soc, confirmedAt: undefined }, Date.parse(answered) + 60_000)).toBe(false);
    // NIU's isConnected is not a charger: it says nothing of whether it is parked.
    expect(isParked(parseState({ ...STATE, isCharging: 0, isAccOn: 0, isConnected: true }))).toBe(true);
  });

  test('charging started or stopped is an event, not on the first report', () => {
    const charging = parseState(STATE);
    const idle = parseState({ ...STATE, isCharging: 0 });
    expect(chargingEventOf(null, charging)).toBeNull();
    expect(chargingEventOf(idle, charging)).toEqual({ id: 'charging.started', soc: 74 });
    expect(chargingEventOf(charging, idle)).toEqual({ id: 'charging.finished', soc: 74 });
  });

  test('where it is is left out, the raw tool too', () => {
    expect(withoutPlace(STATE)).not.toHaveProperty('postion');
    expect(JSON.stringify(withoutPlace({ a: [{ lat: 1, lng: 2, soc: 3 }] }))).toBe('{"a":[{"soc":3}]}');
  });
});
