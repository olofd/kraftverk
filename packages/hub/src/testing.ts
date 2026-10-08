import { fakeByteChannel } from '@kraftverk/device-sdk/testing';
import {
  defineDeviceType,
  heardAs,
  nodeId,
  MAIN_PART,
  type DeviceDescription,
  type ByteChannel,
  type DeviceContext,
  type DeviceSession,
  type Protocol,
  type Sighting,
  type Transport,
  type TransportDefinition,
  type TypeSource,
  channelOf,
} from '@kraftverk/device-sdk';

import type { InstalledIntegration, InstalledType } from './installed/from.ts';

/**
 * A device type, a protocol and a transport of the tests' own: a lamp on a
 * pretend bus. They exercise everything the server does with a device —
 * finding it, checking it, reading who it is, opening it, switching it —
 * without naming a product or touching hardware. Tests only.
 */

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A lamp on the bus: what it says when asked who it is, and whether it is on. */
export type FakeLamp = { serial: string; model: string; on: boolean; answers: boolean };

export const busDefinition: TransportDefinition = {
  id: 'bus',
  label: 'the test bus',
  channel: 'bytes',
  exclusive: true,
  // A radio of sorts: the lamp is reached by whoever is near it.
  nearby: true,
  platforms: ['system'],
  discovery: { system: 'list' },
  finds: ['advert'],
  background: false,
};

/** The service a lamp advertises on the bus. */
export const LAMP_SERVICE = '1a2b';

/** The company id a lamp's advert carries its serial under: 0xFFFF, which the Bluetooth SIG keeps for tests. */
const LAMP_MAKER = '65535';

const hexOf = (text: string): string => [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const textOf = (hex: string): string => new TextDecoder().decode(new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))));

/** The bus, with the lamps on it. Add and remove lamps to change what is seen. */
export class FakeBus implements Transport {
  readonly definition = busDefinition;
  lamps = new Map<string, FakeLamp>();
  started = false;
  channels: (ByteChannel & { setConnected(connected: boolean): void })[] = [];
  #watchers = new Set<(sightings: readonly Sighting[]) => void>();

  /** Why it cannot run where the server runs, as a radio missing from a container: null when it can. */
  unavailable: string | null = null;

