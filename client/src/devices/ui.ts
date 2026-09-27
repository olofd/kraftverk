import type { ComponentType } from 'react';

import type { PluginPanelProps } from '@kraftverk/device-sdk';
import type { SavedDeviceView } from '@kraftverk/api-client';

import { DEVICE_UI, EXTENSION_PANELS } from '../generated/device-types';

/**
 * Which screens a device brings of its own.
 *
 * Found, not listed: `src/generated/device-types.ts` is written by
 * `npm run gen:devices` from every installed package that ships screens, and
 * nothing here names one. A device with no entry is not a broken device — it
 * gets the generic screens, which is the outcome the device model is for.
 *
 * The props are loose for now: the station's screens still take station state
 * the app fetches for them (`features/devices/connection.tsx`). They fetch
 * their own when the station becomes an ordinary device type (step 10), and
 * these become one typed contract every package shares.
 */
export type DeviceUi = {
  dashboard?: ComponentType<any>;
  settings?: ComponentType<any>;
  protocol?: ComponentType<any>;
};

export const screensFor = (device: SavedDeviceView | null): DeviceUi | null =>
  device?.typeId ? (DEVICE_UI[device.typeId] ?? null) : null;

/** A v1 extension's own panel, if it ships one. Gone with the extensions (step 9). */
export const panelFor = (extensionId: string): ComponentType<PluginPanelProps> | null =>
  EXTENSION_PANELS[extensionId] ?? null;
