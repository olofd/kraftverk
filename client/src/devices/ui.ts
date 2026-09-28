import type { ComponentType } from 'react';

import type { DeviceScreenProps, DeviceView } from '@kraftverk/api-client';

import { DEVICE_UI } from '../generated/registry';

/**
 * Which screens a device brings of its own.
 *
 * Found, not listed: `src/generated/registry.ts` is written by
 * `npm run gen:devices` from every installed package that ships screens, and
 * nothing here names one. A device with no entry is not a broken device — it
 * gets the generic screens, which is the outcome the device model is for.
 *
 * Every screen gets the same props, whatever it draws and whoever holds the
 * device's connection: see `DeviceScreenProps`.
 */
export type DeviceUi = {
  dashboard?: ComponentType<DeviceScreenProps>;
  settings?: ComponentType<DeviceScreenProps>;
  protocol?: ComponentType<DeviceScreenProps>;
};

export const screensFor = (device: DeviceView | null): DeviceUi | null => (device ? (DEVICE_UI[device.typeId] ?? null) : null);
