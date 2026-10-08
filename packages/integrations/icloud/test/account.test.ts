import { afterEach, describe, expect, test } from 'bun:test';

import { isPosition, memoryKept, type DeviceSession, type HttpChannel, type OpenConnection, type SetupContext } from '@kraftverk/device-sdk';
import { bridgedConnection, checkDeviceTypeContract, fakeConnection, simulatorContext } from '@kraftverk/device-sdk/testing';

import account, { Family, MOVING_EVERY_MS, STILL_EVERY_MS, WATCHED_EVERY_MS } from '../src/account.ts';
import device from '../src/device.ts';
import protocol, { accountIdentity, stateOf, trustUntil, type FoundDevice } from '../src/protocol/index.ts';
import { APPLE_ID, DEVICE_CODE, DSID, PASSWORD, playedApple } from './apple.ts';

/*
  The account and the devices behind it (docs/PLAN-INTEGRATIONS.md step 18),
  against Apple played with made-up data: the account signs in once and
  lists Find My, the family's included; a device added through it reads
  where it is and how charged, plays a sound, and goes into lost mode; and
  Find My is asked often while someone moves, rarely while nobody does.
*/

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** An HTTPS channel to iCloud, its fetch Apple's played one. */
const channelTo = (fetch: (url: string, init?: RequestInit) => Promise<Response>): HttpChannel => ({
  kind: 'http',
  connected: true,
  onConnectedChange: () => () => {},
  fetch: (path, init) => fetch(new URL(path, 'https://setup.icloud.com').toString(), init),
  close: async () => {},
});

/** An account's connection, signed in once with a code as setup does, its session kept. */
async function signedInAccount(control: { trustDays?: number } = {}) {
  const apple = playedApple();
  Object.assign(apple.control, control);
  const action = protocol.credentials!.actions!.find((each) => each.id === 'signIn')!;
  const setup = {
    connection: { appleId: APPLE_ID },
    secrets: { get: (field: string) => (field === 'password' ? PASSWORD : null) },
    http: (url: string, init?: RequestInit) => apple.fetch(url, init),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    kept: memoryKept(),
  } as unknown as SetupContext;
  const first = await action.run(setup, {});
  const done = await action.run(setup, { ...first.ask!.carry, code: DEVICE_CODE });
  const connection = fakeConnection({ method: 'icloud', protocol: 'icloud-web', transport: 'https', address: 'https://setup.icloud.com', channel: channelTo(apple.fetch), config: { appleId: APPLE_ID }, secrets: { password: PASSWORD, session: done.suggestedConfig!.session as string } });
  return { apple, connection };
}

/** A session opened as a holder opens one, with this connection. */
async function opened(type: typeof account | typeof device, connection: OpenConnection | null): Promise<DeviceSession> {
  const { context, stop } = simulatorContext(type);
  stops.push(stop);
  return connection ? type.createSession({ ...context, connection, simulation: null }) : type.createSimulator(context);
}

