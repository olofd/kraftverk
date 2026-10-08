import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { DeviceView } from '@kraftverk/api-contract';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { aHome, refusal, settle, type TestHome } from './a-home.ts';

/*
  A device you have, asked of the home: renamed, pictured, removed and
  deleted; every command and setting through the gateway; its type's tools;
  what it is, from its parts. A lamp on the pretend bus, and a station and a
  plug of the tests' own, simulated (`kinds.ts`).
*/

let t: TestHome;
beforeEach(async () => {
  t = await aHome();
});
afterEach(async () => {
  await t.stop();
});

/** A lamp on the bus, added. */
const aLamp = async (): Promise<DeviceView> => {
  t.lampAt('lamp-1');
  return t.added('Hall lamp');
};

describe('a device you have', () => {
  test('is renamed, and given a key; nothing else about it changes', async () => {
    const lamp = await aLamp();
    const renamed = await t.home.devices.update(lamp.id, { name: 'Shed' });
    expect(renamed).toMatchObject({ name: 'Shed', typeId: 'test.lamp', key: lamp.key });
    expect((await t.home.timeline()).find((entry) => entry.kind === 'device.renamed')?.summary).toBe('Renamed "Hall lamp" to "Shed"');
  });

  test('shows the picture its owner picks, for every app: one of its type’s, or a photo of its own once it is kept', async () => {
    const lamp = await aLamp();
    expect((await t.home.devices.get(lamp.id)).picture).toBe('type:0');
    expect((await t.home.devices.setPicture(lamp.id, 'type:2')).picture).toBe('type:2');
    expect((await t.home.devices.get(lamp.id)).picture).toBe('type:2');
    // Kept for the device, and in the list as well.
    expect((await t.home.devices.list()).find((device) => device.id === lamp.id)?.picture).toBe('type:2');
    expect((await refusal(t.home.devices.setPicture(lamp.id, 'type:x' as never))).kind).toBe('invalid');
    const id = 'ab'.repeat(32);
    const own = await refusal(t.home.devices.setPicture(lamp.id, `own:${id}`));
    expect([own.kind, own.message]).toEqual(['invalid', 'That picture is not kept here: add it first']);
    // A picture is kept by its content, checked for what it says it is: these are a PNG's first bytes, and some.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await refusal(t.home.media.add({ type: 'image/jpeg', width: 4, height: 3, data: png }))).message).toBe('Those bytes are not image/jpeg');
    const photo = await t.home.media.add({ type: 'image/png', width: 4, height: 3, data: png });
    expect(photo).toMatchObject({ type: 'image/png', bytes: 11, width: 4, height: 3 });
    expect(photo.id).toMatch(/^[0-9a-f]{64}$/);
    // Kept once, however often it is added.
    expect((await t.home.media.add({ type: 'image/png', width: 4, height: 3, data: png })).id).toBe(photo.id);
    expect((await t.home.devices.setPicture(lamp.id, `own:${photo.id}`)).picture).toBe(`own:${photo.id}`);
    expect((await t.home.media.get(photo.id))?.data).toEqual(png);
    // Back to the first: nothing kept.
    expect((await t.home.devices.setPicture(lamp.id, 'type:0')).picture).toBe('type:0');
  });

  test('keeps where it has been only when it says where it is, says so in its file, and forgets it when turned off', async () => {
    const lamp = await aLamp();
    const refused = await refusal(t.home.devices.setTrack(lamp.id, 30));
    expect([refused.kind, refused.message]).toEqual(['invalid', '"Hall lamp" does not say where it is']);
    expect((await refusal(t.home.devices.track(lamp.id, 'yesterday'))).kind).toBe('invalid');

    // As a file would have it: kept a month.
    t.hub.catalog.setTrack(lamp.id, 30);
    expect((await t.home.devices.get(lamp.id)).trackDays).toBe(30);
    expect((await t.home.configuration.export({ secrets: 'none' })).text).toContain('    track: 30 days\n');
    expect(await t.home.devices.track(lamp.id, new Date(0).toISOString())).toEqual([]);

    expect((await t.home.devices.setTrack(lamp.id, null)).trackDays).toBeNull();
    expect((await t.home.timeline()).find((entry) => entry.kind === 'device.untracked')?.summary).toBe('Stopped keeping where "Hall lamp" has been, and forgot it');
    expect((await t.home.configuration.export({ secrets: 'none' })).text).not.toContain('track:');
  });

  test('one that is not there is not found', async () => {
    expect((await refusal(t.home.devices.get(savedDeviceId('abc%def')))).kind).toBe('not-found');
    expect((await refusal(t.home.devices.history(savedDeviceId('abc%def'), { key: 'soc' }))).kind).toBe('not-found');
  });

  test('removing keeps its history; deleting it takes the name typed back', async () => {
    const lamp = await aLamp();
    expect((await refusal(t.home.devices.deleteHistory(lamp.id, 'Hall lamp'))).kind).toBe('conflict');
    await t.home.devices.remove(lamp.id);

    expect(await t.home.devices.list()).toEqual([]);
    expect((await t.home.devices.removed()).map((device) => device.id)).toEqual([lamp.id]);
    expect((await t.home.devices.history(lamp.id, { key: 'on' })).deviceId).toBe(lamp.id);

    expect((await refusal(t.home.devices.deleteHistory(lamp.id, 'hall'))).kind).toBe('invalid');
    await t.home.devices.deleteHistory(lamp.id, 'Hall lamp');
    expect((await refusal(t.home.devices.get(lamp.id))).kind).toBe('not-found');
    expect((await t.home.timeline()).map((entry) => entry.kind)).toEqual(expect.arrayContaining(['device.removed', 'device.history-deleted']));
  });

  test('a command to a part goes through the gateway, and switches the lamp', async () => {
    const lamp = await aLamp();
    await settle(30); // its first reading
    const result = await t.home.devices.command(lamp.id, 'main', 'switch', 'set', { args: { on: false } });
    expect(result.outcome).toBe('verified');
    expect(t.bus.lamps.get('lamp-1')!.on).toBe(false);
    // No such capability anywhere; one it does not offer, a command it does not have and a part it does not have are the gateway's refusals.
    expect((await refusal(t.home.devices.command(lamp.id, 'main', 'teleport', 'set', { args: { on: true } }))).kind).toBe('not-found');
    expect((await t.home.devices.command(lamp.id, 'main', 'battery', 'set', { args: { on: true } })).outcome).toBe('refused');
    expect((await t.home.devices.command(lamp.id, 'main', 'switch', 'explode', { args: { on: true } })).outcome).toBe('refused');
    expect((await t.home.devices.command(lamp.id, 'outlet.z', 'switch', 'set', { args: { on: true } })).outcome).toBe('refused');
  });

  test('a device is served with its description, and what it offers comes from its parts', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    await settle();
    const view = await t.home.devices.get(station.id);
    expect(view.description.parts!.map((part) => part.id)).toEqual(expect.arrayContaining(['main', 'input.ac', 'outlet.ac', 'pack.1']));
    expect(view.capabilities).toEqual(expect.arrayContaining(['battery', 'acInput', 'switch', 'powerMeter']));
    expect(view.info).toMatchObject({ manufacturer: 'Test works' });
    // The pack the simulator reports is kept with the device, so its history keeps its name —
    // recorded on the holder's next check, which runs every little while.
    await t.hub.sessions.check();
    const kept = t.database.query<{ key: string }, [string]>("SELECT key FROM device_attribute WHERE device_id = ? AND part = 'pack.1'").all(station.id);
    expect(kept.map((row) => row.key)).toEqual(['pack.1.soc']);
    expect(await t.home.devices.events(station.id)).toEqual([]);
  });

  test('cutting mains to a station a plug feeds asks for confirmation, naming the station', async () => {
    const plug = await t.added('Heater plug', { typeId: 'test.plug' });
    const station = await t.added('Garage station', { typeId: 'test.station' });
    await t.home.links.add({ kind: 'feeds', source: { device: plug.id, part: 'main' }, target: { device: station.id, part: 'input.ac' } });
    await settle();

    const refused = await t.home.devices.command(plug.id, 'main', 'switch', 'set', { args: { on: false } });
    expect(refused).toMatchObject({ outcome: 'refused', needsConfirmation: expect.any(String) });
    expect(refused.detail).toContain('Garage station');
  });

  test('its type’s tools: a read is asked as one, a write is audited, refusals too', async () => {
    const lamp = await aLamp();
    // Declared as data: what each asks for and answers, listed with the device.
    expect((await t.home.devices.get(lamp.id)).tools.map((tool) => [tool.name, tool.writes])).toEqual([
      ['ping', false],
      ['blink', true],
    ]);
    expect(await t.home.devices.tool(lamp.id, 'ping', { reading: true })).toEqual({ pong: true, room: 'Hall' });
    expect((await refusal(t.home.devices.tool(lamp.id, 'blink', { reading: true }))).kind).toBe('not-allowed');
    expect((await refusal(t.home.devices.tool(lamp.id, 'nothing', { reading: true }))).kind).toBe('not-found');
    expect(await t.home.devices.tool(lamp.id, 'blink', { input: { times: 2 } })).toEqual({ blinked: 2 });
    // Its input is checked against what it asks for before it runs.
    const outOfRange = await refusal(t.home.devices.tool(lamp.id, 'blink', { input: { times: 500 } }));
    expect([outOfRange.kind, outOfRange.message]).toEqual(['invalid', 'Times must be at most 99']);
    const refused = await refusal(t.home.devices.tool(lamp.id, 'blink', { input: { times: 99 } }));
    expect(refused.kind).toBe('conflict');
    expect(refused.message).toContain('overheat');
    const kinds = (await t.home.timeline()).filter((entry) => entry.kind.startsWith('device.tool'));
    expect(kinds.map((entry) => entry.kind).sort()).toEqual(['device.tool', 'device.tool-refused', 'device.tool-refused']);
    expect(kinds.every((entry) => entry.actor.name === 'olof')).toBe(true);
  });

  test('a tool that cannot be undone waits for a person’s yes: a token for this tool and this person, good once', async () => {
    const plug = await t.added('Desk plug', { typeId: 'test.plug' });
    const reset = (confirmation?: string) => t.home.devices.tool(plug.id, 'resetEnergy', confirmation === undefined ? {} : { confirmation });

    const asked = await refusal(reset());
    expect(asked.kind).toBe('needs-yes');
    expect(asked.needsConfirmation).toEqual(expect.any(String));
    expect(asked.message).toContain('zero');
    // A word anyone could send is no yes.
    expect((await refusal(reset('yes'))).needsConfirmation).toEqual(expect.any(String));

    const token = (await refusal(reset())).needsConfirmation!;
    expect(await reset(token)).toBe(true);
    expect((await refusal(reset(token))).kind).toBe('needs-yes');
    // Another person's yes is not this one's.
    const theirs = (await refusal(t.as({ kind: 'person', name: 'guest', account: 'u-guest' }).devices.tool(plug.id, 'resetEnergy', {}))).needsConfirmation!;
    expect((await refusal(reset(theirs))).kind).toBe('needs-yes');
    // A tool that can be undone just runs.
    expect(await t.home.devices.tool(plug.id, 'rotateScreen', {})).toBe(true);
  });
});

