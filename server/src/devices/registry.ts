import {
  descriptor as p280Descriptor,
  readings as p280Readings,
  settingsToValues,
  valuesToSettings,
} from '@kraftverk/device-aferiy-p280';
import { providerDeviceId } from '@kraftverk/plugin-sdk';
import type {
  ConfigValues,
  ConnectionHealth,
  DeviceDescriptor,
  ProviderDeviceId,
  Reading,
  SavedDeviceId,
} from '@kraftverk/plugin-sdk';

import { boundStation, modelLabel, type DeviceCatalog, type DeviceRecord } from './catalog.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { PluginHost } from '../plugins/host.ts';

/**
 * Joins the devices you added to whatever is currently answering.
 *
 * The catalog says what exists; the drivers say what it is doing. Keeping those
 * separate is what lets an unplugged device stay in the list, greyed and
 * honest, instead of vanishing and taking its history with it.
 *
 * The station is described here rather than by a plugin — it is built in — but
 * it is described the *same way*, so the app has one card, one detail screen
 * and one chart for everything it will ever show.
 */

/**
 * A saved device, joined to what it is doing right now.
 *
 * The descriptor is spread in without its `id` and `name`, because those two
 * belong to the catalog here. The vendor's are `providerDeviceId` and
 * `providerName`, so a caller that wants one of them has to say which — a
 * distinction that matters the moment one adapter provides two devices.
 */
