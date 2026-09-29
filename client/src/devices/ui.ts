import type { ComponentType } from 'react';

import type { DeviceUi, DeviceView, PartSlotProps } from '@kraftverk/api-client';
import type { Part } from '@kraftverk/device-sdk';

import { DEVICE_UI } from '../generated/registry';

export type { DeviceUi };

/**
 * Which pieces of its pages a device draws itself.
 *
 * Found, not listed: `src/generated/registry.ts` is written by
 * `npm run gen:devices` from every installed package that ships screens, and
 * nothing here names one. A device with no entry is not a broken device — it
 * gets the generic pages, which is the outcome the device model is for; one
 * with an entry overrides only the slots it fills (`DeviceUi`).
 *
 * Every piece gets the same props, whatever it draws and whoever holds the
 * device's connection: see `DeviceScreenProps`.
 */
export const screensFor = (device: DeviceView | null): DeviceUi | null => (device ? (DEVICE_UI[device.typeId] ?? null) : null);

/** A package's own card for one part: by the part's id first, then by its kind. */
export const partSlotFor = (device: DeviceView, part: Part): ComponentType<PartSlotProps> | null => {
  const parts = screensFor(device)?.parts;
  return parts?.[part.id] ?? parts?.[part.kind] ?? null;
};
