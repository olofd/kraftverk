import {
  descriptor as p280Descriptor,
  readings as p280Readings,
  settingsToValues,
  valuesToSettings,
} from '@kraftverk/device-aferiy-p280';
import type { ConfigValues, DeviceDescriptor, Reading } from '@kraftverk/plugin-sdk';

import { modelLabel, type DeviceCatalog, type DeviceRecord } from './catalog.ts';
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

export type DeviceView = DeviceDescriptor & {
  /** The catalog id: stable, and what history is keyed by. */
  id: string;
  record: DeviceRecord;
  /** True when the thing itself is answering right now. */
  online: boolean;
  /** Why not, when it isn't. */
  detail?: string;
  readings: Reading[];
};

export class DeviceRegistry {
  constructor(
    private catalog: DeviceCatalog,
    private host: PluginHost,
    /** Live links, keyed by the same catalog id the records use. */
    private connections: ConnectionManager
  ) {}

  async all(): Promise<DeviceView[]> {
    const views: DeviceView[] = [];
    for (const record of this.catalog.list()) {
      views.push(await this.#view(record));
    }
    return views;
  }

  async find(id: string): Promise<DeviceView | null> {
    const record = this.catalog.get(id);
    return record ? this.#view(record) : null;
  }

  async #view(record: DeviceRecord): Promise<DeviceView> {
    if (record.driver === 'core.station') return this.#stationView(record);

    const instance = this.host.instance(record.driver);
    const descriptor = instance?.plugin.devices?.()[0];

    if (!instance || !descriptor) {
      return {
        id: record.id,
        record,
        name: record.name,
        kind: 'smart-plug',
        icon: 'power',
        measurements: [],
        controls: [],
        online: false,
        detail: instance ? 'Its driver is not running' : `Driver ${record.driver} is not installed`,
        readings: [],
      };
    }

    const health = this.host.health(record.driver);
    const readings = (await instance.plugin.readDevice?.(descriptor.id).catch(() => [])) ?? [];
    const online = health.status === 'healthy' && readings.some((reading) => reading.value !== null);

    return {
      ...descriptor,
      id: record.id,
      record,
      name: record.name,
      online,
      detail: online ? undefined : (health.detail ?? 'Not answering'),
      readings,
    };
  }

  #stationView(record: DeviceRecord): DeviceView {
    const session = this.connections.get(record.id);
    const label = record.model ? modelLabel(record.model) : 'Power station';

    /*
      A station with no session is still a station you own. It keeps its name,
      its model and its place in the list, and says why it is not answering —
      which is the difference between a device catalog and a scan result.
    */
    if (!session) {
      return {
        ...p280Descriptor(record.id, record.name, label),
        id: record.id,
        record,
        name: record.name,
        online: false,
        detail: this.connections.refusal(record.id) ?? 'The server is not holding a link to it',
        readings: [],
      };
    }

    const status = session.driver.status();
    const online = status.link.mode === 'simulator' || status.link.state === 'connected';

    // The description of what a P280 is lives in its own package: what it
    // measures, what it can be told to do, and what it remembers.
    return {
      ...p280Descriptor(record.id, record.name, record.model ? label : status.model),
      id: record.id,
      record,
      name: record.name,
      online,
      detail: online ? undefined : 'The station has not connected',
      readings: p280Readings(status),
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
