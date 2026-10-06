import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { savedDeviceId } from '@kraftverk/device-sdk';
import { plainSecrets } from '@kraftverk/store';

import { lampType, MACHINE_NODE } from '../src/testing.ts';
import { aHome, GUEST, refusal, type TestHome } from './a-home.ts';

/*
  What can be added, and adding it (docs/DATA-MODEL.md §1), asked of the
  home: a lamp on a pretend bus — found, checked, told apart by who it says
  it is, its address claimed — and a station added the simulated way, with
  no hardware at all.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

describe('what can be added', () => {
  test('every installed type, by category, with how it can be reached and whether this home can', async () => {
    const listing = await t.home.deviceTypes();
    expect(Object.keys(listing.categories)).toEqual(['power-station', 'smart-plug', 'weather', 'energy-price', 'vehicle', 'account', 'gateway']);
    const station = listing.types.find((type) => type.id === 'test.station')!;
    expect(station.meta.category).toBe('power-station');
    // Its own ways, and simulated — which every type has, and a home can always hold.
    expect(station.connections.map((method) => method.id)).toEqual(['bus', 'simulated']);
    expect(station.ways).toContainEqual({ method: 'simulated', holder: 'master', fits: true, availability: { ok: true } });
    // A way that needs a node trusted with a password: this home's master is one.
    const forecast = listing.types.find((type) => type.id === 'test.forecast')!;
    expect(forecast.ways).toContainEqual(expect.objectContaining({ method: 'cloud', holder: 'master', fits: true }));
    for (const id of ['test.lamp', 'test.plug']) expect(listing.types.map((type) => type.id)).toContain(id);
    // Declarations only: every function stays in the home.
    expect(JSON.stringify(listing)).not.toContain('=>');
    expect(listing.refused).toEqual({ types: [], protocols: [], transports: [] });
  });

  test('a method whose transport this home can use says so; one it cannot use says why', async () => {
    const lamp = async () => (await t.home.deviceTypes()).types.find((type) => type.id === 'test.lamp')!;
    expect((await lamp()).ways).toContainEqual({ method: 'bus', holder: 'master', fits: true, availability: { ok: true } });
    t.bus.unavailable = 'There is no bus in this container';
    expect((await lamp()).ways).toContainEqual({ method: 'bus', holder: 'master', fits: true, availability: { ok: false, reason: 'There is no bus in this container' } });
  });
});

describe('a way set up again', () => {
  test('its credentials given anew, checked as the same device, and saved over that way — nothing added', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const [way] = (await t.home.devices.get(lamp.id)).connections;
    const again = await t.home.setup.again({ deviceId: lamp.id, connectionId: way!.id });
    expect(again.again).toEqual({ deviceId: lamp.id, connectionId: way!.id, name: 'Hall lamp' });
    // Never found again, nor what the lamp itself is: its credentials, then the check.
    expect(again.plan.map((step) => step.kind)).toEqual(['form', 'check']);
    expect(again.address).toBe('lamp-1');

    await t.home.setup.update(again.id, { connection: { pin: 'a-new-pin' } });
    expect(await t.home.setup.check(again.id)).toMatchObject({ outcome: 'yours', device: { id: lamp.id } });
    const saved = await t.home.setup.save(again.id, { name: 'ignored' });
    expect(saved.id).toBe(lamp.id);
    expect((await t.home.devices.list()).filter((device) => device.typeId === 'test.lamp')).toHaveLength(1);
    expect(t.hub.connections.secretFields(way!.id)).toEqual(['pin']);
    expect((await t.home.timeline()).find((entry) => entry.kind === 'device.secrets-changed')?.summary).toBe('Set up Test bus again for "Hall lamp": pin given anew');
  });

  test('a device that answers as another is not saved over this one', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const [way] = (await t.home.devices.get(lamp.id)).connections;
    const again = await t.home.setup.again({ deviceId: lamp.id, connectionId: way!.id });
    t.lampAt('lamp-1', { serial: 'LAMP-9' });
    expect(await t.home.setup.check(again.id)).toMatchObject({ outcome: 'no-answer', saveAnyway: null, summary: 'That answered as another device, not Hall lamp: nothing is changed.' });
    expect((await refusal(t.home.setup.save(again.id, { name: 'x' }))).kind).toBe('conflict');
  });

  test('an action may ask one more thing: what it carries to its next turn never reaches the app', async () => {
    t.lampAt('lamp-1');
    const started = await t.home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
    const credentials = started.plan.find((step) => step.id === 'credentials')!;
    const first = await t.home.setup.action(started.id, credentials.id, 'twoStep', {});
    expect(first).toEqual({ ok: true, detail: 'A code was sent to your phone', ask: { schema: { fields: { code: { type: 'string', title: 'The code', required: true } } } } });
    expect(JSON.stringify(first)).not.toContain('half-a-sign-in');
    const second = await t.home.setup.action(started.id, credentials.id, 'twoStep', { code: '123456' });
    expect(second).toMatchObject({ ok: true, detail: 'Signed in' });
    // Carried once: asked again, the first turn has to begin again.
    expect(await t.home.setup.action(started.id, credentials.id, 'twoStep', { code: '123456' })).toMatchObject({ ok: false, detail: 'What the first turn began was not carried' });
  });
});

describe('adding a device', () => {
  test('simulated: a station is added with no hardware, by its own steps only, and opened as its simulator', async () => {
    const started = await t.home.setup.start({ typeId: 'test.station', methodId: 'simulated' });
    // No protocol and no transport: nothing to prepare, nothing to choose.
    expect(started.plan.map((step) => step.kind)).toEqual(['check']);
    expect((await t.home.setup.check(started.id)).outcome).toBe('new');

    const saved = await t.home.setup.save(started.id, { name: 'Garage station' });
    expect(saved).toMatchObject({ name: 'Garage station', typeId: 'test.station', connections: [expect.objectContaining({ method: 'simulated', transport: 'sim' })] });
    expect(t.hub.sessions.get(savedDeviceId(saved.id))).not.toBeNull();
    expect((await t.home.devices.get(saved.id)).connections[0]).toMatchObject({ methodLabel: 'Simulated', reachable: true, inUse: true });

    // The draft is gone, and the timeline says who added what.
    expect((await refusal(t.home.setup.get(started.id))).kind).toBe('not-found');
    expect((await t.home.timeline()).find((entry) => entry.kind === 'device.added')?.actor).toBe('olof');
  });

  test('a lamp found on the bus is checked, told apart by its identity, and saved with what the check learnt', async () => {
    t.lampAt('lamp-1');
    const started = await t.home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
    // The transport's values fill the instructions: where to connect it.
    expect(started.plan[0]).toMatchObject({ kind: 'instructions', body: 'Connect it to bus.test.' });
    expect(await t.home.setup.sightings(started.id)).toEqual([expect.objectContaining({ address: 'lamp-1', name: 'Lamp lamp-1', claimedBy: null })]);

    const lamp = await t.added('Hall lamp');
    expect(lamp.identity).toBe('test-lamp:LAMP-1');
    const view = await t.home.devices.get(lamp.id);
    expect(view.config).toEqual({ room: 'Hall' });
    expect(view.connections[0]).toMatchObject({ method: 'bus', address: 'lamp-1', heldBy: { kind: 'master', id: MACHINE_NODE.id, name: MACHINE_NODE.name } });
  });

  test('the same lamp again is yours: its address is marked, and it is not added twice', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const { id, check } = await t.checked();
    expect(check).toMatchObject({ outcome: 'yours', device: { id: lamp.id, name: 'Hall lamp' } });
    expect((await t.home.setup.sightings(id))[0]!.claimedBy).toEqual({ id: lamp.id, name: 'Hall lamp' });
    expect((await refusal(t.home.setup.save(id, { name: 'Again' }))).kind).toBe('conflict');
  });

  test('a removed lamp is offered back, with its history', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    t.database.query("INSERT INTO sample (device_id, part, key, at, value) VALUES (?, 'main', ?, ?, ?)").run(lamp.id, 'on', new Date().toISOString(), 1);
    await t.home.devices.remove(lamp.id);

    const { id, check } = await t.checked();
    expect(check).toMatchObject({ outcome: 'removed', identity: 'test-lamp:LAMP-1', devices: [expect.objectContaining({ id: lamp.id, name: 'Hall lamp' })] });
    const back = await t.home.setup.save(id, { name: 'Hall lamp', mode: 'restore', deviceId: lamp.id });
    expect(back.id).toBe(lamp.id);
    expect(back.removedAt).toBeNull();
    expect(t.database.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM sample WHERE device_id = ?').get(lamp.id)!.n).toBe(1);
  });

  test('another way to reach a device must reach that device', async () => {
    t.lampAt('lamp-1');
    t.lampAt('lamp-1b', { serial: 'LAMP-1' });
    t.lampAt('lamp-2');
    const lamp = await t.added('Hall lamp');

    const other = await t.checked({ methodId: 'backup', address: 'lamp-2' });
    expect(other.check.outcome).toBe('new');
    const refused = await refusal(t.home.setup.save(other.id, { name: '', mode: 'attach', deviceId: lamp.id }));
    expect(refused.kind).toBe('conflict');
    expect(refused.message).toContain('different device');

    const same = await t.checked({ methodId: 'backup', address: 'lamp-1b' });
    expect(same.check.outcome).toBe('yours');
    const attached = await t.home.setup.save(same.id, { name: '', mode: 'attach', deviceId: lamp.id });
    expect(attached.connections.map((connection) => connection.method)).toEqual(['bus', 'backup']);
  });

  test('a model this type does not cover cannot be saved as it', async () => {
    t.lampAt('lamp-1', { model: 'X9' });
    const { id, check } = await t.checked();
    expect(check).toMatchObject({ outcome: 'other-model', model: 'X9', type: null });
    expect((await refusal(t.home.setup.save(id, { name: 'Odd' }))).kind).toBe('conflict');
  });

  test('a lamp that does not answer is saved only when asked to, and without an identity', async () => {
    t.lampAt('lamp-1', { answers: false });
    const { id, check } = await t.checked();
    expect(check).toMatchObject({ outcome: 'no-answer', saveAnyway: lampType.setup!.saveAnyway });
    expect((await refusal(t.home.setup.save(id, { name: 'Dark' }))).kind).toBe('conflict');
    const saved = await t.home.setup.save(id, { name: 'Dark', anyway: true });
    expect(saved.identity).toBeNull();
    expect((await t.home.timeline()).some((entry) => entry.kind === 'device.saved-unchecked')).toBe(true);
  });

  test('an address typed by hand is normalised by the protocol, or refused', async () => {
    const started = await t.home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
    expect((await refusal(t.home.setup.choose(started.id, { manual: 'Lamp 5!' }))).kind).toBe('invalid');
    expect((await t.home.setup.choose(started.id, { manual: '  lamp-5 ' })).address).toBe('lamp-5');
  });

  test('a secret a step finds never reaches whoever asked, is stored sealed, and a placeholder is only good for its draft', async () => {
    t.lampAt('lamp-1');
    const started = await t.home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
    const found = await t.home.setup.action(started.id, 'credentials', 'fetch', {});
    expect(JSON.stringify(found)).not.toContain('the-real-secret-value');
    const pin = found.choices![0]!.config.pin as string;
    expect(pin).toStartWith('held:');

    expect((await refusal(t.home.setup.update(started.id, { connection: { pin: 'held:0000000000000000' } }))).kind).toBe('invalid');
    const updated = await t.home.setup.update(started.id, { connection: { pin } });
    expect(updated.secrets).toEqual(['pin']);
    expect(JSON.stringify(updated)).not.toContain('the-real-secret-value');

    await t.home.setup.choose(started.id, { address: 'lamp-1' });
    await t.home.setup.check(started.id);
    const saved = await t.home.setup.save(started.id, { name: 'Keyed' });
    expect(saved.connections[0]!.secrets).toEqual(['pin']);
    expect(JSON.stringify(saved)).not.toContain('the-real-secret-value');
    const row = t.database.query<{ value: string; encrypted: number }, [string]>('SELECT value, encrypted FROM connection_secret WHERE connection_id = ?').get(saved.connections[0]!.id)!;
    expect(plainSecrets.open(row.value, row.encrypted === 1)).toBe('the-real-secret-value');
  });

  test('a draft is only its own account’s, and nothing unknown is set up', async () => {
    const started = await t.home.setup.start({ typeId: 'test.lamp', methodId: 'bus' });
    expect((await refusal(t.as(GUEST).setup.get(started.id))).kind).toBe('not-found');

    expect((await refusal(t.home.setup.start({ typeId: 'nobody.knows' }))).kind).toBe('not-found');
    expect((await refusal(t.home.setup.start({ typeId: 'test.lamp', methodId: 'carrier-pigeon' }))).kind).toBe('invalid');
    // Saving before the check says what is missing.
    expect((await refusal(t.home.setup.save(started.id, { name: 'x' }))).kind).toBe('invalid');
  });
});