const until = async (holds: () => boolean, what: string) => {
  for (let tries = 0; tries < 200 && !holds(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!holds()) throw new Error(`Waited for ${what}`);
};

describe('the types', () => {
  test('the account and a device keep the device-type contract, their simulators included', async () => {
    expect(await checkDeviceTypeContract(account, { settleMs: 300 })).toEqual([]);
    expect(await checkDeviceTypeContract(device, { settleMs: 300 })).toEqual([]);
  }, 30_000);
});

describe('an iCloud account', () => {
  test('is read once at the check: who it is, and who is in its Find My', async () => {
    const { connection } = await signedInAccount();
    expect(await account.identify(connection, { config: {}, log: { info: () => {}, warn: () => {}, error: () => {} }, signal: AbortSignal.timeout(10_000) })).toEqual({
      identity: accountIdentity(DSID),
      model: null,
      summary: 'Signed in: Someone’s iPhone, Alex’s iPhone (Alex), Someone’s MacBook are in its Find My.',
      info: { manufacturer: 'Apple' },
    });
  });

  test('a sign-in whose trust ends within a week says so, once: a person signs in again at leisure', async () => {
    const { connection } = await signedInAccount({ trustDays: 5 });
    const { context, stop, events } = simulatorContext(account);
    stops.push(stop);
    const session = await account.createSession({ ...context, connection, simulation: null });
    await until(() => (session.bridge?.members().length ?? 0) === 3, 'Find My’s devices');
    expect(events.map((event) => event.id)).toEqual(['sign-in-ending']);
  });

  test('a device added through it: where it is and how sure, its charge, whose it is; a sound played; lost mode', async () => {
    const { apple, connection } = await signedInAccount();
    const session = await opened(account, connection);
    await until(() => (session.bridge?.members().length ?? 0) === 3, 'Find My’s devices');
    // Until when Apple trusts its sign-in: said, and read.
    expect(session.health()).toMatchObject({ status: 'connected' });
    expect(session.health().detail).toMatch(/^3 devices in Find My · through iCloud · signed in until \d{1,2} [A-Z][a-z]{2}$/);
    const kept = (connection as unknown as { secrets: { get(field: string): string | null } }).secrets.get('session');
    expect(session.readings().find((reading) => reading.key === 'signedInUntil')?.value).toBe(new Date(trustUntil(stateOf(kept))!).toISOString());
    expect(session.bridge!.members().map((member) => [member.name, member.model])).toEqual([
      ['Someone’s iPhone', 'iPhone 15 Pro'],
      ['Alex’s iPhone', 'iPhone 13'],
      ['Someone’s MacBook', 'MacBook Air'],
    ]);

    const alex = await opened(device, bridgedConnection(session.bridge!, { method: 'account', address: 'device-2' }));
    const reading = (key: string) => alex.readings().find((each) => each.key === key);
    await until(() => reading('position') !== undefined, 'its readings');
    expect(reading('position')).toEqual({ key: 'position', value: { latitude: 59.31, longitude: 18.02, accuracy: 30 }, at: new Date(1_760_000_100_000).toISOString() });
    expect(isPosition(reading('position')!.value)).toBe(true);
    expect(reading('charge')?.value).toBe(42);
    expect(reading('charging')?.value).toBe(true);
    expect(reading('owner')?.value).toBe('Alex');
    // What it is, and when it is looked for next — what its page says.
    expect(reading('kind')?.value).toBe('phone');
    expect(typeof reading('nextLook')?.value).toBe('string');
    expect(reading('lookEvery')?.value).toBe(STILL_EVERY_MS / 1000);
    expect(alex.identity?.()).toEqual({ id: 'icloud-web:device-2', name: 'Alex’s iPhone' });

    expect(await alex.command({ part: 'main', capability: 'identify', command: 'identify', args: {} })).toEqual({ accepted: true });
    expect(apple.asked).toContain('POST p42-fmipweb.icloud.com/fmipservice/client/web/playSound');
    expect(await alex.tools!.lostMode!({ phone: '+46 70 000 00 00', text: 'Found it? Call me' })).toBe(true);
    expect(apple.asked).toContain('POST p42-fmipweb.icloud.com/fmipservice/client/web/lostDevice');
    await alex.close();
  });

  test('when Apple asks for a code again, it waits on a person, and asks Apple nothing more', async () => {
    const { apple, connection } = await signedInAccount();
    apple.control.expireWebauth = true;
    apple.control.distrust = true;
    const session = await opened(account, connection);
    await until(() => session.health().status === 'needs-you', 'it to wait on a person');
    expect(session.health().detail).toBe('Apple asks for a code again: sign in on the account’s page');
  });
});

describe('how often Find My is asked', () => {
  const phone = (latitude: number, battery = 80): FoundDevice => ({ id: 'p', name: 'Phone', model: 'iPhone', rawModel: null, deviceClass: 'iPhone', battery, batteryStatus: 'NotCharging', location: { latitude, longitude: 18, accuracy: 20, at: new Date().toISOString(), old: false }, owner: null, lostModeCapable: true });

  test('rarely while everyone is still; often while someone added moves; half as often again on a low battery', async () => {
    const family = new Family({ devices: async () => [], playSound: async () => {}, lostMode: async () => {} });
    family.took([phone(59.3)]);
    expect(family.interval()).toBe(STILL_EVERY_MS);
    const link = await family.link('p', () => {});
    // 5 m: not moving, whatever its accuracy says.
    family.took([phone(59.30005)]);
    expect(family.interval()).toBe(STILL_EVERY_MS);
    // A kilometre on: moving.
    family.took([phone(59.309)]);
    expect(family.interval()).toBe(MOVING_EVERY_MS);
    family.took([phone(59.318, 20)]);
    expect(family.interval()).toBe(MOVING_EVERY_MS * 2);
    link.close();
  });

  test('a device opened before its account first heard from Find My — a restart — waits for that answer; asks at once are one ask', async () => {
    let asked = 0;
    let answer: (devices: FoundDevice[]) => void = () => {};
    const family = new Family({ devices: () => (asked++, new Promise((resolve) => (answer = resolve))), playSound: async () => {}, lostMode: async () => {} });
    const ticking = family.poll();
    const linking = family.link('p', () => {});
    answer([phone(59.3)]);
    await ticking;
    expect((await linking).device()?.name).toBe('Phone');
    expect(asked).toBe(1);

    // Heard, and not there: gone, said so.
    expect(await family.link('gone', () => {}).catch((error: Error) => error.message)).toBe('That device is no longer in this account’s Find My');
  });

  test('every minute while someone looks at a device, asked at once when its page opens; "Locate now" at most once a minute; the schedule said', async () => {
    let asked = 0;
    const family = new Family({ devices: async () => (asked++, [phone(59.3)]), playSound: async () => {}, lostMode: async () => {} });
    await family.poll(Date.now(), true);
    const link = await family.link('p', () => {});
    expect(link.schedule()).toMatchObject({ everyMs: STILL_EVERY_MS, watched: false });

    // Its page opens: watched, every minute — not asked again at once, the last answer being a moment old.
    link.watch(Date.now() + 30_000);
    expect(link.schedule()).toMatchObject({ everyMs: WATCHED_EVERY_MS, watched: true });
    expect(asked).toBe(1);
    // "Locate now" a moment after an ask: that answer stands.
    await link.locate();
    expect(asked).toBe(1);
    expect(Date.parse(link.schedule().nextAt!) - Date.now()).toBeLessThanOrEqual(WATCHED_EVERY_MS);
  });

  test('a device nobody added moving asks nothing more of anyone’s battery', () => {
    const family = new Family({ devices: async () => [], playSound: async () => {}, lostMode: async () => {} });
    family.took([phone(59.3)]);
    family.took([phone(59.4)]);
    expect(family.interval()).toBe(STILL_EVERY_MS);
  });
});