export type SavedDeviceView = Omit<DeviceDescriptor, 'id' | 'name'> & {
  /** The catalog id: stable, the route segment, and what history is keyed by. */
  id: SavedDeviceId;
  /** The adapter's own identity for it — a MAC, a Tuya id. Null before commissioning. */
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
 * How long one adapter may take to hand over its readings.
 *
 * Adapters are expected to answer from cache — the Tuya driver keeps the last
 * datapoints it received — so this is generous. It exists because `all()` is on
 * the path of *every* `GET /api/devices`, which the app polls continuously, and
 * a `readDevice` that never settles would hang the device list for every client
 * and stall the sampler with it. An extension is not allowed to take the
 * catalog down with it.
 */
const READ_TIMEOUT_MS = 2_000;

const readWithin = async (
  read: () => Promise<Reading[]> | undefined,
  timeoutMs: number
): Promise<Reading[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = read();
    if (!pending) return [];
    // An empty list is what a device that will not answer looks like, and the
    // caller already renders that honestly as "not answering".
    return await Promise.race([
      pending,
      new Promise<Reading[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs);
      }),
    ]);
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
    /** Live links, keyed by the same catalog id the records use. */
    private connections: ConnectionManager
  ) {}

  /**
   * Every saved device, joined to what it is doing.
   *
   * Concurrent rather than one after another: each view may wait on its own
   * adapter, and serialising them made the whole list as slow as the sum of its
   * devices. With one device that was invisible; it is the difference between a
   * responsive canvas and a stalling one by the tenth.
   */
  async all(): Promise<SavedDeviceView[]> {
    return Promise.all(this.catalog.list().map((record) => this.#view(record)));
  }

  async find(id: SavedDeviceId): Promise<SavedDeviceView | null> {
    const record = this.catalog.get(id);
    return record ? this.#view(record) : null;
  }

  async #view(record: DeviceRecord): Promise<SavedDeviceView> {
    if (record.driver === 'core.station') return this.#stationView(record);

    const instance = this.host.instance(record.driver);
    const descriptor = instance?.plugin.devices?.()[0];

    if (!instance || !descriptor) {
      return {
        id: record.id,
        providerDeviceId: null,
        record,
        name: record.name,
        providerName: null,
        kind: 'smart-plug',
        icon: 'power',
        measurements: [],
        controls: [],
        readings: [],
        health: {
          // Not offline: nothing has been configured that *could* go offline,
          // and "install the driver" is a different instruction from "check
          // whether it is plugged in".
          status: 'unconfigured',
          detail: instance
            ? 'Its driver is installed but is not providing this device yet'
            : `Driver ${record.driver} is not installed`,
          owner: 'server',
          transport: null,
          lastReadingAt: null,
        },
      };
    }

    // The adapter is a boundary: its descriptor carries the vendor's identity,
    // and this is where that string becomes one.
    const vendorId = providerDeviceId(descriptor.id);
    const health = this.host.health(record.driver);
    const readings = await readWithin(
      () => instance.plugin.readDevice?.(vendorId),
      READ_TIMEOUT_MS
    );
    const answering = readings.some((reading) => reading.value !== null);

    return {
      ...withoutIdentity(descriptor),
      id: record.id,
      providerDeviceId: vendorId,
      record,
      name: record.name,
      providerName: descriptor.name === record.name ? null : descriptor.name,
      readings,
      health: {
        status: pluginStatus(health.status, answering),
        detail:
          health.status === 'healthy' && answering
            ? 'Answering'
            : (health.detail ?? 'Not answering'),
        owner: 'server',
        // Null rather than guessed. A plugin does not declare how it reaches
        // its device yet; that belongs to the connection record, and inventing
        // `tuya-lan` here would put a word on screen nothing had verified.
        transport: null,
        lastReadingAt: lastReadingAt(readings),
      },
    };
  }

  #stationView(record: DeviceRecord): SavedDeviceView {
    const session = this.connections.get(record.id);
    const label = record.model ? modelLabel(record.model) : 'Power station';
    /*
      For a station these two identities are the same MAC wearing different
      hats: the id the radio binds to, and the id the vendor stamped on it. The
      conversion is written out rather than assumed, because they are the same
      only for this device kind.
     */
    const bound = boundStation(record);
    const saved = bound ? providerDeviceId(bound) : null;

    /*
      A station with no session is still a station you own. It keeps its name,
      its model and its place in the list, and says why it is not answering —
      which is the difference between a device catalog and a scan result.
    */
    if (!session) {
      const refusal = this.connections.refusal(record.id);
      return {
        ...withoutIdentity(p280Descriptor(record.id, record.name, label)),
        id: record.id,
        providerDeviceId: saved,
        record,
        name: record.name,
        providerName: null,
        readings: [],
        health: {
          // A refusal is something the user has to resolve — the radio is held
          // by another device — while a plain absent link is just quiet.
          status: refusal ? 'error' : 'offline',
          detail: refusal ?? 'The server is not holding a link to it',
          owner: 'server',
          transport: null,
          lastReadingAt: null,
        },
      };
    }

    const status = session.driver.status();
    const simulated = status.link.mode === 'simulator';
    const connected = simulated || status.link.state === 'connected';
    const readings = p280Readings(status);

    // The description of what a P280 is lives in its own package: what it
    // measures, what it can be told to do, and what it remembers.
    return {
      ...withoutIdentity(p280Descriptor(record.id, record.name, record.model ? label : status.model)),
      id: record.id,
      // The live MAC when the link has one, else what the record was bound to.
      providerDeviceId: status.link.mac ? providerDeviceId(status.link.mac) : saved,
      record,
      name: record.name,
      providerName: status.name === record.name ? null : status.name,
      readings,
      health: {
        status: connected ? 'connected' : status.link.state === 'waiting' ? 'connecting' : 'offline',
        detail: connected
          ? simulated
            ? 'Simulated'
            : 'Connected'
          : status.link.state === 'waiting'
            ? 'Looking for the station'
            : 'The station has not connected',
        owner: 'server',
        transport: simulated ? 'sim' : (status.link.transport ?? session.kind),
        lastReadingAt: connected ? lastReadingAt(readings) : status.link.lastSeen,
      },
    };
  }

  /** The station's own settings, in the schema language the app renders. */
  readSettings(record: DeviceRecord): ConfigValues {
    const session = this.connections.get(record.id);
    if (record.driver !== 'core.station' || !session) return {};
    return settingsToValues(session.driver.settings());
  }

  async writeSettings(record: DeviceRecord, patch: ConfigValues): Promise<ConfigValues> {
    const session = this.connections.get(record.id);
    if (record.driver !== 'core.station' || !session) return {};
    // A readback, not an echo: writing the DC input type moves the charging
    // current ceiling on this hardware, so the caller is told what happened.
    const applied = await session.driver.applySettings(valuesToSettings(patch) as never);
    return settingsToValues(applied);
  }
}

/**
 * The descriptor without the two fields the catalog owns.
 *
 * Dropping them here rather than letting the spread overwrite them is the whole
 * mechanism: `SavedDeviceView` cannot carry a vendor id in `id` again without
 * the compiler noticing.
 */
const withoutIdentity = (descriptor: DeviceDescriptor): Omit<DeviceDescriptor, 'id' | 'name'> => {
  const { id: _id, name: _name, ...rest } = descriptor;
  return rest;
};

/** A driver's health, in the vocabulary a connection speaks. */
const pluginStatus = (
  status: import('@kraftverk/plugin-sdk').PluginHealth['status'],
  answering: boolean
): ConnectionHealth['status'] => {
  switch (status) {
    case 'healthy':
      // Healthy but silent is offline, not connected: the driver is fine and
      // the thing at the other end is not talking.
      return answering ? 'connected' : 'offline';
    case 'starting':
      return 'connecting';
    case 'needs-configuration':
      return 'unconfigured';
    case 'failed':
      return 'error';
    case 'degraded':
      return answering ? 'connected' : 'offline';
  }
};
