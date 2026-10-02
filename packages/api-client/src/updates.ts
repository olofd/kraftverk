import type { Reading } from '@kraftverk/device-sdk';
import type { DeviceView, LiveUpdate } from '@kraftverk/api-contract';

/**
 * What a home's live stream says, applied to the list the app keeps
 * (`GET /api/live`, docs/API.md). Pure, so it is tested without a screen.
 */

/** A device's readings, with newer ones in place of the same keys. */
const merged = (readings: readonly Reading[], newer: readonly Reading[]): Reading[] => {
  const byKey = new Map(readings.map((reading) => [reading.key, reading]));
  for (const reading of newer) byKey.set(reading.key, reading);
  return [...byKey.values()];
};

/** The list with a batch of updates applied: readings merged by key, health replaced. Anything else is not for the list. */
export function applyLive(devices: DeviceView[], updates: readonly LiveUpdate[]): DeviceView[] {
  const readings = new Map<string, Reading[]>();
  const health = new Map<string, DeviceView['health']>();
  for (const update of updates) {
    if (update.type === 'readings') readings.set(update.deviceId, [...(readings.get(update.deviceId) ?? []), ...update.readings]);
    if (update.type === 'health') health.set(update.deviceId, update.health);
  }
  if (!readings.size && !health.size) return devices;
  return devices.map((device) => {
    const newer = readings.get(device.id);
    const now = health.get(device.id);
    if (!newer && !now) return device;
    return { ...device, readings: newer ? merged(device.readings, newer) : device.readings, health: now ?? device.health };
  });
}
