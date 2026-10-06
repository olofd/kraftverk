import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { NodeView } from '@kraftverk/api-contract';
import { nodeId, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import { aHome, GUEST, refusal, type TestHome } from './a-home.ts';

/*
  A connection a browser holds for the home (docs/DATA-MODEL.md §4), asked
  of the home as the server's routes ask it for the browser: a way it set up
  itself from what it learnt reading the lamp — never a secret — what its
  session reads and the device says happened, what it keeps and what its
  gateway did. It speaks for its own connections only, and only for its own
  account.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

/** A browser joins the home, from olof's account, reaching the bus itself. */
const browser = (): Promise<NodeView> =>
  t.home.nodes.join({ id: nodeId('n-000000000000aa01'), name: 'Olof’s laptop', platform: 'web', transports: ['bus'], alwaysOn: false, reachable: false, trusted: false });

/** A lamp the browser set up, as it read it. */
const heldSetup = (node: string, identified: { identity: string | null; model: string | null; summary: string } | null, extra: { methodId?: string; connection?: Record<string, string> } = {}) =>
  t.home.setup.startHeld({ nodeId: node, typeId: 'test.lamp', methodId: 'bus', address: 'browser-handle-1', identified, device: { room: 'Desk' }, ...extra });

const reading = (value: boolean, at = new Date().toISOString()) => ({ key: 'on', value, at });
const samples = (device: SavedDeviceId) => t.database.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(device)!.n;

describe('a connection a browser holds', () => {
  test('is saved from what the app learnt, held by it, with no secret in the home', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'test-lamp:DESK', model: 'L1', summary: 'It is on.' }, { connection: { pin: 'never-here' } });
    expect(started).toMatchObject({ heldBy: client.id, checked: { outcome: 'new', identity: 'test-lamp:DESK' } });

    const saved = await t.home.setup.save(started.id, { name: 'Desk lamp' });
    expect(saved.connections).toEqual([expect.objectContaining({ heldBy: { kind: 'node', id: client.id, name: 'Olof’s laptop' }, secrets: [] })]);
    expect(JSON.stringify(saved)).not.toContain('never-here');
    // The home does not hold it, and says who does.
    expect(saved.health.detail).toBe('Held by Olof’s laptop, not by Test machine');
  });

  test('a way only a trusted node holds is refused to an app: an account’s password stays at home', async () => {
    const client = await browser();
    const refused = await refusal(
      t.home.setup.startHeld({ nodeId: client.id, typeId: 'test.forecast', methodId: 'cloud', address: 'forecast-account', identified: { identity: 'forecast:X', model: null, summary: 'x' } })
    );
    expect(refused.kind).toBe('invalid');
    expect(refused.message).toContain('It needs a node trusted with it, such as your server: your account password stays at home');
  });

  test('sends its readings: live ones are the device’s state, queued ones become history', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'test-lamp:DESK', model: 'L1', summary: 'On.' });
    const device = await t.home.setup.save(started.id, { name: 'Desk lamp' });
    const connectionId = device.connections[0]!.id;

    const heard: LiveMessage[] = [];
    const stop = t.hub.bus.subscribe((message) => void heard.push(message));
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(await t.home.held.readings(device.id, { nodeId: client.id, connectionId, readings: [reading(true), reading(false, past)] })).toEqual({ live: 1, history: 1, refused: 0 });
    // Said on the live stream as a device the home holds says it; back after being away, every list reads it again.
    expect(heard.map((message) => message.kind)).toEqual(['readings', 'changed']);
    expect(heard[0]).toMatchObject({ deviceId: device.id, readings: [{ key: 'on', value: true }] });
    // Its readings after that are readings, and nothing else: no app reads its whole list for them.
    heard.length = 0;
    await t.home.held.readings(device.id, { nodeId: client.id, connectionId, readings: [reading(true)] });
    expect(heard.map((message) => message.kind)).toEqual(['readings']);
    stop();

    const view = await t.home.devices.get(device.id);
    expect(view.readings).toEqual([expect.objectContaining({ key: 'on', value: true })]);
    expect(view.health).toMatchObject({ status: 'connected', detail: 'Connected through Olof’s laptop', node: client.id });
    expect(view.connections[0]!.inUse).toBe(true);
    expect(samples(device.id)).toBe(1);
  });

  test('a node whose clock is off: what it read is moved onto the home’s clock, not refused for being in the future', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'test-lamp:DESK', model: 'L1', summary: 'On.' });
    const device = await t.home.setup.save(started.id, { name: 'Desk lamp' });
    const connectionId = device.connections[0]!.id;
    // A phone five minutes fast: it read the lamp just now, by its own clock.
    const fast = new Date(Date.now() + 5 * 60_000).toISOString();
    const taken = await t.home.held.readings(device.id, { nodeId: client.id, connectionId, readings: [reading(true, fast)], sentAt: fast });
    expect(taken).toEqual({ live: 1, history: 0, refused: 0 });
    const on = (await t.home.devices.get(device.id)).readings.find((each) => each.key === 'on')!;
    expect(Math.abs(Date.parse(on.at) - Date.now())).toBeLessThan(5_000);
  });

  test('sends what the device said happened: kept as the home’s own are, at the level its description declares, and a problem across devices', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'test-lamp:HALL', model: 'L1', summary: 'On.' });
    const device = await t.home.setup.save(started.id, { name: 'Hall lamp' });
    const at = new Date().toISOString();

    await t.home.held.readings(device.id, {
      nodeId: client.id,
      connectionId: device.connections[0]!.id,
      readings: [],
      events: [
        // Its level is its description's word, not the app's.
        { id: 'bulb.failed', part: null, data: null, at },
        { id: 'made.up', part: null, data: null, at },
      ],
    });
    expect(await t.home.devices.events(device.id)).toEqual([expect.objectContaining({ event: 'bulb.failed', level: 'error', part: 'main', deviceId: device.id })]);
    expect(await t.home.problems()).toContainEqual(expect.objectContaining({ event: 'bulb.failed', deviceName: 'Hall lamp' }));
  });

  test('a device saved before it answered learns who it is from the app, and a different device adds nothing', async () => {
    const client = await browser();
    // A browser cannot always read an identity during setup: saved without one.
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' });
    const device = await t.home.setup.save(started.id, { name: 'Desk lamp' });
    const connectionId = device.connections[0]!.id;
    const identity = () => t.database.query<{ identity: string | null }, [string]>('SELECT identity FROM device WHERE id = ?').get(device.id)!.identity;
    const send = (said: string) => t.home.held.readings(device.id, { nodeId: client.id, connectionId, identity: said, readings: [reading(true)] });
    expect(identity()).toBeNull();

    await send('test-lamp:DESK');
    expect(identity()).toBe('test-lamp:DESK');

    expect((await refusal(send('test-lamp:ELSEWHERE'))).kind).toBe('conflict');
    expect(identity()).toBe('test-lamp:DESK');
  });

  test('speaks only for its own connections, and only for its own account', async () => {
    const client = await browser();
    t.lampAt('lamp-1');
    const homeHeld = await t.added('Hall lamp');
    const connectionId = homeHeld.connections[0]!.id;

    // A connection this home holds is not the app's to report on.
    expect((await refusal(t.home.held.readings(homeHeld.id, { nodeId: client.id, connectionId, readings: [reading(true)] }))).kind).toBe('forbidden');

    const other = t.as(GUEST).setup.startHeld({ nodeId: client.id, typeId: 'test.lamp', methodId: 'bus', address: 'x', identified: null });
    expect((await refusal(other)).kind).toBe('not-found');
  });

  test('a browser that cannot tell which lamp it reached attaches on the person’s word', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const client = await browser();
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' }, { methodId: 'backup' });
    expect(started.checked).toMatchObject({ outcome: 'new', identity: null });
    const attached = await t.home.setup.save(started.id, { name: '', mode: 'attach', deviceId: lamp.id });
    expect(attached.connections.map((connection) => connection.heldBy.kind)).toEqual(['master', 'node']);
  });

  test('the reachable connection highest in the list is in use: the app takes over while the home cannot reach it, and gives it back', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const client = await browser();
    const started = await heldSetup(client.id, { identity: null, model: 'L1', summary: 'On.' }, { methodId: 'backup' });
    const attached = await t.home.setup.save(started.id, { name: '', mode: 'attach', deviceId: lamp.id });
    const [homeSide, appSide] = attached.connections;
    const view = () => t.home.devices.get(lamp.id);
    const fromApp = () => t.home.held.readings(lamp.id, { nodeId: client.id, connectionId: appSide!.id, readings: [reading(false)] });
    const inUse = async () => (await view()).connections.find((connection) => connection.inUse)?.id;

    // Both reach it: the home's is higher in the list, so it is the one in use.
    await fromApp();
    expect(await inUse()).toBe(homeSide!.id);
    expect((await view()).connections.map((connection) => connection.reachable)).toEqual([true, true]);

    // The home loses it: the app's connection takes over, and its readings are the device's.
    const channel = t.bus.channels.at(-1)!;
    channel.setConnected(false);
    await fromApp();
    expect(await inUse()).toBe(appSide!.id);
    expect((await view()).readings).toEqual([expect.objectContaining({ key: 'on', value: false })]);

    // It comes back: the home's connection is in use again.
    channel.setConnected(true);
    expect(await inUse()).toBe(homeSide!.id);
  });

  test('keeps the device’s store in the home, and its audit entries under the account', async () => {
    const client = await browser();
    const started = await heldSetup(client.id, { identity: 'test-lamp:DESK', model: 'L1', summary: 'On.' });
    const device = await t.home.setup.save(started.id, { name: 'Desk lamp' });
    const connectionId = device.connections[0]!.id;

    await t.home.held.keep(device.id, 'brightness', { nodeId: client.id, connectionId, value: 80 });
    expect(await t.home.held.store(device.id)).toEqual({ brightness: 80 });

    expect(await t.home.held.audit(client.id, [{ at: new Date().toISOString(), kind: 'command.verified', resourceKind: 'device', resource: device.id, summary: 'Desk lamp: switched off' }])).toEqual({ recorded: 1 });
    const entry = (await t.home.timeline()).find((each) => each.kind === 'command.verified');
    expect(entry).toMatchObject({ actor: 'olof', resourceKind: 'device', resource: device.id, detail: { from: { name: 'Olof’s laptop' } } });

    // The timeline, asked for one device's.
    const its = await t.home.timeline({ resourceKind: 'device', resource: device.id });
    expect(its.length).toBeGreaterThan(0);
    expect(its.every((line) => line.resource === device.id)).toBe(true);
    expect(await t.home.timeline({ resourceKind: 'automation' })).toEqual([]);
  });
});
