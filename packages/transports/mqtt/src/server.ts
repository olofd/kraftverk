import type {
  Availability,
  ChannelMessage,
  MessageChannel,
  Sighting,
  Transport,
  TransportContext,
  TransportFactory,
} from '@kraftverk/device-sdk';

import { duration, formatEntry } from './broker/journal.ts';
import { matches } from './broker/broker.ts';
import { brokerToken, type DevicePresence } from './broker/shared.ts';
import { BrokerSupervisor } from './broker/supervisor.ts';
import { BrokerBus, type BusMessage } from './bus.ts';
import { mqttConfig } from './config.ts';
import definition from './index.ts';

/**
 * MQTT, on the server: the broker devices connect to, and the server's
 * privileged connection to it.
 *
 * The broker is a process of its own, so that restarting the server does not
 * drop a device: this attaches to one already running, or starts one detached,
 * and on the way out leaves it be (docs/BROKER.md). A channel is one device's
 * topics on the shared connection — thin, because the bus is shared and every
 * device's messages already arrive on it.
 */

/** Silence this long from a device the broker says nothing about means it has gone. */
const HEARD_WITHIN_MS = 120_000;

/** A device's presence as a sighting: evidence its protocol can recognise. */
const sightingOf = (presence: DevicePresence): Sighting => ({
  transport: 'mqtt',
  address: presence.address,
  seenAt: presence.lastMessageAt ?? presence.connectedAt ?? presence.disconnectedAt ?? new Date().toISOString(),
  facts: {
    protocol: presence.protocol,
    online: presence.online,
    remote: presence.remote,
    connectedAt: presence.connectedAt,
    lastDisconnect: presence.lastDisconnect,
    subscribed: presence.subscribed,
  },
});

class MqttChannel implements MessageChannel {
  readonly kind = 'messages' as const;
  #listeners = new Set<(connected: boolean) => void>();
  #detach: (() => void)[] = [];
  #lastSeen: number | null = null;
  #was: boolean;

