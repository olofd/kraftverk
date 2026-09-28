import {
  validateConfig,
  type Channel,
  type ConfigValues,
  type ConnectionHealth,
  type DeviceContext,
  type DeviceEvent,
  type DeviceSession,
  type DeviceStore,
  type OpenConnection,
  type SavedDeviceId,
} from '@kraftverk/device-sdk';

import { PLATFORM, type AppRegistry } from './registry';

/**
 * Sessions for the connections this app holds (docs/DATA-MODEL.md §4).
 *
 * The same device-type and protocol code the server runs, opened over this
 * app's own radio: a station on this browser's Bluetooth runs its type's own
 * session, with the protocol's guard in its link. Like the server's manager it
 * knows no product: it opens what it is told to hold, reopens what changed,
 * and closes what it no longer holds.
 */

/** A connection this app holds, and the device it reaches. */
export type HeldDevice = {
  deviceId: SavedDeviceId;
  name: string;
  typeId: string;
  config: Record<string, unknown>;
  connection: { id: string; method: string; transport: string; address: string; config: Record<string, unknown> };
  secrets: Record<string, string>;
  store: DeviceStore;
};

type Open = {
  held: HeldDevice;
  session: DeviceSession;
  channel: Channel;
  fingerprint: string;
  timers: ReturnType<typeof setInterval>[];
  detach: () => void;
};

export type HeldSessionsOptions = {
  registry: AppRegistry;
  /** Writes from this app are refused unless someone has allowed them. */
  readOnly: () => boolean;
  /** A device's own events, for the audit timeline. */
  emit: (held: HeldDevice, event: DeviceEvent) => void;
  /** The connection answered. */
  onConnected?: (held: HeldDevice) => void;
  /** Something changed that a screen shows. */
  onChange?: () => void;
};

const fingerprintOf = (held: HeldDevice, readOnly: boolean) =>
  JSON.stringify([held.typeId, held.config, held.connection, Object.keys(held.secrets).sort(), readOnly]);

export class HeldSessions {
  #open = new Map<string, Open>();
  #refusals = new Map<string, string>();
  #syncing: Promise<void> = Promise.resolve();

  constructor(private options: HeldSessionsOptions) {}

  get(deviceId: string): DeviceSession | null {
    return this.#open.get(deviceId)?.session ?? null;
  }

  held(deviceId: string): HeldDevice | null {
    return this.#open.get(deviceId)?.held ?? null;
  }

  /** Every device this app has a session for. */
  all(): HeldDevice[] {
    return [...this.#open.values()].map((open) => open.held);
  }

  /** How a device this app holds is doing, or null when it holds no session for it. */
  health(deviceId: string): ConnectionHealth | null {
    const open = this.#open.get(deviceId);
    if (open) return { ...open.session.health(), owner: 'client' };
    const refusal = this.#refusals.get(deviceId);
    return refusal ? { status: 'error', detail: refusal, owner: 'client', transport: null, lastReadingAt: null } : null;
  }

  /** Opens what should be open, reopens what changed, closes the rest. One at a time. */
  sync(devices: readonly HeldDevice[]): Promise<void> {
    const run = this.#syncing.then(() => this.#sync(devices));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(devices: readonly HeldDevice[]): Promise<void> {
    const readOnly = this.options.readOnly();
    const wanted = new Map(devices.map((held) => [held.deviceId, held]));
    for (const [deviceId, open] of [...this.#open]) {
      const next = wanted.get(deviceId as SavedDeviceId);
      if (!next || open.fingerprint !== fingerprintOf(next, readOnly)) await this.close(deviceId);
    }
    for (const deviceId of [...this.#refusals.keys()]) if (!wanted.has(deviceId as SavedDeviceId)) this.#refusals.delete(deviceId);
    await Promise.all([...wanted.values()].filter((held) => !this.#open.has(held.deviceId)).map((held) => this.#openOne(held, readOnly)));
    this.options.onChange?.();
  }

  async #openOne(held: HeldDevice, readOnly: boolean): Promise<void> {
    const { registry } = this.options;
    const type = registry.types.get(held.typeId);
    let channel: Channel | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];
    try {
      if (!type) throw new Error(`This app does not know what "${held.typeId}" is: update it`);
      const method = type.connections.find((candidate) => candidate.id === held.connection.method);
      if (!method) throw new Error(`${type.meta.name} has no way called "${held.connection.method}"`);
      const binding = registry.protocols.get(method.protocol)?.bindings[held.connection.transport];
      if (!binding) throw new Error(`This app cannot speak ${method.protocol} over ${held.connection.transport}`);
      const transport = await registry.start(held.connection.transport);
      if (!transport) {
        const why = registry.available(held.connection.transport);
        throw new Error(why.ok ? 'Its transport did not start' : why.reason);
      }
      channel = await transport.open(held.connection.address, binding.open(held.connection.address));

      const known = Object.fromEntries(Object.entries(held.config).filter(([field]) => field in type.config.fields));
      const config = validateConfig(type.config, known);
      if (!config.ok) throw new Error(`Needs setting up: ${config.issues.map((issue) => issue.message).join('; ')}`);

      const connection: OpenConnection = {
        method: method.id,
        protocol: method.protocol,
        transport: held.connection.transport,
        address: held.connection.address,
        channel,
        config: held.connection.config as ConfigValues,
        secrets: { get: (field) => held.secrets[field] ?? null },
        platform: PLATFORM,
      };
      const log = (level: 'log' | 'warn' | 'error') => (message: string) => console[level](`[${held.name}] ${message}`);
      const context: DeviceContext = {
        deviceId: held.deviceId,
        config: config.value,
        connection,
        store: held.store,
        log: { info: log('log'), warn: log('warn'), error: log('error') },
        readOnly,
        // Frames nobody has described are for a server started to bring up a unit, never for an app.
        allowRawFrames: false,
        platform: PLATFORM,
        schedule: (everyMs, task) => {
          let running = false;
          timers.push(
            setInterval(() => {
              if (running) return;
              running = true;
              void Promise.resolve()
                .then(task)
                .catch((error: unknown) => console.warn(`[${held.name}] scheduled work failed:`, (error as Error).message))
                .finally(() => {
                  running = false;
                  this.options.onChange?.();
                });
            }, everyMs)
          );
        },
        emit: (event) => this.options.emit(held, event),
      };
      const session = await type.createSession(context);
      const opened = channel;
      const detach = opened.onConnectedChange((connected) => {
        if (connected) this.options.onConnected?.(held);
        this.options.onChange?.();
      });
      if (opened.connected) this.options.onConnected?.(held);
      this.#open.set(held.deviceId, { held, session, channel: opened, fingerprint: fingerprintOf(held, readOnly), timers, detach });
      this.#refusals.delete(held.deviceId);
    } catch (error) {
      for (const timer of timers) clearInterval(timer);
      await channel?.close().catch(() => undefined);
      this.#refusals.set(held.deviceId, (error as Error).message);
    }
  }

  async close(deviceId: string): Promise<void> {
    const open = this.#open.get(deviceId);
    this.#open.delete(deviceId);
    if (!open) return;
    for (const timer of open.timers) clearInterval(timer);
    open.detach();
    await open.session.close().catch(() => undefined);
    await open.channel.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((deviceId) => this.close(deviceId)));
    this.#refusals.clear();
  }
}
