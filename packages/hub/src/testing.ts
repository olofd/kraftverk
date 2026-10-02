import { fakeByteChannel } from '@kraftverk/device-sdk/testing';
import {
  defineDeviceType,
  MAIN_PART,
  type DeviceDescription,
  type ByteChannel,
  type DeviceContext,
  type DeviceSession,
  type Protocol,
  type Sighting,
  type Transport,
  type TransportDefinition,
} from '@kraftverk/device-sdk';

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
  platforms: ['server'],
  discovery: { server: 'list' },
};

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
    return [...this.lamps.keys()].map((address) => ({ transport: 'bus', address, seenAt: new Date().toISOString(), name: `Lamp ${address}`, facts: { kind: 'lamp' } }));
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

  async open(address: string) {
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
    this.channels.push(channel);
    return channel;
  }
}

export const lampProtocol: Protocol = {
  id: 'lampish',
  label: 'Lampish',
  bindings: {
    bus: {
      open: () => ({}),
      recognise: (sighting) => (sighting.facts.kind === 'lamp' ? { name: sighting.name ?? sighting.address, detail: 'on the bus' } : null),
      parseAddress: (input) => (/^[a-z0-9-]{1,20}$/.test(input.trim()) ? input.trim() : null),
      addressLabel: 'Lamp id',
      instructions: { title: 'Plug the lamp in', body: 'Connect it to {host}.' },
    },
  },
  credentials: {
    schema: { fields: { pin: { type: 'string', presentation: 'secret', title: 'PIN' } } },
    // Finds a secret, as fetching a key from a vendor's cloud does.
    actions: [
      {
        id: 'fetch',
        label: 'Fetch the PIN',
        run: async () => ({ ok: true, detail: 'Found one', choices: [{ id: 'a', label: 'The lamp', config: { pin: 'the-real-secret-value' } }] }),
      },
    ],
  },
};

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

/** Every context the type was opened with, and whether each session was closed. */
export const opened: { ctx: DeviceContext<LampConfig>; closed: boolean }[] = [];
export const lampControl = { failOpen: false };

const lampSession = (ctx: DeviceContext<LampConfig>, channel: ByteChannel | null): DeviceSession => {
  const entry = { ctx, closed: false };
  opened.push(entry);
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
    identity: () => ({ id: state && channel ? `lampish:${state.serial}` : null, name: null }),
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
  attributes: [{ key: 'on', label: 'On', value: { type: 'boolean' }, means: 'switch.on' }],
  events: [{ id: 'bulb.failed', label: 'Bulb failed', level: 'error', description: 'The bulb has gone.' }],
};

export const lampType = defineDeviceType<LampConfig>({
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
    { id: 'bus', label: 'Test bus', protocol: 'lampish', transport: 'bus', reach: 'local', recommended: true },
    { id: 'backup', label: 'Test bus, second port', protocol: 'lampish', transport: 'bus', reach: 'local' },
  ],
  setup: { saveAnyway: 'A lamp that is switched off at the wall cannot answer.' },
  async identify(connection, ctx) {
    const said = await ask(connection.channel as ByteChannel, 'who', 300);
    return { identity: `lampish:${said.serial}`, model: said.model, summary: `It is ${said.on ? 'on' : 'off'}.`, config: ctx.config.room ? {} : { room: 'Hall' } };
  },
  async createSession(ctx) {
    if (lampControl.failOpen) throw new Error('The lamp refused the connection');
    return lampSession(ctx, ctx.connection!.channel as ByteChannel);
  },
  async createSimulator(ctx) {
    return lampSession(ctx, null);
  },
});
