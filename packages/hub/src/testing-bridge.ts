import { defineDeviceType, MAIN_PART, type ChannelMessage, type DeviceContext, type DeviceSession, type MessageChannel, type Protocol } from '@kraftverk/device-sdk';

import { LAMP } from './testing.ts';

/*
  A hub — an account of the tests' own, a bridge — and lamps behind it,
  reached through it (docs/PLAN-INTEGRATIONS.md §4.3). Tests only. The hub's
  session brings two lamps; each lamp's real session speaks the relay
  protocol over the channel the hub opens for it, as a scooter's speaks over
  its account's.
*/

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** What is behind the hub: the state it keeps of each lamp, and which channels it opened and closed. */
export type HubWatch = { lamps: Map<string, { name: string; on: boolean }>; opened: string[]; closed: string[] };

/** The relay: a lamp's state on "state", and "set" to switch it — over a bridge, and only there. */
export const relayProtocol: Protocol = {
  id: 'test-relay',
  label: 'Lampish relay',
  bindings: { bridge: { open: () => ({}), recognise: () => null } },
};

function relayChannel(watch: HubWatch, key: string): MessageChannel {
  const listeners = new Set<(message: ChannelMessage) => void>();
  const say = () => {
    const lamp = watch.lamps.get(key);
    const message: ChannelMessage = { topic: 'state', payload: encode(JSON.stringify({ on: lamp?.on ?? null })), at: new Date().toISOString() };
    for (const listener of listeners) listener(message);
  };
  watch.opened.push(key);
  return {
    kind: 'messages',
    get connected() {
      return watch.lamps.has(key);
    },
    onConnectedChange: () => () => {},
    async publish(topic, payload) {
      const lamp = watch.lamps.get(key);
      if (!lamp) throw new Error('No such lamp behind the hub');
      if (topic === 'set') lamp.on = (JSON.parse(decode(payload)) as { on: boolean }).on;
      say();
    },
    subscribe(filter, listener) {
      if (filter !== 'state') return () => {};
      listeners.add(listener);
      queueMicrotask(say);
      return () => listeners.delete(listener);
    },
    async close() {
      watch.closed.push(key);
      listeners.clear();
    },
  };
}

function hubSession(watch: HubWatch): DeviceSession {
  const at = new Date().toISOString();
  return {
    health: () => ({ status: 'connected', detail: 'A hub with its lamps', lastReadingAt: at }),
    readings: () => [{ key: 'members', value: watch.lamps.size, at }],
    async command() {
      return { accepted: false, error: 'A hub takes no commands' };
    },
    bridge: {
      members: () => [...watch.lamps].map(([key, lamp]) => ({ key, name: lamp.name, model: 'R1', identity: null, typeId: 'test.relayed-lamp' })),
      onMembersChange: () => () => {},
      open: async (key) => relayChannel(watch, key),
    },
    close: async () => {},
  };
}

/** A hub type, and what a test sees behind it: its own, so nothing is shared between tests through the module. */
export function makeHubType(): { type: ReturnType<typeof defineDeviceType>; watch: HubWatch } {
  const watch: HubWatch = {
    lamps: new Map([
      ['lamp-a', { name: 'Lamp A', on: false }],
      ['lamp-b', { name: 'Lamp B', on: true }],
    ]),
    opened: [],
    closed: [],
  };
  const type = defineDeviceType({
    id: 'test.hub',
    kind: 'account',
    meta: { name: 'Test hub', category: 'smart-plug', support: 'experimental', icon: 'server' },
    describe: () => ({
      parts: [{ id: MAIN_PART, label: 'Hub', kind: 'device' }],
      attributes: [{ key: 'members', label: 'Lamps', value: { type: 'number', integer: true }, category: 'diagnostic' }],
    }),
    config: { fields: {} },
    bridge: { fallback: 'test.relayed-lamp' },
    connections: [{ id: 'bus', label: 'Test bus', protocol: 'test-lamp', transport: 'bus', reach: 'local' }],
    async identify() {
      return { identity: 'hub:1', model: null, summary: 'A hub.' };
    },
    async createSession() {
      return hubSession(watch);
    },
    async createSimulator() {
      return hubSession(watch);
    },
  });
  return { type, watch };
}

/** A lamp's session over the relay: its state as the hub says it, and "set" to switch it. */
function relayedSession(ctx: DeviceContext): DeviceSession {
  const channel = ctx.connection?.channel;
  let state: { on: boolean; at: string } | null = channel ? null : { on: false, at: new Date().toISOString() };
  const stop =
    channel?.kind === 'messages'
      ? channel.subscribe('state', (message) => {
          const said = JSON.parse(decode(message.payload)) as { on: boolean | null };
          state = said.on === null ? null : { on: said.on, at: message.at };
          ctx.changed();
        })
      : () => {};
  return {
    health: () => ({ status: !channel || channel.connected ? 'connected' : 'offline', detail: channel ? 'Through the hub' : 'Simulated', lastReadingAt: state?.at ?? null }),
    readings: () => (state ? [{ key: 'on', value: state.on, at: state.at }] : []),
    async command(request) {
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'A lamp only switches' };
      if (ctx.readOnly) return { accepted: false, error: 'Read-only' };
      if (channel?.kind === 'messages') await channel.publish('set', encode(JSON.stringify({ on: request.args.on })));
      else state = { on: request.args.on, at: new Date().toISOString() };
      return { accepted: true };
    },
    close: async () => stop(),
  };
}

/** A lamp reached only through the hub: a member of it. */
export const relayedLampType = defineDeviceType({
  id: 'test.relayed-lamp',
  kind: 'hardware',
  meta: { name: 'Relayed lamp', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['R1'] },
  describe: () => LAMP,
  config: { fields: {} },
  connections: [{ id: 'hub', label: 'Through the hub', protocol: 'test-relay', transport: 'bridge', through: ['test.hub'], reach: 'local' }],
  async identify() {
    return { identity: null, model: 'R1', summary: 'A lamp behind the hub.' };
  },
  async createSession(ctx) {
    return relayedSession(ctx);
  },
  async createSimulator(ctx) {
    return relayedSession(ctx);
  },
});
