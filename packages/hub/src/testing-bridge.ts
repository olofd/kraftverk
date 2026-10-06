import { defineDeviceType, linkOf, MAIN_PART, type Bridge, type DeviceContext, type DeviceSession, type MemberLink } from '@kraftverk/device-sdk';

import { LAMP } from './testing.ts';

/*
  A hub — an account of the tests' own, a bridge — and lamps behind it,
  reached through it (docs/PLAN-INTEGRATIONS.md §4.3). Tests only. The hub's
  session brings two lamps; each lamp's real session reads and switches its
  lamp through the link the hub hands it, as a scooter reads its account.
*/

/** What is behind the hub: the state it keeps of each lamp, and which links it handed out and had back. */
export type HubWatch = { lamps: Map<string, { name: string; on: boolean }>; opened: string[]; closed: string[] };

/** What a lamp reads and asks through its hub: plain calls. */
export type RelayLink = MemberLink & {
  /** Whether it is on, as the hub knows; null when it is no longer behind it. */
  on(): boolean | null;
  /** Switches it, and says so to whoever is linked. */
  set(on: boolean): Promise<void>;
};

function hubBridge(watch: HubWatch): Bridge<RelayLink> {
  return {
    members: () => [...watch.lamps].map(([key, lamp]) => ({ key, name: lamp.name, model: 'R1', identity: null, typeId: 'test.relayed-lamp' })),
    async link(key, changed) {
      if (!watch.lamps.has(key)) throw new Error('No such lamp behind the hub');
      watch.opened.push(key);
      let open = true;
      queueMicrotask(() => open && changed());
      return {
        on: () => watch.lamps.get(key)?.on ?? null,
        async set(on) {
          const lamp = watch.lamps.get(key);
          if (!lamp) throw new Error('No such lamp behind the hub');
          lamp.on = on;
          if (open) changed();
        },
        close() {
          open = false;
          watch.closed.push(key);
        },
      };
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
    bridge: hubBridge(watch),
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

/** A lamp's session through its hub: its state as the hub says it, switched through it. */
async function relayedSession(ctx: DeviceContext): Promise<DeviceSession> {
  const lamp = ctx.connection ? await linkOf<RelayLink>(ctx.connection, () => ctx.changed(), 'A relayed lamp is reached through its hub') : null;
  let simulated = { on: false, at: new Date().toISOString() };
  const at = new Date().toISOString();
  return {
    health: () => ({ status: !lamp || lamp.on() !== null ? 'connected' : 'offline', detail: lamp ? 'Through the hub' : 'Simulated', lastReadingAt: lamp ? at : simulated.at }),
    readings: () => {
      if (!lamp) return [{ key: 'on', value: simulated.on, at: simulated.at }];
      const on = lamp.on();
      return on === null ? [] : [{ key: 'on', value: on, at: new Date().toISOString() }];
    },
    async command(request) {
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'A lamp only switches' };
      if (ctx.readOnly) return { accepted: false, error: 'Read-only' };
      if (lamp) await lamp.set(request.args.on);
      else simulated = { on: request.args.on, at: new Date().toISOString() };
      return { accepted: true };
    },
    close: async () => lamp?.close(),
  };
}

/** A lamp reached only through the hub: a member of it. */
export const relayedLampType = defineDeviceType({
  id: 'test.relayed-lamp',
  kind: 'hardware',
  meta: { name: 'Relayed lamp', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['R1'] },
  describe: () => LAMP,
  config: { fields: {} },
  connections: [{ id: 'hub', label: 'Through the hub', through: ['test.hub'], reach: 'local' }],
  async identify(connection) {
    const lamp = await linkOf<RelayLink>(connection, () => {}, 'A relayed lamp is reached through its hub');
    return { identity: null, model: 'R1', summary: `A lamp behind the hub, ${lamp.on() ? 'on' : 'off'}.` };
  },
  async createSession(ctx) {
    return relayedSession(ctx);
  },
  async createSimulator(ctx) {
    return relayedSession(ctx);
  },
});
