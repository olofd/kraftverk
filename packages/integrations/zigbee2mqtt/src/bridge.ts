import {
  channelOf,
  defineDeviceType,
  MAIN_PART,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type MessageChannel,
  type Reading,
  type SessionHealth,
  type ToolSpec,
} from '@kraftverk/device-sdk';

import { ZigbeeNetwork } from './network.ts';
import { playedZigbee2Mqtt } from './played.ts';
import { TOPIC, type BridgeInfo } from './protocol/index.ts';

/**
 * The coordinator: Zigbee2MQTT and the dongle it drives, as a gateway
 * (docs/PLAN-ZIGBEE.md §5.2). One conversation over this server's broker
 * for the whole network — its devices and groups are its members, each read
 * through a link — devices let to join, and the network's own tools: a
 * backup, removing a device, and its groups.
 */

type Config = Record<string, never>;

/** How long identifying waits for Zigbee2MQTT's retained `bridge/info`. */
const IDENTIFY_WAIT_MS = 5000;

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Coordinator', kind: 'device', icon: 'share-2' }],
  attributes: [
    { key: 'devices', label: 'Zigbee devices', value: { type: 'number', integer: true, min: 0 }, category: 'diagnostic' },
    { key: 'routers', label: 'Routers', description: 'Devices on mains that pass messages on for others', value: { type: 'number', integer: true, min: 0 }, category: 'diagnostic' },
    { key: 'groups', label: 'Groups', value: { type: 'number', integer: true, min: 0 }, category: 'diagnostic' },
    { key: 'version', label: 'Zigbee2MQTT', value: { type: 'string' }, category: 'diagnostic' },
    { key: 'channel', label: 'Zigbee channel', value: { type: 'number', min: 11, max: 26 }, category: 'diagnostic' },
    { key: 'updates', label: 'Firmware updates offered', description: 'Devices Zigbee2MQTT’s index offers a newer firmware for: each is updated from its own page', value: { type: 'number', integer: true, min: 0 }, category: 'diagnostic', history: false },
  ],
};

const deviceField = { type: 'string', title: 'Device', description: 'Its IEEE address, or its name in Zigbee2MQTT', required: true } as const;
const groupField = { type: 'string', title: 'Group', description: 'Its name, or its number', required: true } as const;

const TOOLS = {
  backup: {
    label: 'Back up the network',
    description: 'Zigbee2MQTT’s backup of the coordinator and its network — its key, what is paired — as a ZIP, base64: what brings the network back on a new dongle.',
    answer: { type: 'string' },
    // Not a change to the network, but its key goes with it: a person's to ask for, never an assistant's, and on the timeline.
    writes: true,
    confirm: 'The backup holds the Zigbee network’s key: whoever has the file can join and listen to the network. Keep it as safe as a password.',
  },
  removeDevice: {
    label: 'Remove a device from the network',
    description: 'The device leaves the Zigbee network. Forced, it is forgotten even if it does not answer.',
    input: { fields: { device: deviceField, force: { type: 'boolean', title: 'Even if it does not answer', default: false } } },
    answer: { type: 'string' },
    writes: true,
    confirm: 'It leaves the Zigbee network: to use it again, it is paired again.',
  },
  createGroup: {
    label: 'Make a group',
    description: 'A Zigbee group: its devices take one command together — every lamp in a room at once. Add its devices next.',
    input: { fields: { name: { type: 'string', title: 'Name', required: true } } },
    answer: { type: 'string' },
    writes: true,
  },
  groupMember: {
    label: 'Put a device in a group, or take it out',
    description: 'A device with several endpoints — a two-gang switch — is in a group by one of them.',
    input: {
      fields: {
        group: groupField,
        device: deviceField,
        endpoint: { type: 'number', title: 'Endpoint', description: 'Its endpoint number, when it has several', min: 1, max: 240 },
        remove: { type: 'boolean', title: 'Take it out', default: false },
      },
    },
    answer: { type: 'string' },
    writes: true,
  },
  removeGroup: {
    label: 'Remove a group',
    description: 'The group goes; its devices stay, each its own.',
    input: { fields: { group: groupField } },
    answer: { type: 'string' },
    writes: true,
    confirm: 'The group goes, and an automation that switches it can no longer.',
  },
} as const satisfies Record<string, ToolSpec>;

/**
 * What of its settings the integration relies on and it runs without, said
 * in its health so a deploy that missed one shows: each device's state kept
 * on the broker, whether each answers, and when each last spoke. Nothing
 * before it has said its settings.
 */