  available() {
    if (this.unavailable) return { ok: false, reason: this.unavailable } as const;
    return this.started ? ({ ok: true } as const) : ({ ok: false, reason: 'The bus is off' } as const);
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  values() {
    return { host: 'bus.test' };
  }

  sightings(): Sighting[] {
    return [...this.lamps].map(([address, lamp]) => ({
      transport: 'bus',
      address,
      seenAt: new Date().toISOString(),
      name: `Lamp ${address}`,
      heard: [{ kind: 'advert', name: `Lamp ${address}`, services: [LAMP_SERVICE], manufacturer: { [LAMP_MAKER]: hexOf(lamp.serial) } }],
    }));
  }

  /** How many are watching it. */
  get watchers(): number {
    return this.#watchers.size;
  }

  /** Tells whoever is watching that the lamps changed. */
  announce(): void {
    for (const watcher of this.#watchers) watcher(this.sightings());
  }

  watch(_filter: unknown, listener: (sightings: readonly Sighting[]) => void) {
    this.#watchers.add(listener);
    listener(this.sightings());
    return () => void this.#watchers.delete(listener);
  }

  /** What is open now: like every real transport, one channel to an address at a time. */
  #open = new Set<string>();

  async open(address: string) {
    if (this.#open.has(address)) throw new Error(`${address} is already open`);
    const channel = fakeByteChannel((bytes) => {
      const lamp = this.lamps.get(address);
      if (!lamp?.answers) return null;
      const said = decode(bytes);
      if (said === 'who') return encode(`${lamp.serial}|${lamp.model}|${lamp.on ? 1 : 0}`);
      if (said === 'on' || said === 'off') {
        lamp.on = said === 'on';
        return encode(`${lamp.serial}|${lamp.model}|${lamp.on ? 1 : 0}`);
      }
      return null;
    });
    if (!this.lamps.has(address)) channel.setConnected(false);
    this.#open.add(address);
    const close = channel.close.bind(channel);
    channel.close = async () => {
      this.#open.delete(address);
      await close();
    };
    this.channels.push(channel);
    return channel;
  }
}

export const lampProtocol: Protocol = {
  id: 'test-lamp',
  label: 'Lampish',
  bindings: {
    bus: {
      open: () => ({}),
      // A lamp says its serial in its advert: who it is, before anyone asks it.
      recognise: (sighting) => {
        const serial = heardAs(sighting, 'advert').find((advert) => advert.manufacturer[LAMP_MAKER])?.manufacturer[LAMP_MAKER];
        return sighting.name?.startsWith('Lamp ') ? { name: sighting.name, detail: 'on the bus', ...(serial ? { identity: `test-lamp:${textOf(serial)}` } : {}) } : null;
      },
      parseAddress: (input) => (/^[a-z0-9-]{1,20}$/.test(input.trim()) ? input.trim() : null),
      addressLabel: 'Lamp id',
      instructions: { title: 'Plug the lamp in', body: 'Connect it to {host}.' },
    },
  },
  credentials: {
    schema: {
      fields: {
        pin: { type: 'string', presentation: 'secret', title: 'PIN' },
        // A sign-in its session keeps, as a vendor's token is: never asked.
        token: { type: 'string', presentation: 'secret', kept: 'session', title: 'Signed in' },
      },
    },
    // Finds a secret, as fetching a key from a vendor's cloud does.
    actions: [
      {
        id: 'fetch',
        label: 'Fetch the PIN',
        run: async () => ({ ok: true, detail: 'Found one', choices: [{ id: 'a', label: 'The lamp', config: { pin: 'the-real-secret-value' } }] }),
      },
      /*
        Signs in in two turns, as a vendor sending a code to a phone does: the
        first carries what the second needs, and holds a line open for it
        (`ctx.held`) — taken back by the turn that answers, kept again when the
        code is wrong.
      */
      {
        id: 'twoStep',
        label: 'Sign in with a code',
        run: async (ctx, input) => {
          const schema = { fields: { code: { type: 'string' as const, title: 'The code', required: true } } };
          const hold = (line: object) => ctx.held.keep(line, { ttlMs: 60_000, close: () => void HELD_LINES.closed++ });
          if (input.code === undefined) return { ok: true, detail: 'A code was sent to your phone', ask: { schema, carry: { half: 'half-a-sign-in', line: hold({ open: true }) } } };
          if (input.half !== 'half-a-sign-in') return { ok: false, detail: 'What the first turn began was not carried' };
          const line = ctx.held.take<object>(String(input.line));
          if (!line) return { ok: false, detail: 'The line it held was closed' };
          if (input.code !== '123456') return { ok: false, detail: 'That code is not it', ask: { schema, carry: { half: 'half-a-sign-in', line: hold(line) } } };
          return { ok: true, detail: 'Signed in', suggestedConfig: { pin: 'pin-from-a-code' } };
        },
      },
    ],
  },
};

/** How many lines the lamp's two-step sign-in held open were closed for it: by a fresh turn, or by its setup ending. */
export const HELD_LINES = { closed: 0 };

/** Asks a lamp who it is, over any bytes channel. */
async function ask(channel: ByteChannel, what: string, timeoutMs = 500): Promise<{ serial: string; model: string; on: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The lamp did not answer'));
    }, timeoutMs);
    const stop = channel.onData((bytes) => {
      clearTimeout(timer);
      stop();
      const [serial = '', model = '', on = '0'] = decode(bytes).split('|');
      resolve({ serial, model, on: on === '1' });
    });
    channel.write(encode(what)).catch((error: unknown) => {
      clearTimeout(timer);
      stop();
      reject(error as Error);
    });
  });
}

type LampConfig = { room?: string };

/** What a test sees of the lamps it opens: every context a session was opened with, and whether it was closed; and whether opening one fails. */
export type LampWatch = { opened: { ctx: DeviceContext<LampConfig>; closed: boolean }[]; failOpen: boolean; failWith?: Error | null; keepToken?: string };

const lampSession = (ctx: DeviceContext<LampConfig>, channel: ByteChannel | null, watch: LampWatch): DeviceSession => {
  const entry = { ctx, closed: false };
  watch.opened.push(entry);
  let state: { serial: string; on: boolean; at: string } | null = channel ? null : { serial: 'SIM', on: true, at: new Date().toISOString() };
  const poll = async () => {
    if (!channel) return;
    const said = await ask(channel, 'who').catch(() => null);
    if (said) state = { serial: said.serial, on: said.on, at: new Date().toISOString() };
  };
  void poll();
  ctx.schedule(1_000, poll);
  return {
    health: () => ({
      status: !channel || channel.connected ? 'connected' : 'offline',
      detail: `Lamp in ${ctx.config.room ?? 'no room'}`,
      lastReadingAt: state?.at ?? null,
    }),
    readings: () => (state ? [{ key: 'on', value: state.on, at: state.at }] : []),
    async command(request) {
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'A lamp only switches' };
      if (ctx.readOnly) return { accepted: false, error: 'Read-only' };
      const on = request.args.on;
      if (channel) {
        const said = await ask(channel, on ? 'on' : 'off');
        state = { serial: said.serial, on: said.on, at: new Date().toISOString() };
      } else state = { serial: 'SIM', on, at: new Date().toISOString() };
      return { accepted: true };
    },
    identity: () => ({ id: state && channel ? `test-lamp:${state.serial}` : null, name: null }),
    tools: {
      ping: async () => ({ pong: true, room: ctx.config.room ?? null }),
      blink: async (input) => {
        if (input.times === 99) throw new Error('Refused: the lamp would overheat');
        return { blinked: input.times ?? 1 };
      },
    },
    close: async () => {
      entry.closed = true;
    },
  };
};