describe('a read-only home', () => {
  test('refuses a tool that writes to hardware before it runs; a simulated device has none', async () => {
    const readOnly = await aHome({ readOnly: true });
    try {
      readOnly.lampAt('lamp-1');
      const real = await readOnly.added('Real lamp');
      expect((await refusal(readOnly.home.devices.tool(real.id, 'blink', {}))).kind).toBe('locked');
      expect((await readOnly.home.devices.command(real.id, 'main', 'switch', 'set', { args: { on: false } })).outcome).toBe('refused');

      // The node holding it says so, for a screen to draw: never of a simulated one.
      expect((await readOnly.home.devices.get(real.id)).readOnly).toBe(true);
      const pretend = await readOnly.added('Pretend lamp', { methodId: 'simulated' });
      expect((await readOnly.home.devices.get(pretend.id)).readOnly).toBe(false);
      expect(await readOnly.home.devices.tool(pretend.id, 'blink', {})).toEqual({ blinked: 1 });
      expect((await readOnly.home.devices.command(pretend.id, 'main', 'switch', 'set', { args: { on: false } })).outcome).not.toBe('refused');
    } finally {
      await readOnly.stop();
    }
  });
});

describe('settings, through the gateway', () => {
  test('a setting is written, read back and audited; one that can damage the hardware is confirmed first', async () => {
    const station = await t.added('Garage station', { typeId: 'test.station' });
    const write = (patch: Record<string, string | number | boolean>, confirmation?: string) => t.home.devices.write(station.id, { patch, ...(confirmation === undefined ? {} : { confirmation }) });

    const led = await write({ ledMode: 'sos' });
    expect(led).toMatchObject({ outcome: 'verified', values: expect.objectContaining({ ledMode: 'sos' }) });

    expect(await write({ turbo: true })).toMatchObject({ outcome: 'refused', detail: 'No such setting: turbo' });
    // What it reports is not something it can be told.
    expect(await write({ soc: 100 })).toMatchObject({ outcome: 'refused', detail: 'No such setting: soc' });

    const risky = await write({ sleepMinutes: '480' });
    expect(risky.outcome).toBe('refused');
    expect(risky.needsConfirmation).toEqual(expect.any(String));
    // A word anyone could send is no yes; the token the refusal handed out is.
    expect((await write({ sleepMinutes: '480' }, 'confirm')).outcome).toBe('refused');
    const asked = await write({ sleepMinutes: '480' });
    expect((await write({ sleepMinutes: '480' }, asked.needsConfirmation!)).outcome).toBe('verified');

    const kinds = (await t.home.timeline()).map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['settings.intent', 'settings.verified', 'settings.refused']));
  });
});
