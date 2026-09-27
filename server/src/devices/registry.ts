import { providerDeviceId } from '@kraftverk/device-sdk';
import type {
  ConfigValues,
  ConnectionHealth,
  DeviceDescriptor,
  DeviceType,
  ProviderDeviceId,
  Reading,
  SavedDeviceId,
} from '@kraftverk/device-sdk';

import type { DeviceCatalog, DeviceRecord } from './catalog.ts';
import type { DeviceSessionManager } from './sessions.ts';
import type { PluginHost } from '../plugins/host.ts';

/**
 * Joins the devices you added to what they are and what they are doing.
 *
 * The catalog says what exists; the device type says what it is; its session
 * says what it is doing. Keeping those apart is what lets an unplugged device
 * stay in the list, greyed and honest, instead of vanishing with its history.
 *
 * Every device is described the same way, from its type's declarations and its
 * session's answers, so the app has one card, one detail screen and one chart
 * for everything it will ever show — and this file names no product.
 */

/**
 * A saved device, joined to what it is doing right now.
 *
 * The descriptor's `id` and `name` are left out, because those two belong to
 * the catalog here. The vendor's are `providerDeviceId` and `providerName`, so
 * a caller that wants one of them has to say which.
 */
export type SavedDeviceView = Omit<DeviceDescriptor, 'id' | 'name'> & {
  /** The catalog id: stable, the route segment, and what history is keyed by. */
  id: SavedDeviceId;
  /** The device type, when an installed one claims this device. */
  typeId: string | null;
  /** The vendor's own identity for it — a MAC, a Tuya id. Null until known. */
  providerDeviceId: ProviderDeviceId | null;
  /** What the user called it. */
  name: string;
  /** What the vendor calls it, when that is known and differs. */
  providerName: string | null;
  record: DeviceRecord;
  health: ConnectionHealth;
  readings: Reading[];
};

/**
 * How long a v1 plugin may take to hand over its readings.
 *
 * Plugins answer from cache, so this is generous; it exists because `all()` is
 * on the path of every `GET /api/devices`, and one `readDevice` that never
 * settles would otherwise hang the list for every client and stall the sampler.
 * A device session is never waited on: its reads are synchronous.
 */
const READ_TIMEOUT_MS = 2_000;

const readWithin = async (read: () => Promise<Reading[]> | undefined, timeoutMs: number): Promise<Reading[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = read();
    if (!pending) return [];
    return await Promise.race([pending, new Promise<Reading[]>((resolve) => (timer = setTimeout(() => resolve([]), timeoutMs)))]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/** The freshest reading's timestamp — when the device last actually spoke. */
const lastReadingAt = (readings: readonly Reading[]): string | null => {
  let latest: string | null = null;
  for (const reading of readings) {
    if (reading.value === null) continue;
    if (!latest || reading.at > latest) latest = reading.at;
  }
  return latest;
};

export class DeviceRegistry {
  constructor(
    private catalog: DeviceCatalog,
    private host: PluginHost,
    private sessions: DeviceSessionManager
  ) {}

  /** Every saved device, joined to what it is doing. */
  async all(): Promise<SavedDeviceView[]> {
    return Promise.all(this.catalog.list().map((record) => this.#view(record)));
  }

  async find(id: SavedDeviceId): Promise<SavedDeviceView | null> {
    const record = this.catalog.get(id);
    return record ? this.#view(record) : null;
  }

  async #view(record: DeviceRecord): Promise<SavedDeviceView> {
    const type = this.sessions.typeOf(record);
    return type ? this.#typedView(record, type) : this.#pluginView(record);
  }

  /** A device of an installed type: its declarations, and its session's answers. */
  #typedView(record: DeviceRecord, type: DeviceType<any>): SavedDeviceView {
    const session = this.sessions.get(record.id);
    const identity = session?.identity?.() ?? null;
    const readings = session?.readings() ?? [];

    return {
      id: record.id,
      typeId: type.id,
      name: record.name,
      providerDeviceId: identity?.id ? providerDeviceId(identity.id) : null,
      providerName: identity?.name && identity.name !== record.name ? identity.name : null,
      record,
      category: type.meta.category,
      icon: type.meta.icon,
      description: type.meta.name,
      measurements: type.telemetry,
      controls: type.controls ?? [],
      settings: type.settings,
      capabilities: type.capabilities,
      readings,
      health: this.sessions.health(record),
    };
  }

  /**
   * A device provided by a v1 plugin: one configuration per plugin, so one
   * device per plugin (`devices()[0]`). Goes when the plugins become device
   * types (step 5).
   */
  async #pluginView(record: DeviceRecord): Promise<SavedDeviceView> {
    const instance = this.host.instance(record.driver);
    const descriptor = instance?.plugin.devices?.()[0];

    if (!instance || !descriptor) {
      return {
        id: record.id,
        typeId: null,
        providerDeviceId: null,
        record,
        name: record.name,
        providerName: null,
        category: 'unknown',
        icon: 'help-circle',
        measurements: [],
        controls: [],
        readings: [],
        health: {
          // Not offline: nothing is installed that *could* go offline, and
          // "install it" is a different instruction from "is it plugged in".
          status: 'unconfigured',
          detail: instance
            ? 'Its extension is installed but is not providing this device yet'
            : `Nothing installed here knows what "${record.driver}" is`,
          owner: 'server',
          transport: null,
          lastReadingAt: null,
        },
      };
    }

    const vendorId = providerDeviceId(descriptor.id);
    const health = this.host.health(record.driver);
    const readings = await readWithin(() => instance.plugin.readDevice?.(vendorId), READ_TIMEOUT_MS);
    const answering = readings.some((reading) => reading.value !== null);
    const { id: _id, name: _name, ...described } = descriptor;

    return {
      ...described,
      id: record.id,
      typeId: null,
      providerDeviceId: vendorId,
      record,
      name: record.name,
      providerName: descriptor.name === record.name ? null : descriptor.name,
      readings,
      health: {
        status: pluginStatus(health.status, answering),
        detail: health.status === 'healthy' && answering ? 'Answering' : (health.detail ?? 'Not answering'),
        owner: 'server',
        transport: null,
        lastReadingAt: lastReadingAt(readings),
      },
    };
  }

  /** A device's own settings, as last read from it. Empty until they have been. */
  readSettings(record: DeviceRecord): ConfigValues {
    return this.sessions.get(record.id)?.readSettings?.() ?? {};
  }

  /** Applies settings through the device's session, and returns what it reports afterwards. */
  async writeSettings(record: DeviceRecord, patch: ConfigValues): Promise<ConfigValues> {
    const session = this.sessions.get(record.id);
    if (!session?.writeSettings) return {};
    return (await session.writeSettings(patch)) ?? {};
  }
}

/** A v1 plugin's health, in the vocabulary a connection speaks. */
const pluginStatus = (
  status: import('@kraftverk/device-sdk').PluginHealth['status'],
  answering: boolean
): ConnectionHealth['status'] => {
  switch (status) {
    case 'healthy':
    case 'degraded':
      // Healthy but silent is offline: the plugin is fine and the thing at the
      // other end is not talking.
      return answering ? 'connected' : 'offline';
    case 'starting':
      return 'connecting';
    case 'needs-configuration':
      return 'unconfigured';
    case 'failed':
      return 'error';
  }
};
