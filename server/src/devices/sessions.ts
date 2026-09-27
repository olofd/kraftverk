import {
  validateConfig,
  type ConnectionHealth,
  type DeviceContext,
  type DeviceSession,
  type DeviceType,
  type SavedDeviceId,
  type TransportRuntime,
} from '@kraftverk/device-sdk';

import { audit } from '../history/db.ts';
import { withTimeout } from '../plugins/host.ts';
import { typeIdOf, type DeviceRecord } from './catalog.ts';
import { deviceStore } from './store.ts';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * One open session for every saved device, whatever its type.
 *
 * The catalog says what you own; the registry says what each thing is; this
 * opens it — `type.createSession(ctx)` with that device's own config, or
 * `type.createSimulator(ctx)` when the server runs without hardware — and
 * closes it when the device is forgotten. It knows no product: everything
 * specific arrives through the type (docs/ARCHITECTURE.md §4.7).
 *
 * A device whose session cannot be opened is still a device you own. It gets
 * no session and a reason, which is what its card then says.
 */

const OPEN_TIMEOUT_MS = 10_000;

export type DeviceSessionManagerDeps = {
  types: DeviceTypeRegistry;
  /** Every device is simulated; no hardware is reached. */
  simulate: boolean;
  /** The server refuses every hardware write. Sessions are told, and must honour it. */
  readOnly: boolean;
  /** The shared things the server owns and sessions borrow: radios, the broker. */
  transports: TransportRuntime;
  /**
   * Run first on every sync. The server's station links are opened here until
   * the station's package holds its own (step 10), so a station's link exists before its
   * session asks for it.
   */
  beforeSync?: (records: DeviceRecord[]) => Promise<void>;
  log?: (message: string) => void;
};

type Refusal = { status: 'unconfigured' | 'error'; detail: string };

export class DeviceSessionManager {
  #sessions = new Map<SavedDeviceId, DeviceSession>();
  #refusals = new Map<SavedDeviceId, Refusal>();
  #timers = new Map<SavedDeviceId, ReturnType<typeof setInterval>[]>();
  /** The config each session was opened with, so a changed one is reopened. */
  #opened = new Map<SavedDeviceId, string>();
  #syncing: Promise<unknown> = Promise.resolve();

  constructor(private deps: DeviceSessionManagerDeps) {}

  /** What a saved device is, or null when no installed type claims it. */
  typeOf(record: DeviceRecord): DeviceType<any> | null {
    const id = typeIdOf(record, (candidate) => this.deps.types.has(candidate));
    return id ? this.deps.types.get(id) : null;
  }

  get(deviceId: SavedDeviceId): DeviceSession | null {
    return this.#sessions.get(deviceId) ?? null;
  }

  /**
   * How a device is doing: its session's own answer, or why it has none.
   */
  health(record: DeviceRecord): ConnectionHealth {
    const session = this.#sessions.get(record.id);
    if (session) return session.health();
    const refusal = this.#refusals.get(record.id);
    return {
      status: refusal?.status ?? 'offline',
      detail: refusal?.detail ?? 'Not open yet',
      owner: 'server',
      transport: null,
      lastReadingAt: null,
    };
  }

  /**
   * Brings the open sessions in line with the catalog: opens what was added,
   * closes what was forgotten, and reopens a device whose config changed.
   * One at a time, so two syncs never each decide the other's work is still
   * to do.
   */
  sync(records: DeviceRecord[]): Promise<void> {
    const run = this.#syncing.then(() => this.#sync(records));
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  async #sync(records: DeviceRecord[]): Promise<void> {
    await this.deps.beforeSync?.(records);

    const wanted = new Map(records.filter((record) => this.typeOf(record)).map((record) => [record.id, record]));
    for (const id of [...this.#sessions.keys()]) {
      const record = wanted.get(id);
      if (!record || this.#opened.get(id) !== JSON.stringify(record.config)) await this.close(id);
    }
    for (const id of [...this.#refusals.keys()]) if (!records.some((record) => record.id === id)) this.#refusals.delete(id);

    // Each isolated: one device that will not open must not keep the others shut.
    await Promise.all(
      [...wanted.values()].filter((record) => !this.#sessions.has(record.id)).map((record) => this.#open(record))
    );
  }

  async #open(record: DeviceRecord): Promise<void> {
    const type = this.typeOf(record)!;
    this.#refusals.delete(record.id);

    /*
      Only the fields the type knows. Writes are held to the schema strictly;
      but a device saved by an older version may carry a key its type has
      since dropped, and that must not stop a working device from opening.
    */
    const known = Object.fromEntries(Object.entries(record.config).filter(([field]) => field in type.config.fields));
    const config = validateConfig(type.config, known);
    if (!config.ok) {
      this.#refusals.set(record.id, {
        status: 'unconfigured',
        detail: `Needs setting up: ${config.issues.map((issue) => issue.message).join('; ')}`,
      });
      return;
    }

    const context = this.#contextFor(record, config.value);
    try {
      const session = await withTimeout(
        this.deps.simulate ? type.createSimulator(context) : type.createSession(context),
        `Opening ${record.name}`,
        OPEN_TIMEOUT_MS
      );
      this.#sessions.set(record.id, session);
      this.#opened.set(record.id, JSON.stringify(record.config));
    } catch (error) {
      this.#clearTimers(record.id);
      const detail = (error as Error).message;
      this.#refusals.set(record.id, { status: 'error', detail });
      this.deps.log?.(`${record.name} could not be opened: ${detail}`);
    }
  }

  #contextFor(record: DeviceRecord, config: DeviceContext['config']): DeviceContext {
    const log = (level: 'log' | 'warn' | 'error') => (message: string, extra?: unknown) =>
      console[level](`[${record.name}] ${message}`, extra ?? '');

    return {
      deviceId: record.id,
      config,
      // Per-device secrets arrive with the catalog migration (step 5).
      secrets: { get: () => null },
      store: deviceStore(record.id),
      log: { info: log('log'), warn: log('warn'), error: log('error') },
      http: (url, init) => {
        const { timeoutMs = 10_000, ...rest } = init ?? {};
        return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
      },
      transports: this.deps.transports,
      readOnly: this.deps.readOnly,
      schedule: (everyMs, task) => {
        let running = false;
        const timer = setInterval(() => {
          // Skipped, not queued: a device that stops answering must not build
          // a backlog of polls that all fire when it comes back.
          if (running) return;
          running = true;
          void Promise.resolve()
            .then(task)
            .catch((error: unknown) => console.warn(`[${record.name}] scheduled work failed:`, (error as Error).message))
            .finally(() => {
              running = false;
            });
        }, everyMs);
        this.#timers.set(record.id, [...(this.#timers.get(record.id) ?? []), timer]);
      },
      emit: (event) =>
        audit({
          at: new Date().toISOString(),
          kind: `device.${event.level}`,
          actor: record.name,
          resource: record.id,
          summary: event.message,
          detail: event.data,
        }),
    };
  }

  async close(deviceId: SavedDeviceId): Promise<void> {
    const session = this.#sessions.get(deviceId);
    this.#sessions.delete(deviceId);
    this.#opened.delete(deviceId);
    this.#clearTimers(deviceId);
    if (session) await withTimeout(session.close(), 'Closing a device', 5_000).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  #clearTimers(deviceId: SavedDeviceId): void {
    for (const timer of this.#timers.get(deviceId) ?? []) clearInterval(timer);
    this.#timers.delete(deviceId);
  }
}
