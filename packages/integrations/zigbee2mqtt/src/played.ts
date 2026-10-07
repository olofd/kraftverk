import type { ChannelMessage, MessageChannel } from '@kraftverk/device-sdk';

import { BASE, ieeeKey, ieeeOf, objectOf, parseJson, parseTopic, type BridgeDevice, type BridgeGroup, type Expose } from './protocol/index.ts';

/*
  A Zigbee2MQTT that is not there (docs/PLAN-ZIGBEE.md §5.2): its MQTT API,
  played in memory over a channel of its own — what it keeps retained, what
  it answers a `/set`, a `/get` and a request with, devices joining while it
  lets them, interviewed a moment later, and groups. The coordinator's
  simulator runs on it, and so do the tests: the same code a real
  Zigbee2MQTT is spoken to with. Every address in it is made up.
*/

const plug = (n: number): BridgeDevice => ({
  ieee_address: `0x00124b00000000${(0xa0 + n).toString(16)}`,
  type: 'Router',
  friendly_name: `0x00124b00000000${(0xa0 + n).toString(16)}`,
  supported: true,
  power_source: 'Mains (single phase)',
  model_id: 'PLUG-1',
  manufacturer: 'Simulated',
  interview_state: 'SUCCESSFUL',
  definition: {
    model: 'PLUG-1',
    vendor: 'Simulated',
    description: 'Smart plug (with power monitoring)',
    source: 'native',
    supports_ota: true,
    exposes: PLUG_EXPOSES,
  },
});

