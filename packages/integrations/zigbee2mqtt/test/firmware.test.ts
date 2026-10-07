import { afterEach, describe, expect, test } from 'bun:test';

import { validateDescription } from '@kraftverk/device-sdk';

import type { MemberEvent, ZigbeeLink } from '../src/link.ts';
import { ZigbeeNetwork } from '../src/network.ts';
import { PLUG_EXPOSES, playedZigbee2Mqtt, type PlayedZigbee2Mqtt } from '../src/played.ts';
import { brokerPolicy, FIRMWARE_KEYS, readingsOf, shapeOf, updateOf, versionName, type BridgeDevice } from '../src/protocol/index.ts';

/*
  Software updates (docs/PLAN-ZIGBEE.md §5.7): what the broker lets through,
  a device's firmware as readings, and updates on a played Zigbee2MQTT — one
  at a time, followed by state, stopped, and the settings compared after.
  Every address made up.
*/

const PLUG = '00124b00000000a1';
const OTHER = '00124b00000000a5';

const until = async (holds: () => boolean, what: string, ms = 3000) => {
  const started = Date.now();
  while (!holds()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('what the broker lets through', () => {
  const refused = (what: string, body: unknown) => brokerPolicy.refuse(`zigbee2mqtt/bridge/request/${what}`, bytes(body));

  test('an update, its stop, a check and a schedule, naming the device and nothing else', () => {
    for (const what of ['device/ota_update/check', 'device/ota_update/update', 'device/ota_update/update/abort', 'device/ota_update/schedule', 'device/ota_update/unschedule']) {
      expect(refused(what, { id: '0x00124b00000000a1', transaction: 'kv-1' })).toBeNull();
    }
  });

  test('never a firmware of the request’s own, never how it is sent, never a downgrade', () => {
    expect(refused('device/ota_update/update', { id: '0x00124b00000000a1', url: 'https://example.invalid/evil.ota' })).toContain('url');
    expect(refused('device/ota_update/update', { id: '0x00124b00000000a1', hex: { data: '1EF1EE0B', file_name: 'x.ota' } })).toContain('hex');
    expect(refused('device/ota_update/schedule', { id: '0x00124b00000000a1', image_block_response_delay: 50 })).toContain('image_block_response_delay');
    expect(refused('device/ota_update/update', '0x00124b00000000a1')).toContain('names its device');
    expect(refused('device/ota_update/update/downgrade', { id: '0x00124b00000000a1' })).toContain('never sent');
    expect(refused('device/ota_update/check/downgrade', { id: '0x00124b00000000a1' })).toContain('never sent');
  });

  test('a device updating keeps the broker and Zigbee2MQTT from being restarted, without naming it', () => {
    const busy = brokerPolicy.busy!('zigbee2mqtt/0x00124b00000000a1', bytes({ state: 'ON', update: { state: 'updating', progress: 41.6 } }));
    expect(busy).toContain('42 %');
    expect(busy).not.toContain('0x00124b');
    expect(brokerPolicy.busy!('zigbee2mqtt/0x00124b00000000a1', bytes({ update: { state: 'available' } }))).toBeNull();
    expect(brokerPolicy.busy!('zigbee2mqtt/bridge/info', bytes({ update: { state: 'updating' } }))).toBeNull();
  });
});

describe('a device’s firmware, as readings', () => {
  test('a version as its image names it, else its number', () => {
    expect(versionName(8451, 'https://raw.githubusercontent.com/Koenkk/zigbee-OTA/master/images/Sonoff/SN-TLSR8656-S60-01-v2.1.3.ota')).toBe('2.1.3');
    expect(versionName(8704, 'https://raw.githubusercontent.com/Koenkk/zigbee-OTA/master/images/Sonoff/snzb-02p_v2.2.0.ota')).toBe('2.2.0');
    expect(versionName(538448404, 'https://example.invalid/SAL2WB1_181214.ota')).toBe('#538448404');
  });

  test('only where Zigbee2MQTT can update it: what it runs, what is offered and what it changes, and while updating, how far', () => {
    expect(shapeOf(PLUG_EXPOSES).description.attributes.some((attribute) => attribute.key.startsWith('firmware.'))).toBe(false);
    const shape = shapeOf(PLUG_EXPOSES, { ota: true });
    expect(validateDescription(shape.description, 'firmware')).toEqual([]);
    expect(shape.description.events?.map((event) => event.id)).toEqual(['firmware.updated', 'firmware.failed', 'firmware.settings-changed']);
    const offered = { installed_version: 4098, latest_version: 8451, latest_source: 'https://example.invalid/PLUG-1-v2.1.3.ota', latest_release_notes: 'Measures more precisely.' };
    const read = (update: unknown) => Object.fromEntries(readingsOf(shape, { software_build_id: '1.0.2', update }, 'x').map((reading) => [reading.key, reading.value]));
    expect(read({ ...offered, state: 'available' })).toMatchObject({
      [FIRMWARE_KEYS.installed]: '1.0.2',
      [FIRMWARE_KEYS.state]: 'available',
      [FIRMWARE_KEYS.latest]: '2.1.3',
      [FIRMWARE_KEYS.notes]: 'Measures more precisely.',
      [FIRMWARE_KEYS.progress]: null,
    });
    expect(read({ ...offered, state: 'updating', progress: 37.5, remaining: 900 })).toMatchObject({ [FIRMWARE_KEYS.progress]: 37.5, [FIRMWARE_KEYS.remaining]: 900 });
    // Up to date: nothing newer, nothing to read about it.
    expect(read({ installed_version: 8451, latest_version: 8451, state: 'idle' })).toMatchObject({ [FIRMWARE_KEYS.latest]: null, [FIRMWARE_KEYS.notes]: null });
    expect(updateOf('nonsense')).toBeNull();
  });

  test('its settings are known, written or not: what an update is checked against', () => {
    expect(shapeOf(PLUG_EXPOSES).settings.map((setting) => setting.property)).toEqual(['power_outage_memory', 'child_lock']);
  });
});

describe('updating, on a played Zigbee2MQTT', () => {
  let played: PlayedZigbee2Mqtt;
  let network: ZigbeeNetwork;
  const logged: string[] = [];
  const open = (options: Parameters<typeof playedZigbee2Mqtt>[0] = {}) => {
    played = playedZigbee2Mqtt({ stepMs: 30, ...options });
    network = new ZigbeeNetwork(played.channel, {
      changed: () => {},
      log: (message) => logged.push(message),
      now: () => Date.now(),
      updateTiming: { reasonWaitMs: 30, settingsAskMs: 20, settingsCompareMs: 60, startWaitMs: 2000 },
    });
    network.start();
  };
  afterEach(() => {
    network?.close();
    played?.stop();
  });

  /** A link that keeps every event it is told, as a session's does. */
  const watched = async (key: string) => {
    const events: MemberEvent[] = [];
    let link: ZigbeeLink | null = null;
    link = await network.link(key, () => events.push(...(link?.takeEvents() ?? [])));
    return { link, events };
  };

  test('updated: its progress said, the device on its new firmware, and the update an event with from and to', async () => {
    open();
    await until(() => network.devices().length === 3, 'the devices');
    const { link, events } = await watched(PLUG);
    await until(() => updateOf(link.state().values.update)?.state === 'available', 'the update offered');
    expect(await link.firmware.check()).toBe('A newer firmware is offered: 2.1.3. Measures more precisely.');

    expect(await link.firmware.update()).toStartWith('Updating');
    await until(() => updateOf(link.state().values.update)?.state === 'updating', 'it updating');
    expect(network.firmware.updating?.key).toBe(PLUG);
    await until(() => events.some((event) => event.id === 'firmware.updated'), 'it updated');
    expect(events.find((event) => event.id === 'firmware.updated')?.data).toEqual({ from: '1.0.2', to: '2.1.3' });
    expect(link.about()?.software).toBe('2.1.3');
    expect(network.firmware).toEqual({ offered: 0, updating: null, waiting: 0 });
    // Nothing of its settings changed: nothing said.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.id === 'firmware.settings-changed')).toBe(false);
  });

  test('one at a time: a second waits its turn, and begins when the first is done', async () => {
    const first = playedZigbee2Mqtt().devices()[0]!;
    const second: BridgeDevice = { ...first, ieee_address: `0x${OTHER}`, friendly_name: `0x${OTHER}` };
    open({ devices: [first, second] });
    await until(() => network.devices().length === 2, 'the devices');
    const a = await watched(PLUG);
    const b = await watched(OTHER);
    await until(() => updateOf(b.link.state().values.update)?.state === 'available', 'the updates offered');
    await a.link.firmware.update();
    expect(await b.link.firmware.update()).toStartWith('Waiting its turn');
    expect(network.firmware.waiting).toBe(1);
    expect(updateOf(b.link.state().values.update)?.state).toBe('available');
    await until(() => a.events.some((event) => event.id === 'firmware.updated'), 'the first updated');
    await until(() => b.events.some((event) => event.id === 'firmware.updated'), 'the second, after it');
  });

  test('stopped: it keeps its firmware, and the stop is said as why it failed; one waiting is taken out of line', async () => {
    const first = playedZigbee2Mqtt().devices()[0]!;
    const second: BridgeDevice = { ...first, ieee_address: `0x${OTHER}`, friendly_name: `0x${OTHER}` };
    open({ devices: [first, second], stepMs: 200 });
    await until(() => network.devices().length === 2, 'the devices');
    const a = await watched(PLUG);
    const b = await watched(OTHER);
    await until(() => updateOf(b.link.state().values.update)?.state === 'available', 'the updates offered');
    await a.link.firmware.update();
    await b.link.firmware.update();
    expect(await b.link.firmware.stop()).toStartWith('Taken out of line');
    await until(() => updateOf(a.link.state().values.update)?.state === 'updating', 'it updating');
    expect(await a.link.firmware.stop()).toStartWith('Stopped');
    await until(() => a.events.some((event) => event.id === 'firmware.failed'), 'it failed');
    expect(a.events.find((event) => event.id === 'firmware.failed')?.data).toEqual({ reason: 'Stopped by a person' });
    expect(a.link.about()?.software).toBe('1.0.2');
    expect(network.firmware.updating).toBeNull();
    // The one taken out of line never began.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updateOf(b.link.state().values.update)?.state).toBe('available');
  });

  test('the line outlives a restart of the server: the update under way is waited out, then the next begins', async () => {
    const first = playedZigbee2Mqtt().devices()[0]!;
    const second: BridgeDevice = { ...first, ieee_address: `0x${OTHER}`, friendly_name: `0x${OTHER}` };
    let kept: unknown = null;
    const keep = { load: () => kept as never, save: (value: unknown) => void (kept = value) };
    played = playedZigbee2Mqtt({ devices: [first, second], stepMs: 150 });
    const timing = { reasonWaitMs: 30, settingsAskMs: 20, settingsCompareMs: 60, startWaitMs: 2000 };
    const before = new ZigbeeNetwork(played.channel, { changed: () => {}, log: () => {}, now: () => Date.now(), keep, updateTiming: timing });
    before.start();
    await until(() => before.devices().length === 2, 'the devices');
    const a = await before.link(PLUG, () => {});
    await until(() => updateOf(a.state().values.update)?.state === 'available', 'the update offered');
    await a.firmware.update();
    await (await before.link(OTHER, () => {})).firmware.update();
    await until(() => updateOf(a.state().values.update)?.state === 'updating', 'the first updating');
    // The server restarts: what it knew in memory is gone; the line was kept.
    before.close();
    expect(kept).toMatchObject({ waiting: [OTHER] });

    network = new ZigbeeNetwork(played.channel, { changed: () => {}, log: () => {}, now: () => Date.now(), keep, updateTiming: timing });
    network.start();
    const b = await network.link(OTHER, () => {});
    await until(() => network.devices().length === 2, 'the devices, again');
    // Not begun while the first is still updating: one at a time holds for an update it did not begin.
    expect(updateOf(b.state().values.update)?.state).toBe('available');
    await until(() => updateOf(b.state().values.update)?.state === 'updating', 'the second, after the first', 5000);
    await until(() => updateOf(b.state().values.update)?.state === 'idle', 'the second done', 5000);
    expect(kept).toMatchObject({ waiting: [] });
  });

  test('refused: nothing offered, a group, a battery too low', async () => {
    open();
    await until(() => network.devices().length === 3, 'the devices');
    const sensor = await network.link('00124b00000000a3', () => {});
    await expect(sensor.firmware.update()).rejects.toThrow('cannot update');
    const plug = await network.link(PLUG, () => {});
    await until(() => updateOf(plug.state().values.update)?.state === 'available', 'the update offered');
    await plug.firmware.update();
    await until(() => updateOf(plug.state().values.update)?.state === 'idle', 'it updated');
    await expect(plug.firmware.update()).rejects.toThrow('No newer firmware');
  });

  test('a setting a new firmware set otherwise is said, with what it was and is', async () => {
    open({ firmwareChanges: { child_lock: 'LOCK' } });
    await until(() => network.devices().length === 3, 'the devices');
    const { link, events } = await watched(PLUG);
    await until(() => updateOf(link.state().values.update)?.state === 'available', 'the update offered');
    await link.firmware.update();
    await until(() => events.some((event) => event.id === 'firmware.settings-changed'), 'the change said');
    expect(events.find((event) => event.id === 'firmware.settings-changed')?.data).toEqual({ changed: 'child_lock: UNLOCK → LOCK' });
    // And asked again first, as Zigbee2MQTT configured it anew.
    expect(played.heard.some((said) => said.topic === `zigbee2mqtt/0x${PLUG}/get` && 'child_lock' in (said.payload as object))).toBe(true);
  });
});