/** A lamp: one part, a switch. */
export const LAMP: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Lamp', kind: 'light', offers: ['switch'] }],
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'on' }],
  events: [{ id: 'bulb.failed', label: 'Bulb failed', level: 'error', description: 'The bulb has gone.' }],
};

/**
 * A lamp type, and what a test sees of the sessions it opens: its own, so
 * nothing is shared between tests through the module. `lampType` is one
 * made for tests that do not look.
 */
export function makeLampType(): { type: ReturnType<typeof defineDeviceType<LampConfig>>; watch: LampWatch } {
  const watch: LampWatch = { opened: [], failOpen: false };
  const type = defineDeviceType<LampConfig>({
    id: 'test.lamp',
    kind: 'hardware',
    meta: { name: 'Test lamp', category: 'smart-plug', support: 'experimental', icon: 'sun', models: ['L1'] },
    describe: () => LAMP,
    config: { fields: { room: { type: 'string', title: 'Room' } } },
    tools: {
      ping: { label: 'Ping', description: 'Asks the lamp whether it is there.', writes: false, answer: { type: 'object', fields: { pong: { type: 'boolean' }, room: { type: 'string' } }, required: ['pong'] } },
      blink: {
        label: 'Blink',
        description: 'Blinks the lamp.',
        writes: true,
        input: { fields: { times: { type: 'number', title: 'Times', integer: true, min: 1, max: 99, default: 1 } } },
        answer: { type: 'object', fields: { blinked: { type: 'number', integer: true } }, required: ['blinked'] },
      },
    },
    connections: [
      { id: 'bus', label: 'Test bus', protocol: 'test-lamp', transport: 'bus', reach: 'local', updates: 'poll', recommended: true, discovery: [{ kind: 'advert', service: LAMP_SERVICE }] },
      { id: 'backup', label: 'Test bus, second port', protocol: 'test-lamp', transport: 'bus', reach: 'local', updates: 'poll', discovery: [{ kind: 'advert', service: LAMP_SERVICE }] },
    ],
    setup: { saveAnyway: 'A lamp that is switched off at the wall cannot answer.' },
    async identify(connection, ctx) {
      const said = await ask(channelOf(connection, 'bytes', 'A lamp is reached over the bus'), 'who', 300);
      return { identity: `test-lamp:${said.serial}`, model: said.model, summary: `It is ${said.on ? 'on' : 'off'}.`, config: ctx.config.room ? {} : { room: 'Hall' } };
    },
    async createSession(ctx) {
      if (watch.failOpen) throw watch.failWith ?? new Error('The lamp refused the connection');
      // What a session keeps as it runs — a sign-in token — when a test asks it to.
      if (watch.keepToken !== undefined && ctx.connection?.kind === 'direct') ctx.connection.secrets.set('token', watch.keepToken);
      return lampSession(ctx, channelOf(ctx.connection, 'bytes', 'A lamp is reached over the bus'), watch);
    },
    async createSimulator(ctx) {
      return lampSession(ctx, null, watch);
    },
  });
  return { type, watch };
}

export const lampType = makeLampType().type;

/** The platform a test's own types are on: `test`, whose namespace they are all in. */
export const TEST_INTEGRATION = { id: 'test', name: 'Test' } as const;

/** Where a test's type comes from: the test platform's own. */
export const TEST_SOURCE: TypeSource = { integration: TEST_INTEGRATION, product: false };

/** A test's types, as one integration's own, speaking the lamp's protocol: what `installedFrom` is given. */
export const testIntegration = (...types: InstalledType[]): InstalledIntegration => ({ ...TEST_INTEGRATION, protocols: [lampProtocol], types, products: [] });

/** A node that is always on, reachable and trusted, as a machine on the network is: what a test's home runs as. */
export const MACHINE_NODE = { id: nodeId('n-00000000000000a1'), name: 'Test machine', alwaysOn: true, reachable: true, trusted: true };

/** A node in someone's hand, as a browser or a phone is: on while open, reaching out, trusted with nothing that must stay put. */
export const APP_NODE = { id: nodeId('n-00000000000000b2'), name: 'Chrome on a test', alwaysOn: false, reachable: false, trusted: false };
export * from './testing-bridge.ts';