/** A plug that switches and meters, as converters describes one. */
export const PLUG_EXPOSES: readonly Expose[] = [
  { type: 'switch', features: [{ type: 'binary', name: 'state', property: 'state', label: 'State', access: 7, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE' }] },
  { type: 'numeric', name: 'power', property: 'power', label: 'Power', access: 5, unit: 'W', description: 'Instantaneous measured power' },
  { type: 'numeric', name: 'current', property: 'current', label: 'Current', access: 5, unit: 'A' },
  { type: 'numeric', name: 'voltage', property: 'voltage', label: 'Voltage', access: 5, unit: 'V' },
  { type: 'numeric', name: 'energy', property: 'energy', label: 'Energy', access: 5, unit: 'kWh', description: 'Sum of consumed energy' },
  { type: 'enum', name: 'power_outage_memory', property: 'power_outage_memory', label: 'Power outage memory', access: 7, values: ['on', 'off', 'restore'], category: 'config', description: 'Recover state after power outage' },
  { type: 'binary', name: 'child_lock', property: 'child_lock', label: 'Child lock', access: 7, value_on: 'LOCK', value_off: 'UNLOCK', category: 'config' },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', label: 'Linkquality', access: 1, unit: 'lqi', value_min: 0, value_max: 255, category: 'diagnostic' },
];

/** A wall switch with two gangs: each its own endpoint. */
export const SWITCH_EXPOSES: readonly Expose[] = [
  { type: 'switch', endpoint: 'l1', features: [{ type: 'binary', name: 'state', property: 'state_l1', label: 'State', access: 7, value_on: 'ON', value_off: 'OFF', endpoint: 'l1' }] },
  { type: 'switch', endpoint: 'l2', features: [{ type: 'binary', name: 'state', property: 'state_l2', label: 'State', access: 7, value_on: 'ON', value_off: 'OFF', endpoint: 'l2' }] },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', label: 'Linkquality', access: 1, unit: 'lqi', category: 'diagnostic' },
];

/** A temperature and humidity sensor on a battery, whose voltage is its battery's (mV). */
export const SENSOR_EXPOSES: readonly Expose[] = [
  { type: 'numeric', name: 'temperature', property: 'temperature', label: 'Temperature', access: 1, unit: '°C' },
  { type: 'numeric', name: 'humidity', property: 'humidity', label: 'Humidity', access: 1, unit: '%' },
  { type: 'numeric', name: 'battery', property: 'battery', label: 'Battery', access: 1, unit: '%', value_min: 0, value_max: 100, category: 'diagnostic' },
  { type: 'numeric', name: 'voltage', property: 'voltage', label: 'Voltage', access: 1, unit: 'mV', category: 'diagnostic', description: 'Voltage of the battery' },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', label: 'Linkquality', access: 1, unit: 'lqi', category: 'diagnostic' },
];

/** A bulb that dims and changes colour. */
export const LIGHT_EXPOSES: readonly Expose[] = [
  {
    type: 'light',
    features: [
      { type: 'binary', name: 'state', property: 'state', label: 'State', access: 7, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE' },
      { type: 'numeric', name: 'brightness', property: 'brightness', label: 'Brightness', access: 7, value_min: 0, value_max: 254 },
      { type: 'numeric', name: 'color_temp', property: 'color_temp', label: 'Color temp', access: 7, unit: 'mired', value_min: 150, value_max: 500 },
      {
        type: 'composite',
        name: 'color_xy',
        property: 'color',
        label: 'Color (X/Y)',
        access: 7,
        features: [
          { type: 'numeric', name: 'x', property: 'x', label: 'X', access: 7 },
          { type: 'numeric', name: 'y', property: 'y', label: 'Y', access: 7 },
        ],
      },
    ],
  },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', label: 'Linkquality', access: 1, unit: 'lqi', category: 'diagnostic' },
];

/** A button: presses, as events. */
export const BUTTON_EXPOSES: readonly Expose[] = [
  { type: 'enum', name: 'action', property: 'action', label: 'Action', access: 1, values: ['single', 'double', 'hold'], category: 'diagnostic' },
  { type: 'numeric', name: 'battery', property: 'battery', label: 'Battery', access: 1, unit: '%', category: 'diagnostic' },
];

const device = (n: number, model: string, description: string, exposes: readonly Expose[], type: BridgeDevice['type'] = 'EndDevice'): BridgeDevice => {
  const ieee = `0x00124b00000000${(0xa0 + n).toString(16)}`;
  return { ieee_address: ieee, type, friendly_name: ieee, supported: true, interview_state: 'SUCCESSFUL', definition: { model, vendor: 'Simulated', description, source: 'native', exposes } };
};

/** What a played network starts with: a plug that meters, a wall switch and a sensor; each joining device after them a light, then a button. */
const PLAYED_DEVICES = (): BridgeDevice[] => [plug(1), device(2, 'WS-2G', 'Wall switch, two gangs', SWITCH_EXPOSES, 'Router'), device(3, 'TH-1', 'Temperature and humidity sensor', SENSOR_EXPOSES)];

const JOINERS = [() => device(8, 'BULB-CT', 'Colour bulb', LIGHT_EXPOSES, 'Router'), () => device(9, 'BTN-1', 'Wireless button', BUTTON_EXPOSES)];

type State = Record<string, unknown>;

/** A group as the played network keeps it: changed in place. */
type Group = { id: number; friendly_name: string; members: { ieee_address: string; endpoint: number }[]; scenes: { id: number; name: string }[] };

export type PlayedOptions = {
  devices?: BridgeDevice[];
  groups?: BridgeGroup[];
  /** How long joining and interviewing take, in ms: short in a test. */
  stepMs?: number;
  /** Availability on, as the deploy sets it. */
  availability?: boolean;
  now?: () => number;
};

/** A played Zigbee2MQTT and the channel to it, as the broker would carry it. */
export type PlayedZigbee2Mqtt = {
  channel: MessageChannel & { setConnected(connected: boolean): void };
  /** Everything kraftverk asked of it, in order. */
  heard: { topic: string; payload: unknown }[];
  /** A device saying something by itself: a sensor's reading, a button's press — kept on the broker when `retain`, as Zigbee2MQTT keeps a device's state with `retain` on. */
  say(key: string, values: State, retain?: boolean): void;
  /** Zigbee2MQTT going away (its last will) and coming back. */
  setOnline(online: boolean): void;
  devices(): BridgeDevice[];
  groups(): BridgeGroup[];
  stop(): void;
};

export function playedZigbee2Mqtt(options: PlayedOptions = {}): PlayedZigbee2Mqtt {
  const now = options.now ?? (() => Date.now());
  const stepMs = options.stepMs ?? 1500;
  const devices = options.devices ?? PLAYED_DEVICES();
  // Its own copies, changed as requests come.
  const groups: Group[] = (options.groups ?? []).map((group) => ({ ...group, members: [...group.members], scenes: [...(group.scenes ?? [])] }));
  const states = new Map<string, State>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const retained = new Map<string, Uint8Array>();
  const subscriptions: { filter: string; listener: (message: ChannelMessage) => void }[] = [];
  const connectedListeners = new Set<(connected: boolean) => void>();
  const heard: { topic: string; payload: unknown }[] = [];
  let connected = true;
  let online = true;
  let joinEnd: number | null = null;
  let joined = 0;

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    timers.add(timer);
  };

  const matches = (filter: string, topic: string): boolean => {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  };

  const publish = (topic: string, value: unknown, retain = false) => {
    const payload = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
    if (retain) retained.set(topic, payload);
    const message = { topic, payload, at: new Date(now()).toISOString() };
    // As a broker delivers: a moment later, never inside the publish that caused it.
    queueMicrotask(() => {
      for (const { filter, listener } of [...subscriptions]) if (matches(filter, topic)) listener(message);
    });
  };

  const keyOf = (name: string): string | null => {
    const found = devices.find((d) => d.friendly_name === name || ieeeKey(d.ieee_address) === ieeeKey(name));
    return found ? ieeeKey(found.ieee_address) : null;
  };

  const info = () => ({
    version: '2.14.2',
    coordinator: { ieee_address: '0x00124b0000000001', type: 'zStack3x0' },
    network: { channel: 11, pan_id: 6754 },
    permit_join: joinEnd !== null && joinEnd > now(),
    ...(joinEnd !== null && joinEnd > now() ? { permit_join_end: joinEnd } : {}),
  });

  const publishBridge = () => {
    publish(`${BASE}/bridge/info`, info(), true);
    publish(`${BASE}/bridge/devices`, [{ ieee_address: '0x00124b0000000001', type: 'Coordinator', friendly_name: 'Coordinator', supported: true, interview_state: 'SUCCESSFUL' }, ...devices], true);
    publish(`${BASE}/bridge/groups`, groups, true);
  };

  const nameOf = (key: string) => devices.find((d) => ieeeKey(d.ieee_address) === key)?.friendly_name ?? ieeeOf(key);

  /** What a device reports, as Zigbee2MQTT publishes it: everything, cached — and its groups' state, worked out from their members (optimistic, as Zigbee2MQTT does). */
  const report = (key: string) => {
    const state = states.get(key) ?? {};
    publish(`${BASE}/${nameOf(key)}`, state);
    if (options.availability !== false) publish(`${BASE}/${nameOf(key)}/availability`, { state: 'online' }, true);
    for (const group of groups) if (group.members.some((member) => ieeeKey(member.ieee_address) === key)) reportGroup(group);
  };

  const reportGroup = (group: Group) => {
    const members = group.members.map((member) => states.get(ieeeKey(member.ieee_address) ?? '') ?? {});
    if (!members.length) return;
    // On while any member is; a light's brightness and colour as its first member has them.
    const light = Object.fromEntries(['brightness', 'color_temp', 'color'].flatMap((property) => (property in members[0]! ? [[property, members[0]![property]]] : [])));
    publish(`${BASE}/${group.friendly_name}`, { state: members.some((member) => member.state === 'ON') ? 'ON' : 'OFF', ...light });
  };

  /** A value of each thing it exposes — on, its least, its first choice — before the figures a played device of its kind says. */
  const valueOf = (expose: Expose): unknown => {
    switch (expose.type) {
      case 'binary':
        return expose.name === 'state' ? expose.value_on : expose.value_off;
      case 'numeric':
        return expose.value_min ?? 0;
      case 'enum':
        return expose.values?.[0];
      case 'text':
        return '';
      case 'composite':
        return Object.fromEntries((expose.features ?? []).map((feature) => [feature.property ?? feature.name, valueOf(feature)]));
      default:
        return undefined;
    }
  };

  const initial = (d: BridgeDevice): State => {
    const exposes = d.definition?.exposes ?? [];
    const state: State = {};
    for (const expose of exposes) {
      for (const each of expose.features && expose.type !== 'composite' ? expose.features : [expose]) {
        const property = each.property ?? each.name;
        // What is only set — a cover's command — is not part of what it says; nor is a press.
        if (!property || each.name === 'action' || ((each.access ?? 1) & 1) === 0) continue;
        const value = valueOf(each);
        if (value !== undefined) state[property] = value;
      }
    }
    const has = (name: string) => JSON.stringify(exposes).includes(`"name":"${name}"`);
    if ('linkquality' in state) state.linkquality = 120;
    if (has('power')) Object.assign(state, { power: 42, current: 0.19, voltage: 231, energy: 1.25, power_outage_memory: 'restore', child_lock: 'UNLOCK' });
    if (has('temperature')) Object.assign(state, { temperature: 21.4, humidity: 48, battery: 92, voltage: 2950 });
    if (has('brightness')) Object.assign(state, { brightness: 200, color_temp: 370, color: { x: 0.46, y: 0.41 } });
    if (has('local_temperature')) Object.assign(state, { local_temperature: 20.5, occupied_heating_setpoint: 21 });
    if (has('battery')) state.battery = 92;
    return state;
  };

  for (const d of devices) states.set(ieeeKey(d.ieee_address)!, initial(d));

  /** A `/set`: what it changes, and a plug's meter following its relay. */
  const apply = (key: string, values: State) => {
    const state = { ...(states.get(key) ?? {}) };
    for (const [property, value] of Object.entries(values)) {
      state[property] = property.startsWith('state') && value === 'TOGGLE' ? (state[property] === 'ON' ? 'OFF' : 'ON') : value;
    }
    if ('power' in state && 'state' in state) Object.assign(state, state.state === 'ON' ? { power: 42, current: 0.19 } : { power: 0, current: 0 });
    states.set(key, state);
  };

  const respond = (what: string, request: Record<string, unknown>, data: unknown, error?: string) => {
    publish(`${BASE}/bridge/response/${what}`, error ? { data: {}, status: 'error', error, transaction: request.transaction } : { data, status: 'ok', transaction: request.transaction });
  };

  const groupOf = (name: unknown) => groups.find((group) => group.friendly_name === name || String(group.id) === String(name));

  const request = (what: string, body: Record<string, unknown>) => {
    switch (what) {
      case 'permit_join': {
        const time = Number(body.time ?? 0);
        joinEnd = time > 0 ? now() + time * 1000 : null;
        // Answered first, its info said a moment after: as Zigbee2MQTT does.
        respond(what, body, { time });
        later(20, () => publish(`${BASE}/bridge/info`, info(), true));
        // Someone presses the next device's button: it joins, and is interviewed a moment later.
        if (time > 0 && joined < JOINERS.length) {
          const joining = JOINERS[joined++]!();
          later(stepMs, () => {
            if (joinEnd === null) return;
            const { definition: _definition, ...bare } = joining;
            devices.push({ ...bare, interview_state: 'IN_PROGRESS' });
            publish(`${BASE}/bridge/event`, { type: 'device_joined', data: { friendly_name: joining.friendly_name, ieee_address: joining.ieee_address } });
            publishBridge();
            later(stepMs, () => {
              const at = devices.findIndex((d) => d.ieee_address === joining.ieee_address);
              if (at < 0) return;
              devices[at] = joining;
              states.set(ieeeKey(joining.ieee_address)!, initial(joining));
              publish(`${BASE}/bridge/event`, { type: 'device_interview', data: { friendly_name: joining.friendly_name, ieee_address: joining.ieee_address, status: 'successful', supported: true } });
              publishBridge();
              report(ieeeKey(joining.ieee_address)!);
            });
          });
        }
        return;
      }
      case 'health_check':
        return respond(what, body, { healthy: true });
      case 'backup':
        return respond(what, body, { zip: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' });
      case 'device/remove': {
        const key = keyOf(String(body.id ?? ''));
        if (!key) return respond(what, body, {}, `Device '${String(body.id)}' does not exist`);
        devices.splice(devices.findIndex((d) => ieeeKey(d.ieee_address) === key), 1);
        for (const group of groups) group.members = group.members.filter((member) => ieeeKey(member.ieee_address) !== key);
        publishBridge();
        return respond(what, body, { id: body.id, block: false, force: Boolean(body.force) });
      }
      case 'group/add': {
        const name = String(body.friendly_name ?? '');
        if (!name || groupOf(name)) return respond(what, body, {}, `Group '${name}' already exists`);
        const id = typeof body.id === 'number' ? body.id : Math.max(0, ...groups.map((group) => group.id)) + 1;
        groups.push({ id, friendly_name: name, members: [], scenes: [] });
        publishBridge();
        return respond(what, body, { friendly_name: name, id });
      }
      case 'group/remove': {
        const group = groupOf(body.id);
        if (!group) return respond(what, body, {}, `Group '${String(body.id)}' does not exist`);
        groups.splice(groups.indexOf(group), 1);
        publishBridge();
        return respond(what, body, { id: body.id });
      }
      case 'group/rename': {
        const group = groupOf(body.from);
        if (!group) return respond(what, body, {}, `Group '${String(body.from)}' does not exist`);
        group.friendly_name = String(body.to);
        publishBridge();
        return respond(what, body, { from: body.from, to: body.to });
      }
      case 'group/members/add':
      case 'group/members/remove': {
        const group = groupOf(body.group);
        const key = keyOf(String(body.device ?? ''));
        if (!group) return respond(what, body, {}, `Group '${String(body.group)}' does not exist`);
        if (!key) return respond(what, body, {}, `Device '${String(body.device)}' does not exist`);
        const endpoint = Number(body.endpoint ?? 1) || 1;
        const others = group.members.filter((member) => !(ieeeKey(member.ieee_address) === key && member.endpoint === endpoint));
        group.members = what.endsWith('add') ? [...others, { ieee_address: ieeeOf(key), endpoint }] : others;
        publishBridge();
        return respond(what, body, { device: body.device, endpoint: body.endpoint ?? 'default', group: body.group });
      }
      default:
        return respond(what, body, {}, `Request '${what}' is not played`);
    }
  };

  const hear = (topic: string, payload: Uint8Array) => {
    const body = objectOf(parseJson(payload)) ?? {};
    heard.push({ topic, payload: body });
    if (!online) return;
    const parsed = parseTopic(topic);
    if (!parsed) return;
    if ('bridge' in parsed) {
      if (parsed.bridge.startsWith('request/')) request(parsed.bridge.slice('request/'.length), body);
      return;
    }
    const group = groupOf(parsed.name);
    if (group && parsed.verb === 'set') {
      for (const member of group.members) {
        const key = ieeeKey(member.ieee_address)!;
        apply(key, body);
        report(key);
      }
      publish(`${BASE}/${group.friendly_name}`, body);
      return;
    }
    const key = keyOf(parsed.name);
    if (!key) return;
    if (parsed.verb === 'set') apply(key, body);
    if (parsed.verb === 'set' || parsed.verb === 'get') report(key);
  };

  const channel: PlayedZigbee2Mqtt['channel'] = {
    kind: 'messages',
    get connected() {
      return connected;
    },
    onConnectedChange(listener) {
      connectedListeners.add(listener);
      return () => void connectedListeners.delete(listener);
    },
    subscribe(filter, listener) {
      const entry = { filter, listener };
      subscriptions.push(entry);
      // What it keeps, first — as a broker sends a new subscription.
      const kept = [...retained].filter(([topic]) => matches(filter, topic));
      queueMicrotask(() => {
        for (const [topic, payload] of kept) if (subscriptions.includes(entry)) listener({ topic, payload, at: new Date(now()).toISOString(), retained: true });
      });
      return () => void subscriptions.splice(subscriptions.indexOf(entry), 1);
    },
    async publish(topic, payload) {
      if (!connected) throw new Error('Not connected to the broker');
      hear(topic, payload);
    },
    setConnected(next) {
      connected = next;
      for (const listener of connectedListeners) listener(next);
    },
    async close() {
      // The channel is the coordinator's; the played network goes on until stopped.
    },
  };

  publish(`${BASE}/bridge/state`, { state: 'online' }, true);
  publishBridge();
  // As Zigbee2MQTT sends what it cached when it starts: every device's state, once, not kept.
  for (const d of devices) report(ieeeKey(d.ieee_address)!);

  return {
    channel,
    heard,
    say(key, values, retain = false) {
      apply(key, values);
      const state = states.get(key) ?? {};
      publish(`${BASE}/${nameOf(key)}`, { ...state, ...values }, retain);
      // A press is said once; what is kept of the device is not a press.
      if ('action' in values) states.set(key, Object.fromEntries(Object.entries(state).filter(([property]) => property !== 'action')));
    },
    setOnline(next) {
      online = next;
      publish(`${BASE}/bridge/state`, { state: next ? 'online' : 'offline' }, true);
    },
    devices: () => devices,
    groups: () => groups,
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