function missingSettings(info: BridgeInfo | null): string[] {
  const config = info?.config;
  if (!config) return [];
  const availability = typeof config.availability === 'object' ? config.availability.enabled : config.availability;
  return [
    ...(config.device_options?.retain === true ? [] : ['its devices’ state is not kept on the broker (device_options.retain): a restart forgets a quiet sensor until it speaks']),
    ...(availability === true ? [] : ['it does not say whether each device answers (availability)']),
    ...(config.advanced?.last_seen && config.advanced.last_seen !== 'disable' ? [] : ['it does not say when each device last spoke (advanced.last_seen)']),
  ];
}

/** Its readings, from what Zigbee2MQTT said. */
function readingsOf(network: ZigbeeNetwork, at: string): Reading[] {
  const info: BridgeInfo | null = network.info;
  const devices = network.devices();
  return [
    { key: 'devices', value: devices.length, at },
    { key: 'routers', value: devices.filter((device) => device.type === 'Router').length, at },
    { key: 'groups', value: network.groups().length, at },
    { key: 'version', value: info?.version ?? null, at },
    { key: 'channel', value: info?.network?.channel ?? null, at },
    { key: 'updates', value: network.firmware.offered, at },
  ];
}

const said = (data: unknown): string => (typeof data === 'object' && data !== null ? JSON.stringify(data) : String(data ?? 'Done'));

/** A coordinator's session over a channel to Zigbee2MQTT: the real one's, through the broker, and the simulator's, to a played one. */
function sessionOver(channel: MessageChannel, ctx: DeviceContext<Config>, simulated: boolean, close: () => Promise<void>): DeviceSession {
  const network = new ZigbeeNetwork(channel, { changed: () => ctx.changed(), log: (message) => ctx.log.info(message), now: () => ctx.clock.now() });
  network.start();
  const unwatch = channel.onConnectedChange(() => ctx.changed());
  // While devices may join, its countdown is read again; when it ends, it ends without a word from Zigbee2MQTT.
  ctx.schedule(5000, () => {
    if (network.join.until() !== null || network.info?.permit_join) ctx.changed();
  });
  const at = () => network.heardAt ?? new Date(ctx.clock.now()).toISOString();

  const health = (): SessionHealth => {
    if (!channel.connected) return { status: 'offline', detail: 'Zigbee2MQTT has not connected to this server’s broker', lastReadingAt: network.heardAt };
    if (network.bridgeOnline === false) return { status: 'offline', detail: 'Zigbee2MQTT is not running: is its container up, and the dongle plugged in?', lastReadingAt: network.heardAt };
    if (network.bridgeOnline === null) return { status: 'connecting', detail: 'Waiting for Zigbee2MQTT to say it is there', lastReadingAt: null };
    const count = network.devices().length;
    const info = network.info;
    const parts = [
      count === 1 ? '1 Zigbee device' : `${count} Zigbee devices`,
      ...(simulated ? ['simulated'] : info?.version ? [`Zigbee2MQTT ${info.version}`] : []),
      ...(info?.network?.channel ? [`channel ${info.network.channel}`] : []),
      ...(simulated ? [] : missingSettings(info)),
    ];
    // A firmware being written is said: restarting Zigbee2MQTT now would stop it.
    const { updating, waiting } = network.firmware;
    if (updating) parts.push(`updating a device’s firmware${updating.progress !== null ? ` (${Math.round(updating.progress)} %)` : ''}${waiting ? `, ${waiting} waiting` : ''}`);
    return { status: 'connected', detail: parts.join(' · '), lastReadingAt: at() };
  };

  const tools = {
    backup: async () => said((await network.request('backup', {}, 30_000)) as unknown),
    removeDevice: async (input: Record<string, unknown>) => {
      await network.request('device/remove', { id: String(input.device), force: input.force === true });
      return `${String(input.device)} left the Zigbee network`;
    },
    createGroup: async (input: Record<string, unknown>) => {
      const data = (await network.request('group/add', { friendly_name: String(input.name) })) as { id?: number } | null;
      return `Group "${String(input.name)}" made${data?.id !== undefined ? `, number ${data.id}` : ''}: add its devices next`;
    },
    groupMember: async (input: Record<string, unknown>) => {
      const remove = input.remove === true;
      await network.request(remove ? 'group/members/remove' : 'group/members/add', {
        group: String(input.group),
        device: String(input.device),
        ...(typeof input.endpoint === 'number' ? { endpoint: input.endpoint } : {}),
      });
      return remove ? `${String(input.device)} is out of "${String(input.group)}"` : `${String(input.device)} is in "${String(input.group)}"`;
    },
    removeGroup: async (input: Record<string, unknown>) => {
      await network.request('group/remove', { id: String(input.group) });
      return `Group "${String(input.group)}" removed`;
    },
  };

  return {
    health,
    readings: () => readingsOf(network, at()),
    info: () => ({ manufacturer: 'Zigbee2MQTT', ...(network.info?.coordinator?.type ? { model: network.info.coordinator.type } : {}), ...(network.info?.version ? { firmware: { main: network.info.version } } : {}) }),
    identity: () => ({ id: network.identity, name: null }),
    command: async () => ({ accepted: false, error: 'A coordinator takes no commands: the devices behind it are devices of their own' }),
    bridge: network,
    tools,
    close: async () => {
      unwatch();
      network.close();
      await close();
    },
  };
}

