import type { ConnectionHealth, DeviceEvent, DeviceSession, DeviceStore, SavedDeviceId } from '@kraftverk/device-sdk';
import { Failover, identityVerdict, openDevice, OpenRefused, type OpenedDevice } from '@kraftverk/holder';

import { PLATFORM, type AppRegistry } from './registry';

/**
 * Sessions for the connections this app holds (docs/DATA-MODEL.md §4).
 *
 * The same device-type and protocol code the server runs, opened over this
 * app's own radio — and opened, watched and failed over by the same holder
 * core (`@kraftverk/holder`) as the server's: the open timeout, the protocol's
 * guard on the channel, the refusal of a connection that reaches a different
 * device. What is the app's here is what it is told to hold, and where it
 * says a device changed.
 */

/** A connection this app holds, and the device it reaches. */
export type HeldDevice = {
  deviceId: SavedDeviceId;
  name: string;
  typeId: string;
  /** Who the device is, when known: a connection that reaches another device is refused. */
  identity: string | null;
  config: Record<string, unknown>;
  connection: { id: string; method: string; transport: string; address: string; config: Record<string, unknown> };
  secrets: Record<string, string>;
  store: DeviceStore;
};

type Open = {
  held: HeldDevice;
  opened: OpenedDevice;
  fingerprint: string;
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
  /** A connection reached a different device from the one it was added as. */
  onMismatch?: (held: HeldDevice, said: string) => void;
  /** Something changed that a screen shows. */
  onChange?: () => void;
  /** Tracks when each held connection went down, for failing over. */
  failover?: Failover;
};

const fingerprintOf = (held: HeldDevice, readOnly: boolean) =>
  JSON.stringify([held.typeId, held.config, held.connection, Object.keys(held.secrets).sort(), readOnly]);

export class HeldSessions {
  #open = new Map<string, Open>();
  #refusals = new Map<string, string>();
  #syncing: Promise<void> = Promise.resolve();

  constructor(private options: HeldSessionsOptions) {}

  get(deviceId: string): DeviceSession | null {
    return this.#open.get(deviceId)?.opened.session ?? null;
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
    if (open) return { ...open.opened.session.health(), owner: 'client' };
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
    if (!type) {
      this.#refusals.set(held.deviceId, `This app does not know what "${held.typeId}" is: update it`);
      return;
    }
    const log = (level: 'log' | 'warn' | 'error') => (message: string) => console[level](`[${held.name}] ${message}`);
    try {
      const opened = await openDevice({
        type,
        device: { id: held.deviceId, name: held.name, config: held.config },
        connection: held.connection,
        secret: (field) => held.secrets[field] ?? null,
        protocols: registry.protocols,
        transports: registry,
        store: held.store,
        platform: PLATFORM,
        readOnly,
        // Frames nobody has described are for a server started to bring up a unit, never for an app.
        allowRawFrames: false,
        log: { info: log('log'), warn: log('warn'), error: log('error') },
        emit: (event) => this.options.emit(held, event),
        afterScheduled: () => {
          this.#checkIdentity(held.deviceId);
          this.options.onChange?.();
        },
      });
      const channel = opened.channel!;
      const noteState = (connected: boolean) => {
        this.options.failover?.note(held.connection.id, connected);
        if (connected) this.options.onConnected?.(held);
      };
      const detach = channel.onConnectedChange((connected) => {
        noteState(connected);
        this.options.onChange?.();
      });
      noteState(channel.connected);
      this.#open.set(held.deviceId, { held, opened, fingerprint: fingerprintOf(held, readOnly), detach });
      this.#refusals.delete(held.deviceId);
    } catch (error) {
      this.#refusals.set(held.deviceId, error instanceof OpenRefused ? error.message : (error as Error).message);
    }
  }

  /**
   * The wrong-device check, as the server makes it: a connection whose device
   * says it is another one is closed, and nothing it says is kept as this one's.
   */
  #checkIdentity(deviceId: string): void {
    const open = this.#open.get(deviceId);
    if (!open) return;
    const said = open.opened.session.identity?.().id ?? null;
    if (identityVerdict(open.held.identity, said) !== 'mismatch') return;
    this.options.onMismatch?.(open.held, said!);
    void this.close(deviceId).then(() => {
      this.#refusals.set(deviceId, `That connection reaches a different device (${said}), not the one you added`);
      this.options.onChange?.();
    });
  }

  async close(deviceId: string): Promise<void> {
    const open = this.#open.get(deviceId);
    this.#open.delete(deviceId);
    if (!open) return;
    open.detach();
    await open.opened.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((deviceId) => this.close(deviceId)));
    this.#refusals.clear();
  }
}
