import { afterEach, describe, expect, test } from 'bun:test';

import { validateDescription, validateProtocol, type Member, type Sighting } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import bridge from '../src/bridge.ts';
import type { ZigbeeLink } from '../src/link.ts';
import { groupKey, ZigbeeNetwork } from '../src/network.ts';
import { BUTTON_EXPOSES, LIGHT_EXPOSES, PLUG_EXPOSES, SENSOR_EXPOSES, SWITCH_EXPOSES, playedZigbee2Mqtt, type PlayedZigbee2Mqtt } from '../src/played.ts';
import protocol, { actionOf, brokerPolicy, groupExposes, parseTopic, readingsOf, setPayload, shapeOf, type Expose } from '../src/protocol/index.ts';
import * as types from '../src/types.ts';

/*
  Zigbee2MQTT over MQTT (docs/PLAN-ZIGBEE.md §5): the protocol and what the
  broker applies, what exposes become, and the network against a played
  Zigbee2MQTT — the coordinator's members, a plug switched and read back,
  devices joining, groups made and switched as one. Every address made up.
*/

const PLUG = '00124b00000000a1';
const SWITCH = '00124b00000000a2';
const SENSOR = '00124b00000000a3';

const until = async (holds: () => boolean, what: string, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`Waited for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('the protocol, and what the broker applies', () => {
  test('is a valid protocol over the broker, its address the base topic', () => {
    expect(validateProtocol(protocol)).toEqual([]);
    expect(protocol.bindings.mqtt!.parseAddress!(' zigbee2mqtt ')).toBe('zigbee2mqtt');
    expect(protocol.bindings.mqtt!.parseAddress!('something-else')).toBeNull();
  });

  test('recognises Zigbee2MQTT among the broker’s clients', () => {
    const sighting: Sighting = { transport: 'mqtt', address: 'zigbee2mqtt', seenAt: '2026-10-07T00:00:00.000Z', heard: [{ kind: 'client', protocol: 'zigbee2mqtt', online: true }] };
    expect(protocol.bindings.mqtt!.recognise(sighting)).toMatchObject({ name: 'Zigbee2MQTT' });
    expect(protocol.bindings.mqtt!.recognise({ ...sighting, heard: [{ kind: 'client', protocol: 'sydpower', online: true }] })).toBeNull();
  });

  test('every topic under its root is the coordinator’s; its commands are /set, /get and bridge requests', () => {
    expect(brokerPolicy.root).toBe('zigbee2mqtt/');
    expect(brokerPolicy.signedIn).toBe(true);
    expect(brokerPolicy.fromDevice('zigbee2mqtt/0x00124b00000000a1')).toEqual({ address: 'zigbee2mqtt', channel: '0x00124b00000000a1' });
    expect(brokerPolicy.fromDevice('AABBCC001122/device/response/04')).toBeNull();
    for (const topic of ['zigbee2mqtt/lamp/set', 'zigbee2mqtt/lamp/set/state', 'zigbee2mqtt/lamp/l1/set', 'zigbee2mqtt/lamp/get', 'zigbee2mqtt/bridge/request/permit_join']) {
      expect(brokerPolicy.commandFor(topic)).toBe('zigbee2mqtt');
    }
    for (const topic of ['zigbee2mqtt/lamp', 'zigbee2mqtt/lamp/availability', 'zigbee2mqtt/bridge/devices', 'zigbee2mqtt/bridge/response/permit_join']) {
      expect(brokerPolicy.commandFor(topic)).toBeNull();
    }
  });

  test('refuses what changes the network itself, to everyone — the server too', () => {
    const none = new Uint8Array();
    for (const what of ['options', 'restart', 'touchlink/factory_reset', 'install_code/add', 'extension/save']) {
      expect(brokerPolicy.refuse(`zigbee2mqtt/bridge/request/${what}`, none)).toContain('never sent');
    }
    for (const what of ['permit_join', 'device/remove', 'group/add', 'group/members/add', 'backup']) expect(brokerPolicy.refuse(`zigbee2mqtt/bridge/request/${what}`, none)).toBeNull();
    expect(brokerPolicy.refuse('zigbee2mqtt/lamp/set', bytes({ state: 'ON' }))).toBeNull();
  });

  test('a device’s state is debug in the journal, the bridge’s own news is not', () => {
    expect(brokerPolicy.describeMessage('0x00124b00000000a1', bytes({ power: 4 })).level).toBe('debug');
    expect(brokerPolicy.describeMessage('bridge/state', bytes({ state: 'offline' }))).toMatchObject({ level: 'info', summary: 'Zigbee2MQTT is offline' });
    expect(brokerPolicy.describeCommand('zigbee2mqtt/lamp/get', bytes({ state: '' })).level).toBe('debug');
  });

  test('a name with slashes, an endpoint, an attribute: each topic read as Zigbee2MQTT reads it', () => {
    expect(parseTopic('zigbee2mqtt/kitchen/lamp')).toEqual({ name: 'kitchen/lamp', verb: 'state', rest: '' });
    expect(parseTopic('zigbee2mqtt/kitchen/lamp/set/brightness')).toEqual({ name: 'kitchen/lamp', verb: 'set', rest: 'brightness' });
    expect(parseTopic('zigbee2mqtt/0x00124b00000000a2/availability')).toEqual({ name: '0x00124b00000000a2', verb: 'availability', rest: '' });
    expect(parseTopic('zigbee2mqtt/bridge/devices')).toEqual({ bridge: 'devices' });
  });
});

describe('what exposes become', () => {
  test('every played device is a valid description', () => {
    for (const exposes of [PLUG_EXPOSES, SWITCH_EXPOSES, SENSOR_EXPOSES, LIGHT_EXPOSES, BUTTON_EXPOSES]) {
      expect(validateDescription(shapeOf(exposes).description, 'zigbee2mqtt.test')).toEqual([]);
    }
  });

  test('a plug: an outlet that switches, its meter on the outlet with standard meanings, its power leading', () => {
    const shape = shapeOf(PLUG_EXPOSES);
    expect(shape.shelf).toBe('plug');
    expect(shape.description.parts?.map((part) => [part.id, part.kind, part.offers ?? []])).toEqual([
      ['main', 'device', []],
      ['switch', 'outlet', ['switch']],
    ]);
    const key = (k: string) => shape.description.attributes.find((attribute) => attribute.key === k);
    expect(key('switch.on')).toMatchObject({ means: 'on', part: 'switch' });
    expect(key('switch.power')).toMatchObject({ means: 'power', category: 'primary' });
    expect(key('switch.energy')).toMatchObject({ means: 'energy', stateClass: 'total_increasing' });
    expect(key('child_lock')).toMatchObject({ access: 'write', category: 'config', value: { type: 'boolean' } });
    expect(key('linkquality')).toMatchObject({ category: 'diagnostic' });
    expect(shape.switches.get('switch')?.property).toBe('state');
  });

  test('a binary is read by its own on and off: a contact’s on is open', () => {
    const contact: Expose = { type: 'binary', name: 'contact', property: 'contact', access: 1, value_on: false, value_off: true };
    const shape = shapeOf([contact]);
    expect(shape.description.attributes[0]).toMatchObject({ key: 'contact', label: 'Open' });
    expect(readingsOf(shape, { contact: false }, 'x')[0]?.value).toBe(true);
    expect(readingsOf(shape, { contact: true }, 'x')[0]?.value).toBe(false);
    const lock = shapeOf(PLUG_EXPOSES);
    expect(setPayload(lock, { child_lock: true })).toEqual({ payload: { child_lock: 'LOCK' } });
  });

  test('a battery’s voltage is not the mains’: no meaning, a diagnostic', () => {
    const shape = shapeOf(SENSOR_EXPOSES);
    expect(shape.shelf).toBe('sensor');
    const voltage = shape.description.attributes.find((attribute) => attribute.key === 'voltage');
    expect(voltage?.means).toBeUndefined();
    expect(voltage?.category).toBe('diagnostic');
    expect(shape.description.attributes.find((attribute) => attribute.key === 'humidity')).toMatchObject({ quantity: 'humidity' });
    expect(shape.description.attributes.find((attribute) => attribute.key === 'temperature')).toMatchObject({ means: 'temperature', category: 'primary' });
  });

  test('a two-gang switch: a part per endpoint, each switched by its own property', () => {
    const shape = shapeOf(SWITCH_EXPOSES);
    expect(shape.shelf).toBe('switch');
    expect([...shape.switches.keys()]).toEqual(['switch.l1', 'switch.l2']);
    expect(shape.switches.get('switch.l2')?.property).toBe('state_l2');
  });

  test('a light: brightness as a percentage, colour as one value of its own shape', () => {
    const shape = shapeOf(LIGHT_EXPOSES);
    expect(shape.shelf).toBe('light');
    const at = 'x';
    const readings = readingsOf(shape, { state: 'ON', brightness: 254, color: { x: 0.3, y: 0.4 } }, at);
    expect(readings.find((r) => r.key === 'light.brightness')?.value).toBe(100);
    expect(readings.find((r) => r.key === 'light.color')?.value).toEqual({ x: 0.3, y: 0.4 });
    expect(setPayload(shape, { 'light.brightness': 50 })).toEqual({ payload: { brightness: 127 } });
  });

  test('a button’s presses are events, with what was said beside them', () => {
    const shape = shapeOf(BUTTON_EXPOSES);
    expect(shape.description.events?.map((event) => event.id)).toEqual(['action.single', 'action.double', 'action.hold', 'action']);
    expect(actionOf(shape, { action: 'double', action_duration: 2 })).toEqual({ id: 'action.double', data: { action: 'double', action_duration: 2 } });
    expect(actionOf(shape, { action: 'triple' })?.id).toBe('action');
    expect(actionOf(shape, { action: '' })).toBeNull();
  });

  test('a group does what any member can, its colour temperature the range all share', () => {
    const narrow: Expose[] = [{ type: 'light', features: [{ type: 'binary', name: 'state', property: 'state', access: 7, value_on: 'ON', value_off: 'OFF' }, { type: 'numeric', name: 'color_temp', property: 'color_temp', access: 7, value_min: 250, value_max: 454 }] }];
    const merged = groupExposes([LIGHT_EXPOSES, narrow]);
    const light = merged.find((expose) => expose.type === 'light')!;
    expect(light.features?.map((feature) => feature.name)).toEqual(['state', 'brightness', 'color_temp', 'color_xy']);
    expect(light.features?.find((feature) => feature.name === 'color_temp')).toMatchObject({ value_min: 250, value_max: 454 });
  });
});

describe('the network, against a played Zigbee2MQTT', () => {
  let played: PlayedZigbee2Mqtt;
  let network: ZigbeeNetwork;
  const open = (options: Parameters<typeof playedZigbee2Mqtt>[0] = {}) => {
    played = playedZigbee2Mqtt({ stepMs: 20, ...options });
    network = new ZigbeeNetwork(played.channel, { changed: () => {}, log: () => {}, now: () => Date.now() });
    network.start();
    return network;
  };
  afterEach(() => {
    network?.close();
    played?.stop();
  });

  test('its members, from what it keeps: each on its shelf, the coordinator left out', async () => {
    open();
    await until(() => network.members().length === 3, 'the devices');
    const by = (key: string) => network.members().find((member) => member.key === key) as Member;
    expect(by(PLUG)).toMatchObject({ typeId: 'zigbee2mqtt.plug', identity: `zigbee:${PLUG}`, joining: false, model: 'PLUG-1' });
    expect(by(SWITCH).typeId).toBe('zigbee2mqtt.switch');
    expect(by(SENSOR).typeId).toBe('zigbee2mqtt.sensor');
    expect(network.connected).toBe(true);
    expect(network.identity).toBe('zigbee:00124b0000000001');
  });

  test('a plug switched off through its link: the payload by IEEE address, and its meter follows', async () => {
    open();
    await until(() => network.members().length === 3, 'the devices');
    let moved = 0;
    const link: ZigbeeLink = await network.link(PLUG, () => moved++);
    await link.set({ state: 'OFF' });
    await until(() => link.state().values.state === 'OFF', 'the plug off');
    expect(played.heard.at(-1)).toEqual({ topic: `zigbee2mqtt/0x${PLUG}/set`, payload: { state: 'OFF' } });
    expect(readingsOf(link.shape()!, link.state().values, 'x').find((r) => r.key === 'switch.power')?.value).toBe(0);
    expect(moved).toBeGreaterThan(0);
    expect(link.available()).toBe(true);
    link.close();
  });

  test('a press arrives as an event on the link', async () => {
    open({ devices: [...playedZigbee2Mqtt().devices(), { ieee_address: '0x00124b00000000b9', type: 'EndDevice', friendly_name: 'Hall button', supported: true, interview_state: 'SUCCESSFUL', definition: { model: 'BTN', vendor: 'Simulated', description: 'Button', exposes: BUTTON_EXPOSES } }] });
    await until(() => network.members().some((member) => member.key === '00124b00000000b9'), 'the button');
    const link = await network.link('00124b00000000b9', () => {});
    played.say('00124b00000000b9', { action: 'hold' });
    await until(() => link.takePresses().some((press) => press.id === 'action.hold'), 'the press');
  });

  test('a press kept on the broker with the state is not a press when it is replayed', async () => {
    const button = { ieee_address: '0x00124b00000000b9', type: 'EndDevice', friendly_name: 'Hall button', supported: true, interview_state: 'SUCCESSFUL' as const, definition: { model: 'BTN', vendor: 'Simulated', description: 'Button', exposes: BUTTON_EXPOSES } };
    played = playedZigbee2Mqtt({ stepMs: 20, devices: [button] });
    played.say('00124b00000000b9', { action: 'single' }, true);
    network = new ZigbeeNetwork(played.channel, { changed: () => {}, log: () => {}, now: () => Date.now() });
    const link = await network.link('00124b00000000b9', () => {});
    network.start();
    await until(() => link.state().values.action === 'single', 'the kept state');
    expect(link.takePresses()).toEqual([]);
  });

  test('devices join while it lets them: joining first, offered on their shelf once interviewed', async () => {
    open();
    await until(() => network.members().length === 3, 'the devices');
    await network.join.open(60);
    await until(() => network.join.until() !== null, 'joining open');
    await until(() => network.members().some((member) => member.joining), 'a device joining');
    await until(() => network.members().some((member) => member.key === '00124b00000000a8' && !member.joining), 'it interviewed');
    expect(network.members().find((member) => member.key === '00124b00000000a8')?.typeId).toBe('zigbee2mqtt.light');
    await network.join.open(0);
    await until(() => network.join.until() === null, 'joining closed');
  });

  test('a group made, filled and switched as one; an error answered as one', async () => {
    open();
    await until(() => network.members().length === 3, 'the devices');
    await network.request('group/add', { friendly_name: 'Desk' });
    await network.request('group/members/add', { group: 'Desk', device: `0x${PLUG}` });
    await until(() => network.members().some((member) => member.key === groupKey(1)), 'the group');
    expect(network.members().find((member) => member.key === groupKey(1))).toMatchObject({ name: 'Desk', typeId: 'zigbee2mqtt.group', identity: 'zigbee-group:00124b0000000001-1' });
    const group = await network.link(groupKey(1), () => {});
    await until(() => group.shape() !== null, 'the group’s shape');
    expect([...group.shape()!.switches.keys()]).toEqual(['switch']);
    await group.set({ state: 'OFF' });
    const plug = await network.link(PLUG, () => {});
    await until(() => plug.state().values.state === 'OFF', 'its member off');
    await expect(network.request('group/remove', { id: 'Nowhere' })).rejects.toThrow("Group 'Nowhere' does not exist");
  });

  test('Zigbee2MQTT going away is said; its devices with it', async () => {
    open();
    await until(() => network.members().length === 3, 'the devices');
    const link = await network.link(PLUG, () => {});
    played.setOnline(false);
    await until(() => !network.connected, 'it gone');
    expect(link.connected()).toBe(false);
    played.setOnline(true);
    await until(() => network.connected, 'it back');
  });
});

describe('the types', () => {
  test('the coordinator keeps its contract, simulated', async () => {
    expect(await checkDeviceTypeContract(bridge, { settleMs: 300 })).toEqual([]);
  });

  for (const [name, type] of Object.entries(types)) {
    test(`${name} keeps its contract, simulated`, async () => {
      expect(await checkDeviceTypeContract(type, { settleMs: 300 })).toEqual([]);
    });
  }
});