export default defineDeviceType<Config>({
  id: 'zigbee2mqtt.bridge',
  kind: 'gateway',
  meta: {
    name: 'Zigbee2MQTT',
    brand: 'Zigbee2MQTT',
    category: 'gateway',
    icon: 'share-2',
    description: 'A Zigbee USB dongle on this server, driven by Zigbee2MQTT beside it: every Zigbee plug, switch, light and sensor paired with it, and its groups.',
    support: 'experimental',
    supportNote: 'Written for Zigbee2MQTT 2.x with a Sonoff ZBDongle-P (Z-Stack); tested against a played Zigbee2MQTT until the dongle is up.',
  },
  config: { fields: {} },
  // A device behind it whose shelf it cannot tell: a sensor, until it says more.
  bridge: { fallback: 'zigbee2mqtt.sensor' },
  tools: TOOLS,
  describe: () => DESCRIPTION,
  connections: [
    {
      id: 'mqtt',
      label: 'This server’s broker',
      description: 'Zigbee2MQTT speaks to this server’s MQTT broker, signed in; it drives the dongle on this machine.',
      protocol: 'zigbee2mqtt',
      transport: 'mqtt',
      reach: 'local',
      updates: 'push',
      recommended: true,
      discovery: [{ kind: 'client', protocol: 'zigbee2mqtt' }],
    },
  ],

  /** Waits for Zigbee2MQTT's retained `bridge/info`: proof that it is on this broker, and the coordinator's own address. */
  async identify(connection, ctx) {
    const channel = channelOf(connection, 'messages', 'Zigbee2MQTT is reached through this server’s broker');
    const info = await new Promise<BridgeInfo | null>((resolve) => {
      const timer = setTimeout(() => {
        stop();
        resolve(null);
      }, IDENTIFY_WAIT_MS);
      const stop = channel.subscribe(TOPIC.bridgeInfo, (message) => {
        clearTimeout(timer);
        stop();
        try {
          resolve(JSON.parse(new TextDecoder().decode(message.payload)) as BridgeInfo);
        } catch {
          resolve(null);
        }
      });
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        stop();
        resolve(null);
      });
    });
    if (!info) throw new Error('Zigbee2MQTT has said nothing on this broker: is it running, and signed in to it?');
    const ieee = String(info.coordinator?.ieee_address ?? '').replace(/^0x/i, '').toLowerCase();
    return {
      identity: /^[0-9a-f]{16}$/.test(ieee) ? `zigbee:${ieee}` : null,
      model: null,
      summary: `Zigbee2MQTT ${info.version ?? ''} answers, its coordinator ${info.coordinator?.type ?? 'there'}${info.network?.channel ? ` on channel ${info.network.channel}` : ''}: the devices paired with it are found through it.`,
      info: { manufacturer: 'Zigbee2MQTT', ...(info.coordinator?.type ? { model: info.coordinator.type } : {}), ...(info.version ? { firmware: { main: info.version } } : {}) },
    };
  },

  createSession: async (ctx) => sessionOver(channelOf(ctx.connection, 'messages', 'Zigbee2MQTT is reached through this server’s broker'), ctx, false, async () => undefined),

  /** A Zigbee network that is not there: a plug that meters, a wall switch and a sensor, and more joining while it lets them. */
  createSimulator: async (ctx) => {
    const played = playedZigbee2Mqtt({ now: () => ctx.clock.now() });
    return sessionOver(played.channel, ctx, true, async () => played.stop());
  },
});
