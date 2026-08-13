import { audit, appState, setAppState } from '../history/db.ts';
import { loadBinding, type Binding } from '../binding.ts';
import { DEFAULT_STATION_MODEL, type DeviceCatalog, type DeviceRecord } from './catalog.ts';
import type { ServerTransportKind } from '../transport/types.ts';

/**
 * The one-time import of a station bound before there was a device catalog.
 *
 * The server used to adopt a station at startup: if one was answering and the
 * catalog had no entry for it, it was added. That made a blank installation
 * impossible and turned *discovery* into *ownership* — a device appeared
 * because a radio noticed it, not because anyone said they owned it.
 *
 * Removing that leaves one honest gap. Someone who bound a station under the
 * old code has a `binding.json` and, if their database is fresh, no record of
 * it. Asking them to "add" the station they have been using for weeks would be
 * absurd, so it is offered — once, explicitly, behind a banner they can wave
 * away — rather than performed on their behalf.
 *
 * It is offered only when the server is actually running the transport the
 * binding names. A saved BLE binding while the simulator answers would create a
 * device the server cannot operate: a row claiming a Bluetooth station, with
 * simulated numbers behind it. That is the exact dishonesty the device-first
 * refactor exists to remove, so it is not offered at all.
 */

const KEY = 'migration.legacyStation';

export type LegacyStationState = 'none' | 'offered' | 'imported' | 'dismissed';

export type LegacyStationOffer = {
  state: LegacyStationState;
  /** How the binding said to reach it. Null unless there is something to offer. */
  transport: ServerTransportKind | null;
  boundId: string | null;
  boundAt: string | null;
  /** What it would be called, which the user can rename afterwards. */
  name: string | null;
};

const NOTHING: LegacyStationOffer = {
  state: 'none',
  transport: null,
  boundId: null,
  boundAt: null,
  name: null,
};

export type LegacyStationDeps = {
  catalog: DeviceCatalog;
  /** The transport this server is running, or null on the simulator. */
  transport: () => ServerTransportKind | null;
  /** What to call it, given the id it was bound to. The user can rename it. */
  stationName: (boundId: string) => string;
  /** Injected so a test can supply a binding without a data directory. */
  binding?: () => Promise<Binding | null>;
};

export class LegacyStationImport {
  #binding: () => Promise<Binding | null>;

  constructor(private deps: LegacyStationDeps) {
    this.#binding = deps.binding ?? loadBinding;
  }

  async offer(): Promise<LegacyStationOffer> {
    const decided = appState(KEY);
    if (decided === 'imported' || decided === 'dismissed') return { ...NOTHING, state: decided };

    // A station already in the catalog is the normal case, and needs nothing.
    if (this.deps.catalog.find((record) => record.type === 'power-station')) return NOTHING;

    const binding = await this.#binding();
    if (!binding || binding.kind !== this.deps.transport()) return NOTHING;

    return {
      state: 'offered',
      transport: binding.kind,
      boundId: binding.id,
      boundAt: binding.boundAt,
      name: this.deps.stationName(binding.id),
    };
  }

  /**
   * Takes the offer.
   *
   * Returns null when there is nothing to import, so the route can answer 409
   * rather than quietly creating a second station.
   */
  async accept(name?: string): Promise<DeviceRecord | null> {
    const offer = await this.offer();
    if (offer.state !== 'offered' || !offer.transport || !offer.boundId) return null;

    const record = this.deps.catalog.add({
      type: 'power-station',
      // The model the old code assumed. It is a guess the user can correct on
      // the device's own screen, and the picker says which models are verified.
      model: DEFAULT_STATION_MODEL,
      driver: 'core.station',
      name: name?.trim() || offer.name || 'Power station',
      config: { transport: offer.transport, boundId: offer.boundId },
    });

    setAppState(KEY, 'imported');
    audit({
      at: new Date().toISOString(),
      kind: 'device.imported',
      actor: 'user',
      resource: record.id,
      summary: `Imported the station bound over ${offer.transport} as "${record.name}"`,
      detail: { boundId: offer.boundId, boundAt: offer.boundAt },
    });

    return record;
  }

  /** Declines it. The banner does not come back. */
  dismiss(): void {
    setAppState(KEY, 'dismissed');
  }
}
