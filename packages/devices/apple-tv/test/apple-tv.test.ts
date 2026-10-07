import { describe, expect, test } from 'bun:test';

import { needsSignIn, type DeviceContext, type DeviceSession } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, fakeConnection } from '@kraftverk/device-sdk/testing';
import protocol, { CompanionLink, PairSetup, writeCredentials } from '@kraftverk/integration-apple-media/protocol';
import { PIN, playedAppleTv, TV_ID } from '@kraftverk/integration-apple-media/testing';

import appleTv from '../src/type.ts';

/*
  An Apple TV, against one played: paired as setup pairs it, its session's
  readings as it tells them, every command over Companion, a connection
  dropped and verified again, and a pairing the TV no longer keeps.
*/

const quiet = { config: {}, log: { info: () => {}, warn: () => {}, error: () => {} }, signal: AbortSignal.timeout(5_000) };

async function until(check: () => boolean, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Waited for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Paired with it, as setup's action pairs: what is kept as the connection's secret. */
async function pairedWith(tv: ReturnType<typeof playedAppleTv>): Promise<string> {
  const link = new CompanionLink(tv.connect());
  const setup = new PairSetup();
  const credentials = await link.finishPairing(setup, await link.startPairing(setup), PIN, 'kraftverk');
  await link.close();
  return writeCredentials(credentials);
}

const connectionTo = (tv: ReturnType<typeof playedAppleTv>, credentials: string | null) =>
  fakeConnection({ method: 'companion', protocol: protocol.id, transport: 'lan', address: '192.0.2.70', channel: tv.connect(), secrets: credentials ? { credentials } : {} });

function contextFor(connection: ReturnType<typeof connectionTo>) {
  const timers: ReturnType<typeof setInterval>[] = [];
  let changed = 0;
  const ctx = {
    deviceId: 'd-tv' as never,
    config: {},
    connection,
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
  return { ctx, changed: () => changed, stop: () => timers.forEach(clearInterval) };
}

test('keeps the device-type contract', async () => {
  expect(await checkDeviceTypeContract(appleTv)).toEqual([]);
});

describe('an Apple TV', () => {
  test('read once at setup: verified with what pairing left, known by its pairing id', async () => {
    const tv = playedAppleTv();
    const credentials = await pairedWith(tv);
    expect(await appleTv.identify(connectionTo(tv, credentials), quiet)).toEqual({
      identity: `apple-media:${TV_ID.toLowerCase()}`,
      model: null,
      summary: 'An Apple TV, paired and answering: awake.',
    });
  });

  test('not paired, or no longer: a person is asked to pair it again', async () => {
    const tv = playedAppleTv();
    const unpaired = await appleTv.identify(connectionTo(tv, null), quiet).catch((error: Error) => error);
    expect(needsSignIn(unpaired)).toBe(true);
    // Paired with another TV: this one does not keep it.
    const forgotten = await appleTv.identify(connectionTo(tv, await pairedWith(playedAppleTv())), quiet).catch((error: Error) => error);
    expect(needsSignIn(forgotten)).toBe(true);
    expect((forgotten as Error).message).toBe('The TV’s signature does not hold: pair it again');
  });

  test('its session: what it tells as it changes, and every command over Companion', async () => {
    const tv = playedAppleTv();
    const { ctx, stop, changed } = contextFor(connectionTo(tv, await pairedWith(tv)));
    const session: DeviceSession = await appleTv.createSession(ctx);
    const reading = (key: string) => session.readings().find((each) => each.key === key)?.value;
    await until(() => reading('on') === true && reading('playing') === true && reading('volume') === 30, 'what it says once verified');
    expect(reading('screen')).toBe('awake');
    expect(session.health().status).toBe('connected');
    expect(session.identity?.()).toEqual({ id: `apple-media:${TV_ID.toLowerCase()}`, name: null });

    const main = (capability: string, command: string, args: Record<string, string | number | boolean> = {}) => session.command({ part: 'main', capability, command, args });
    // Paused: what the gateway reads back, as the TV tells it.
    expect(await main('mediaPlayback', 'set', { playing: false })).toEqual({ accepted: true });
    expect(tv.state.playing).toBe(false);
    await until(() => reading('playing') === false, 'it told it paused');

    expect(await main('volume', 'set', { level: 55 })).toEqual({ accepted: true });
    expect(tv.state.volume).toBeCloseTo(0.55);
    expect(await main('keypadInput', 'press', { key: 'back' })).toEqual({ accepted: true });
    expect(tv.asked.filter((each) => each.id === '_hidC').map((each) => each.content._hidC)).toEqual([5, 5]);
    expect(await main('applicationLauncher', 'launch', { app: 'com.example.Films' })).toEqual({ accepted: true });
    expect(await session.query?.({ part: 'main', capability: 'applicationLauncher', query: 'apps', args: {} })).toEqual([
      { id: 'com.example.Films', name: 'Films' },
      { id: 'com.apple.TVWatchList', name: 'TV' },
    ]);

    // Off is asleep: nothing plays.
    expect(await main('switch', 'set', { on: false })).toEqual({ accepted: true });
    await until(() => reading('on') === false, 'it told it sleeps');
    expect(reading('screen')).toBe('asleep');

    expect(await main('keypadInput', 'press', { key: 'eject' })).toMatchObject({ accepted: false });
    expect(await main('lock', 'set', { locked: true })).toEqual({ accepted: false, error: 'An Apple TV takes no lock.set' });

    // The connection drops, and is made again: verified afresh, and asked what it is.
    const channel = tv.connections.at(-1)!;
    channel.setConnected(false);
    expect(session.health().status).toBe('offline');
    channel.setConnected(true);
    await until(() => session.health().status === 'connected', 'verified again');
    expect(tv.asked.filter((each) => each.id === '_sessionStart')).toHaveLength(2);

    stop();
    await session.close();
    expect(tv.asked.map((each) => each.id)).toContain('_sessionStop');
    expect(changed()).toBeGreaterThan(0);
  });

  test('a session whose pairing the TV does not keep waits on a person', async () => {
    const tv = playedAppleTv();
    const { ctx, stop } = contextFor(connectionTo(tv, await pairedWith(playedAppleTv())));
    const session = await appleTv.createSession(ctx);
    await until(() => session.health().status === 'needs-you', 'it was refused');
    expect(session.health().detail).toBe('The TV’s signature does not hold: pair it again');
    expect(await session.command({ part: 'main', capability: 'mediaPlayback', command: 'set', args: { playing: false } })).toEqual({
      accepted: false,
      error: 'The TV’s signature does not hold: pair it again',
    });
    stop();
    await session.close();
  });
});
