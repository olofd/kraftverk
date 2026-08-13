import { StationDashboard } from '@kraftverk/device-aferiy-p280/ui/dashboard';
import { StationProtocol } from '@kraftverk/device-aferiy-p280/ui/protocol';
import { StationSettings } from '@kraftverk/device-aferiy-p280/ui/settings';

import type { DeviceView } from '@kraftverk/api-client';

/**
 * Which device package draws which device's screens.
 *
 * The whole of the app shell's knowledge about specific hardware, in one table.
 * Everything else — the grid, the cards, the detail screen, the charts — works
 * from declarations and needs no entry here at all; this exists only for a
 * device rich enough to deserve screens of its own, and the P280 is currently
 * the only one.
 *
 * A device with no entry is not a broken device. It gets the generic screens,
 * which is the outcome the device model is *for*: adding a plug should cost
 * nothing here, and if it did, the model would not be working.
 */

export type DeviceScreens = {
  dashboard: typeof StationDashboard;
  settings: typeof StationSettings;
  protocol: typeof StationProtocol;
};

/** Keyed by driver, because the driver is what decides how a device is read. */
const BY_DRIVER: Record<string, DeviceScreens> = {
  'core.station': {
    dashboard: StationDashboard,
    settings: StationSettings,
    protocol: StationProtocol,
  },
};

export const screensFor = (device: DeviceView | null): DeviceScreens | null =>
  device ? (BY_DRIVER[device.record.driver] ?? null) : null;
