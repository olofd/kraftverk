import { partOf, type AttributeSpec, type NodeId, type Reading, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { HistoryStore, Sample } from '@kraftverk/store';

import { MAX_QUEUED_MS, SKEW_MS } from '../history/retention.ts';
import { sampleOf } from '../history/sampler.ts';

/**
 * Readings from connections an app holds (docs/DATA-MODEL.md §4, "When a
 * phone or browser holds the connection").
 *
 * The app runs the device's session and sends what it reads here. The latest
 * of each is kept in memory, so the device's card and the sampler see it like
 * any other — which is how it becomes history while the app has the device.
 * Readings the app queued while it could not reach this server arrive late;
 * those go straight into history at the minute they were taken.
 */

/** A reading this old is history, not the device's current state. */
const LIVE_MS = 90_000;

type Held = { nodeId: NodeId; connectionId: string; readings: Map<string, Reading>; at: number };

export class RemoteReadings {
  #held = new Map<SavedDeviceId, Held>();

  constructor(private readonly history: HistoryStore) {}

  /**
   * Takes what an app read. Returns how many went straight into history
   * because they were queued, and how many were refused as out of range.
   */
  accept(
    deviceId: SavedDeviceId,
    from: { nodeId: NodeId; connectionId: string },
    readings: readonly Reading[],
    /** Which attributes history keeps, by key: the device description's. */
    kept: ReadonlyMap<string, AttributeSpec>
  ): { live: number; history: number; refused: number } {
    const now = Date.now();
    const held = this.#held.get(deviceId) ?? { ...from, readings: new Map(), at: 0 };
    held.nodeId = from.nodeId;
    held.connectionId = from.connectionId;
    let live = 0;
    let refused = 0;
    const queued: Sample[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;

    for (const reading of readings) {
      const taken = reading.at ? Date.parse(reading.at) : now;
      if (!Number.isFinite(taken) || taken > now + SKEW_MS || now - taken > MAX_QUEUED_MS) {
        refused += 1;
        continue;
      }
      if (now - taken <= LIVE_MS) {
        const previous = held.readings.get(reading.key);
        if (!previous?.at || Date.parse(previous.at) <= taken) held.readings.set(reading.key, reading);
        held.at = Math.max(held.at, taken);
        live += 1;
        continue;
      }
      // Queued while the app was away: history at the minute it was read.
      const attribute = kept.get(reading.key);
      const sample = attribute ? sampleOf(reading.value) : null;
      if (!attribute || !sample) continue;
      const minute = new Date(Math.floor(taken / 60_000) * 60_000).toISOString();
      queued.push({ deviceId, part: partOf(attribute), key: reading.key, at: minute, ...sample });
      earliest = Math.min(earliest, taken);
      latest = Math.max(latest, taken);
    }
    const history = this.history.addSamples(queued);
    // The hours they landed in may be rolled up already: again, with them in.
    if (history) this.history.rollUp(new Date(earliest).toISOString(), new Date(latest + 3_600_000).toISOString());
    this.#held.set(deviceId, held);
    return { live, history, refused };
  }

  /** What an app last read, while it is recent enough to be the device's state. */
  latest(deviceId: SavedDeviceId): { nodeId: NodeId; connectionId: string; readings: Reading[]; at: string } | null {
    const held = this.#held.get(deviceId);
    if (!held || Date.now() - held.at > LIVE_MS) return null;
    return { nodeId: held.nodeId, connectionId: held.connectionId, readings: [...held.readings.values()], at: new Date(held.at).toISOString() };
  }

  forget(deviceId: SavedDeviceId): void {
    this.#held.delete(deviceId);
  }
}
