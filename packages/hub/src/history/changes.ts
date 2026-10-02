import type { DeviceChange } from '@kraftverk/api-contract';
import { partOf, type AttributeSpec, type DeviceDescription, type Reading, type SavedDeviceId, type Value } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';

import type { ChangeRow, HistoryStore } from '@kraftverk/store';

import { SKEW_MS } from './retention.ts';
import { sampleOf } from './sampler.ts';

/**
 * Every change of an on/off or an enum, when the device observed it
 * (docs/DATA-MODEL.md, `sample_change`).
 *
 * Minute samples and hourly means suit a number. For an on/off they are a duty
 * cycle nobody asked for, and a switch flicked for thirty seconds between two
 * samples is not there at all. What a timeline wants — "AC outlets off
 * 14:02–14:19" — is the moment each changed, which is one row per change:
 * small, exact, and kept two years.
 *
 * A reading that says what the last row already says is no change and writes
 * nothing. One that arrives late — an app that was offline sends what it
 * queued — lands in its place in time, and the row after it goes if it no
 * longer changes anything.
 */

/** Which of a device's attributes the log keeps, by key: on/off and enums, whose history is their changes. */
export const loggedAttributes = (description: DeviceDescription): Map<string, AttributeSpec> =>
  new Map(description.attributes.filter((attribute) => attribute.value.type === 'boolean' || attribute.value.type === 'enum').map((attribute) => [attribute.key, attribute]));

/** Records what changed among these readings: each on/off or enum the device observed, at the time it did. Returns how many changes were written. */
export function recordChanges(history: HistoryStore, deviceId: SavedDeviceId, logged: ReadonlyMap<string, AttributeSpec>, readings: readonly Reading[]): number {
  if (!logged.size) return 0;
  const changes = readings.flatMap((reading) => {
    const attribute = logged.get(reading.key);
    const sample = attribute ? sampleOf(reading.value) : null;
    const taken = reading.at ? Date.parse(reading.at) : Number.NaN;
    // A time to come is a clock that is wrong, not a change.
    if (!attribute || !sample || !Number.isFinite(taken) || taken > Date.now() + SKEW_MS) return [];
    return [{ part: partOf(attribute), key: reading.key, at: new Date(taken).toISOString(), ...sample }];
  });
  return history.recordChanges(deviceId, changes);
}

const valueOf = (row: ChangeRow, attribute: AttributeSpec | undefined): Value =>
  row.text !== null ? row.text : row.value === null ? null : attribute?.value.type === 'boolean' ? row.value !== 0 : row.value;

/**
 * The changes between two times, oldest first — with, for each key, the one
 * before `from`, so the span starts knowing what each was — each a value of
 * its attribute's type.
 */
export function changesOf(history: HistoryStore, deviceId: SavedDeviceId, description: DeviceDescription, options: { from: string; to: string; key?: string }): DeviceChange[] {
  const attributes = new Map(description.attributes.map((attribute) => [attribute.key, attribute]));
  return history.changes(deviceId, options).map((row) => ({ key: row.key, part: row.part, at: row.at, value: valueOf(row, attributes.get(row.key)) }));
}

/**
 * Records what the home's own sessions report, as the live bus carries it:
 * only readings whose value moved, the moment a pushing device says so. What
 * an app holds for it arrives by its uplink instead (`HeldReadings`).
 */
export class ChangeLog {
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly history: HistoryStore,
    private readonly bus: LiveBus,
    private readonly describe: (deviceId: SavedDeviceId) => DeviceDescription | null
  ) {}

  start(): void {
    this.#unsubscribe ??= this.bus.subscribe((message) => {
      if (message.kind !== 'readings') return;
      const description = this.describe(message.deviceId);
      if (description) recordChanges(this.history, message.deviceId, loggedAttributes(description), message.readings);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}
