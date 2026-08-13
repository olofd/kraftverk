import {
  descriptor as p280Descriptor,
  readings as p280Readings,
  settingsToValues,
  valuesToSettings,
} from '@kraftverk/device-aferiy-p280';
import type { ConfigValues, DeviceDescriptor, Reading } from '@kraftverk/plugin-sdk';

import { DEFAULT_STATION_MODEL, modelLabel, type DeviceCatalog, type DeviceRecord } from './catalog.ts';
import type { StationDriver } from '../drivers/types.ts';
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
    private driver: () => StationDriver
  ) {}

  /**
   * Adopts a station the server is already talking to.
   *
   * Existing installations have a working station and no catalog entry, and
   * asking someone to "add" the thing already on their dashboard would be
   * absurd. So the first time a station is live and unclaimed, it is added —
   * with the model it is decoded as, which the user can correct.
   */
  adoptStation(): void {
    if (this.catalog.find((record) => record.type === 'power-station')) return;

    const status = this.driver().status();
    this.catalog.add({
      type: 'power-station',
      model: DEFAULT_STATION_MODEL,
      driver: 'core.station',
      name: status.name,
      config: { transport: status.link.transport ?? 'sim', boundId: status.link.mac },
    });
  }

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
    const driver = this.driver();
    const status = driver.status();
    const online = status.link.mode === 'simulator' || status.link.state === 'connected';

    // The description of what a P280 is lives in its own package: what it
    // measures, what it can be told to do, and what it remembers.
    return {
      ...p280Descriptor(record.id, record.name, record.model ? modelLabel(record.model) : status.model),
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
    if (record.driver !== 'core.station') return {};
    return settingsToValues(this.driver().settings());
  }

  async writeSettings(record: DeviceRecord, patch: ConfigValues): Promise<ConfigValues> {
    if (record.driver !== 'core.station') return {};
    // A readback, not an echo: writing the DC input type moves the charging
    // current ceiling on this hardware, so the caller is told what happened.
    const applied = await this.driver().applySettings(valuesToSettings(patch) as never);
    return settingsToValues(applied);
  }
}
