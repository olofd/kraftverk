import type { ComponentType } from 'react';
import type { ImageSourcePropType } from 'react-native';

import type { DeviceUi, DeviceView, PartSlotProps } from '@kraftverk/api-client';
import type { Part } from '@kraftverk/device-sdk';

import { DEVICE_ASSETS, DEVICE_UI } from '../generated/registry';

export type { DeviceUi };

/**
 * Pictures a device type ships, declared in its package.json
 * (`kraftverk.assets`) and checked by `npm run gen:devices`: `image` is the
 * device as it looks, on a transparent background.
 */
export type DeviceAssets = { image?: ImageSourcePropType };

/** A device's picture, by its type: every device of a type looks the same. Null for a type that ships none. */
export const imageFor = (typeId: string | null | undefined): ImageSourcePropType | null => (typeId ? (DEVICE_ASSETS[typeId]?.image ?? null) : null);

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
