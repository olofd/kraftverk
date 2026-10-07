import type { BrokerMessageNote, MessageBrokerPolicy } from '@kraftverk/device-sdk';

import { ieeeOf, objectOf, parseJson } from './wire.ts';

/*
  Zigbee2MQTT's topics, and what the broker applies to them
  (docs/PLAN-ZIGBEE.md §5.1): every topic under its base is the
  coordinator's; only the server commands a device; only Zigbee2MQTT, signed
  in, speaks for one; and the requests that would change the network itself
  are refused to everyone, the server included.
*/

/** Zigbee2MQTT's base topic, as the deploy sets it (`docker-compose.yml`). The coordinator's address on the broker. */
export const BASE = 'zigbee2mqtt';

const ROOT = `${BASE}/`;

export const TOPIC = {
  /** Everything Zigbee2MQTT says. */
  all: `${BASE}/#`,
  bridgeState: `${BASE}/bridge/state`,
  bridgeInfo: `${BASE}/bridge/info`,
  bridgeDevices: `${BASE}/bridge/devices`,
  bridgeGroups: `${BASE}/bridge/groups`,
  bridgeEvent: `${BASE}/bridge/event`,
  /** A device addressed by its IEEE address, which Zigbee2MQTT resolves as it resolves a friendly name. */
  set: (key: string) => `${BASE}/${ieeeOf(key)}/set`,
  get: (key: string) => `${BASE}/${ieeeOf(key)}/get`,
  /** A group, by its friendly name: what its state is published under. */
  groupSet: (name: string) => `${BASE}/${name}/set`,
  request: (what: string) => `${BASE}/bridge/request/${what}`,
  response: (what: string) => `${BASE}/bridge/response/${what}`,
} as const;

/**
 * The bridge requests kraftverk sends (§5.5). Every other — its settings
 * (the network key among them), a restart, touchlink, install codes,
 * extensions, external converters — is refused at the broker to everyone:
 * the deploy configures Zigbee2MQTT, never kraftverk at run time.
 */
export const ALLOWED_REQUESTS: readonly string[] = [
  'permit_join',
  'health_check',
  'backup',
  'device/remove',
  'device/interview',
  'device/configure',
  'device/options',
  'device/ota_update/check',
  'device/ota_update/update',
  'group/add',
  'group/remove',
  'group/rename',
  'group/members/add',
  'group/members/remove',
];

/** What a topic under the base is about: the bridge's, or a device's (or group's) by name, and what is asked of it. */
export function parseTopic(topic: string): { bridge: string } | { name: string; verb: 'state' | 'set' | 'get' | 'availability' | 'other'; rest: string } | null {
  if (!topic.startsWith(ROOT)) return null;
  const rest = topic.slice(ROOT.length);
  if (rest.startsWith('bridge/')) return { bridge: rest.slice('bridge/'.length) };
  const segments = rest.split('/');
  // `<name>[/<endpoint>]/(set|get)[/<attribute>]`: the verb is the last segment or the one before it.
  for (const back of [1, 2]) {
    const verb = segments[segments.length - back];
    if ((verb === 'set' || verb === 'get') && segments.length > back) {
      return { name: segments.slice(0, segments.length - back).join('/'), verb, rest: segments.slice(segments.length - back + 1).join('/') };
    }
  }
  if (segments[segments.length - 1] === 'availability' && segments.length > 1) return { name: segments.slice(0, -1).join('/'), verb: 'availability', rest: '' };
  return { name: rest, verb: 'state', rest: '' };
}

const text = (payload: Uint8Array, max = 160): string => {
  const said = new TextDecoder().decode(payload.subarray(0, max));
  return payload.length > max ? `${said}…` : said;
};

/** What the broker applies for Zigbee2MQTT. See `MessageBrokerPolicy`. */
export const brokerPolicy: MessageBrokerPolicy = {
  protocol: 'zigbee2mqtt',
  root: ROOT,
  signedIn: true,

  fromDevice(topic) {
    return topic.startsWith(ROOT) ? { address: BASE, channel: topic.slice(ROOT.length) } : null;
  },

  subscribedBy(filter) {
    return filter.startsWith(ROOT) || filter === BASE ? BASE : null;
  },

  commandFor(topic) {
    const parsed = parseTopic(topic);
    if (!parsed) return null;
    if ('bridge' in parsed) return parsed.bridge.startsWith('request/') ? BASE : null;
    return parsed.verb === 'set' || parsed.verb === 'get' ? BASE : null;
  },

  refuse(topic) {
    const parsed = parseTopic(topic);
    if (parsed && 'bridge' in parsed && parsed.bridge.startsWith('request/')) {
      const what = parsed.bridge.slice('request/'.length);
      if (!ALLOWED_REQUESTS.includes(what)) return `Zigbee2MQTT's "${what}" is never sent: it changes the Zigbee network or Zigbee2MQTT itself, which only its deploy configures`;
    }
    return null;
  },

  describeCommand(topic, payload): BrokerMessageNote {
    const parsed = parseTopic(topic);
    if (parsed && 'bridge' in parsed) return { summary: `${parsed.bridge.replace(/^request\//, '')} ${text(payload)}`, level: 'info' };
    if (parsed && parsed.verb === 'get') return { summary: `get ${parsed.name} ${text(payload)}`, level: 'debug' };
    return { summary: `set ${parsed && 'name' in parsed ? parsed.name : topic} ${text(payload)}`, level: 'info' };
  },

  describeMessage(channel, payload): BrokerMessageNote {
    if (channel === 'bridge/state') {
      const state = objectOf(parseJson(payload))?.state ?? text(payload);
      return { summary: `Zigbee2MQTT is ${String(state)}`, level: 'info' };
    }
    if (channel === 'bridge/devices') {
      const devices = parseJson(payload);
      return { summary: `its devices: ${Array.isArray(devices) ? devices.length : '?'}`, level: 'info' };
    }
    if (channel === 'bridge/groups') {
      const groups = parseJson(payload);
      return { summary: `its groups: ${Array.isArray(groups) ? groups.length : '?'}`, level: 'info' };
    }
    if (channel === 'bridge/event' || channel.startsWith('bridge/response/')) return { summary: `${channel.slice('bridge/'.length)} ${text(payload)}`, level: 'info' };
    if (channel.startsWith('bridge/')) return { summary: `${channel.slice('bridge/'.length)} (${payload.length} B)`, level: 'debug' };
    // A device's state, many times a minute: in the file, not the console.
    return { summary: `${channel} ${text(payload, 120)}`, level: 'debug' };
  },

  absenceAdvice: 'Zigbee2MQTT is not connected: is its container running, signed in with its password, and is the dongle plugged in?',
};
