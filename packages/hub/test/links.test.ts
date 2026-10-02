import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { aHome, refusal, settle, type TestHome } from './a-home.ts';

/*
  How a device is reached, and how devices fit the house (docs/DATA-MODEL.md
  §3), asked of the home: a lamp's ways on the pretend bus, and the links
  between a plug and a station's mains, and between two stations — joining
  parts, not devices.
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

const end = (device: { id: string }, part: string) => ({ device: device.id, part });

describe('connections', () => {
  test('the last way to reach a device cannot be removed; another can, and can be preferred', async () => {
    t.lampAt('lamp-1');
    t.lampAt('lamp-1b', { serial: 'LAMP-1' });
    const lamp = await t.added('Hall lamp');
    const only = (await t.home.devices.get(lamp.id)).connections[0]!.id;
    expect((await refusal(t.home.connections.remove(lamp.id, only))).kind).toBe('conflict');

    const second = await t.checked({ methodId: 'backup', address: 'lamp-1b' });
    await t.home.setup.save(second.id, { name: '', mode: 'attach', deviceId: lamp.id });
    const backup = (await t.home.devices.get(lamp.id)).connections[1]!.id;
    const preferred = await t.home.connections.prefer(lamp.id, backup);
    expect(preferred.connections[0]).toMatchObject({ id: backup, inUse: true });
    expect((await t.home.connections.remove(lamp.id, only)).connections.map((connection) => connection.id)).toEqual([backup]);
  });

  test('secrets are replaced write-only, and only fields that are secrets', async () => {
    t.lampAt('lamp-1');
    const lamp = await t.added('Hall lamp');
    const connection = (await t.home.devices.get(lamp.id)).connections[0]!.id;
    expect((await refusal(t.home.connections.setSecrets(lamp.id, connection, { room: 'x' }))).kind).toBe('invalid');
    const changed = await t.home.connections.setSecrets(lamp.id, connection, { pin: '4321' });
    expect(changed.connections[0]!.secrets).toEqual(['pin']);
    expect(JSON.stringify(changed)).not.toContain('4321');
  });
});

describe('links', () => {
  test('a plug feeds a station’s mains input, and not the other way round', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const station = await t.added('Garage station', { typeId: 'test.station' });

    expect((await refusal(t.home.links.add({ kind: 'feeds', source: end(station, 'input.ac'), target: end(plug, 'main') }))).kind).toBe('invalid');
    // The station's main part takes no mains: its input does.
    const wrongPart = await refusal(t.home.links.add({ kind: 'feeds', source: end(plug, 'main'), target: end(station, 'main') }));
    expect(wrongPart.kind).toBe('invalid');
    expect(wrongPart.message).toContain('the one must offer switch, the other acInput');
    // Nor is there a link of another kind, nor one from a device to itself.
    expect((await refusal(t.home.links.add({ kind: 'powers' as never, source: end(plug, 'main'), target: end(station, 'input.ac') }))).kind).toBe('invalid');
    expect((await refusal(t.home.links.add({ kind: 'feeds', source: end(station, 'outlet.ac'), target: end(station, 'input.ac') }))).kind).toBe('invalid');

    const link = await t.home.links.add({ kind: 'feeds', source: end(plug, 'main'), target: end(station, 'input.ac') });
    expect((await t.home.devices.get(station.id)).links).toEqual([
      expect.objectContaining({ kind: 'feeds', role: 'target', part: 'input.ac', other: { id: plug.id, name: 'Heater plug', part: 'main', partLabel: '' } }),
    ]);
    await t.home.links.remove(link.id);
    expect((await t.home.devices.get(station.id)).links).toEqual([]);
    expect((await refusal(t.home.links.remove(link.id))).kind).toBe('not-found');
  });

  test('a station’s outlet can feed another station: links join parts', async () => {
    const garage = await t.added('Garage station', { typeId: 'test.station' });
    const cabin = await t.added('Cabin station', { typeId: 'test.station' });
    await t.home.links.add({ kind: 'feeds', source: end(garage, 'outlet.ac'), target: end(cabin, 'input.ac') });
    expect((await t.home.devices.get(garage.id)).links).toEqual([
      expect.objectContaining({ role: 'source', part: 'outlet.ac', other: { id: cabin.id, name: 'Cabin station', part: 'input.ac', partLabel: 'Mains' } }),
    ]);
    await settle();
    // Cutting it cuts the other station's mains: a person confirms, told which.
    const refused = await t.home.devices.command(garage.id, 'outlet.ac', 'switch', 'set', { args: { on: false } });
    expect(refused).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });
    expect(refused.detail).toContain('Cabin station — Mains');
  });
});