  constructor(
    private bus: BrokerBus,
    readonly address: string,
    private release: () => void
  ) {
    const heard = (message: BusMessage) => {
      if (message.topic.toUpperCase().startsWith(`${address.toUpperCase()}/`)) this.#lastSeen = message.at.getTime();
    };
    const recheck = () => this.#recheck();
    bus.on('message', heard);
    bus.on('presence', recheck);
    bus.on('connected', recheck);
    bus.on('disconnected', recheck);
    this.#detach = [
      () => bus.off('message', heard),
      () => bus.off('presence', recheck),
      () => bus.off('connected', recheck),
      () => bus.off('disconnected', recheck),
    ];
    this.#was = this.connected;
  }

  /**
   * Whether this device is reachable right now.
   *
   * The broker knows for certain — it holds the device's socket — and says so
   * on the presence topic. Only when it has said nothing about this device
   * does the older rule apply: live if heard in the last two minutes.
   */
  get connected(): boolean {
    if (!this.bus.connected) return false;
    const presence = this.bus.presence(this.address);
    if (presence) return presence.online;
    return this.#lastSeen !== null && Date.now() - this.#lastSeen < HEARD_WITHIN_MS;
  }

  #recheck(): void {
    const now = this.connected;
    if (now === this.#was) return;
    this.#was = now;
    for (const listener of [...this.#listeners]) listener(now);
  }

  onConnectedChange(listener: (connected: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  publish(topic: string, payload: Uint8Array): Promise<void> {
    return this.bus.publish(topic, payload);
  }

  subscribe(filter: string, listener: (message: ChannelMessage) => void): () => void {
    const onMessage = (message: BusMessage) => {
      if (!matches(filter, message.topic)) return;
      listener({ topic: message.topic, payload: message.payload, at: message.at.toISOString() });
    };
    this.bus.on('message', onMessage);
    return () => void this.bus.off('message', onMessage);
  }

  describe() {
    return { address: this.address, broker: this.bus.presence(this.address) };
  }

  async close(): Promise<void> {
    for (const detach of this.#detach) detach();
    this.#detach = [];
    this.#listeners.clear();
    this.release();
  }
}

const createMqttTransport: TransportFactory = (context: TransportContext): Transport => {
  const config = mqttConfig(context.env);
  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => context.log(level, `[broker] ${message}`);
  const supervisor = new BrokerSupervisor({
    adminUrl: config.adminUrl,
    mqtt: { host: config.brokerHost, port: config.port },
    spawn: config.spawn,
    dir: config.dir,
    env: {
      MQTT_HOST: config.host,
      MQTT_PORT: String(config.port),
      BROKER_ADMIN_PORT: String(config.adminPort),
      BROKER_LOG_LEVEL: config.logLevel,
      KRAFTVERK_BROKER_DIR: config.dir,
    },
    log,
  });
  const bus = new BrokerBus({ host: config.brokerHost, port: config.port, token: () => brokerToken(config.dir) });
  const open = new Set<string>();
  let started = false;

  const admin = async <T>(path: string): Promise<T | null> => {
    try {
      const response = await fetch(`${config.adminUrl}${path}`, {
        headers: { authorization: `Bearer ${brokerToken(config.dir)}` },
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  };

  bus.on('connected', () => log(`Connected to the broker at ${config.brokerHost}:${config.port}`));
  bus.on('disconnected', (error) => log(`Lost the broker${error ? `: ${error.message}` : ''}. Reconnecting…`, 'warn'));
  // Why it cannot connect — refused token, nothing listening, no handshake —
  // once per distinct reason, not per retry.
  bus.on('failed', (error) => log(`Problem with the broker connection: ${error.message}`, 'warn'));

  /*
    What the devices do, in the server's own log. The broker publishes its
    journal's notable entries — connections, subscriptions, writes, disconnects
    and why — so the one log someone is watching says whether a device is there.
  */
  bus.on('journal', (entry) => {
    const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
    context.log(level, `[broker] ${formatEntry(entry)}`);
  });

  /*
    Something on the network tried to command a device through the broker, and
    was cut off: a misconfigured integration or an attack, worth a durable
    record either way. One audit row per client per minute, so a client that
    reconnects in a loop cannot fill the timeline.
  */
  const lastRefusal = new Map<string, number>();
  bus.on('journal', (entry) => {
    if (entry.kind !== 'mqtt.refused') return;
    const key = entry.clientId ?? '';
    const now = Date.now();
    if (now - (lastRefusal.get(key) ?? 0) < 60_000) return;
    lastRefusal.set(key, now);
    context.audit({
      kind: 'mqtt.refused',
      actor: entry.clientId ?? 'unknown',
      resource: entry.device ?? String(entry.data?.topic ?? '').split('/')[0],
      summary: entry.message,
      detail: entry.data,
    });
  });

  /** The broker, as the server sees it: running or not, connected or not, and what it holds. */
  const brokerView = () => {
    const { state } = supervisor;
    return {
      status: state.status,
      error: state.error,
      pid: state.health?.pid ?? null,
      startedAt: state.health?.startedAt ?? null,
      build: state.health?.build ?? null,
      expectedBuild: state.expectedBuild,
      buildMatches: state.buildMatches,
      spawns: state.spawns,
      protocols: state.health?.protocols ?? [],
      listen: state.health?.mqtt ?? { host: config.host, port: config.port, listening: false },
      advertised: config.advertisedHost ? { host: config.advertisedHost, port: config.port } : null,
      serverConnected: bus.connected,
      serverConnectedAt: bus.connectedAt?.toISOString() ?? null,
      serverError: bus.connected ? null : bus.lastError,
      devices: bus.devices,
    };
  };

  return {
    definition,

    available(): Availability {
      if (!started) return { ok: false, reason: 'The MQTT transport has not started' };
      const { state } = supervisor;
      if (state.status !== 'running') return { ok: false, reason: state.error ?? 'The MQTT broker is not running' };
      return { ok: true };
    },

    async start() {
      if (started) return;
      started = true;
      /*
        Attached if a broker is already running — its devices have been
        connected to it all along — or started if not. Then watched, so a
        broker that dies is replaced while this server runs.
      */
      const state = await supervisor.ensure();
      if (state.status === 'running' && state.health && !state.started) {
        const { health } = state;
        log(
          `Attached to the running broker (pid ${health.pid}, up ${duration(health.uptimeMs)}): ` +
            `${health.devicesOnline ?? 0} device(s) online, devices connect to ${health.mqtt.host}:${health.mqtt.port}`
        );
      }
      supervisor.watch();

      bus.start();
      // A moment more after connecting, for the retained presence messages that
      // follow the subscription: then what is connected is known from the start.
      if (await bus.waitForConnect(3000)) await new Promise((resolve) => setTimeout(resolve, 200));
      else log('Not connected to the broker yet; retrying in the background', 'warn');
    },

    async stop() {
      supervisor.release();
      // The server lets go of the broker. The broker — and its devices — stay.
      await bus.stop();
    },

    watch(_filter, listener) {
      const emit = () => listener(bus.devices.map(sightingOf));
      bus.on('presence', emit);
      bus.on('connected', emit);
      emit();
      return () => {
        bus.off('presence', emit);
        bus.off('connected', emit);
      };
    },

    async open(address) {
      const key = address.toUpperCase();
      // Refused rather than shared: two owners of one device's topics would be
      // two sessions polling one device. The core claims an address before
      // opening it, so this is a guard against a bug, not an expected outcome.
      if (open.has(key)) throw new Error(`${key} is already open`);
      open.add(key);
      const channel = new MqttChannel(bus, key, () => open.delete(key));

      const presence = bus.presence(key);
      log(
        `${key}: ` +
          (!presence
            ? 'has not connected to the broker yet'
            : presence.online
              ? `connected from ${presence.remote} since ${new Date(presence.connectedAt!).toLocaleTimeString()}`
              : `not connected; its last session ended ${presence.disconnectedAt ? new Date(presence.disconnectedAt).toLocaleTimeString() : ''}: ${presence.lastDisconnect ?? 'reason unknown'}`)
      );
      return channel;
    },

    values() {
      return { host: config.advertisedHost ?? 'this server’s address', port: String(config.port) };
    },

    diagnostics: {
      /** Everything the broker reports about itself: clients, devices, counters, refusals. */
      broker: async () => ({ ...brokerView(), detail: await admin('/status') }),
      /**
       * The broker's journal: every connection, subscription, command and
       * disconnect, with the reason. `level=debug` adds every poll and
       * telemetry message; `after=<seq>` continues from where the last call left off.
       */
      journal: async (query) => {
        const params = new URLSearchParams(query as Record<string, string>).toString();
        const journal = await admin(`/journal${params ? `?${params}` : ''}`);
        if (!journal) throw new Error(supervisor.state.error ?? 'The broker is not answering');
        return journal;
      },
      /** Messages in both directions, oldest first: the broker's record, so it covers server restarts too. */
      traffic: async (query) => {
        const limit = Math.max(1, Math.min(2000, Number(query.limit ?? 100) || 100));
        const device = query.device ? `&device=${encodeURIComponent(query.device)}` : '';
        return (await admin(`/traffic?limit=${limit}${device}`)) ?? [];
      },
    },
  };
};

export default createMqttTransport;
