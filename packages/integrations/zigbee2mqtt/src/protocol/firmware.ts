import { MAIN_PART, type AttributeSpec, type EventSpec, type Value } from '@kraftverk/device-sdk';

import type { Field } from './exposes.ts';
import { objectOf } from './wire.ts';

/*
  A Zigbee device's firmware, as Zigbee2MQTT tells it (docs/PLAN-ZIGBEE.md
  §5.7): what it runs, what its index offers, and an update's progress — read
  from the `update` object in the device's own state and the build it said it
  runs in Zigbee2MQTT's device list. What an update did is said as events.
*/

/** Where the device list's word on the build it runs is put among its state's values, for the shape to read with the rest. */
export const SOFTWARE_PROPERTY = 'software_build_id';

/** Where an update stands, as Zigbee2MQTT says it. */
export type FirmwareState = 'idle' | 'available' | 'scheduled' | 'updating';

/** The `update` object of a device's state, as far as it is one. */
export type UpdateSaid = {
  state: FirmwareState | null;
  installed: number | null;
  latest: number | null;
  source: string | null;
  notes: string | null;
  progress: number | null;
  remaining: number | null;
};

const STATES: readonly FirmwareState[] = ['idle', 'available', 'scheduled', 'updating'];

const numberOr = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const textOr = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** The `update` object of a device's state; null when it has none. */
export function updateOf(raw: unknown): UpdateSaid | null {
  const update = objectOf(raw);
  if (!update) return null;
  return {
    state: STATES.includes(update.state as FirmwareState) ? (update.state as FirmwareState) : null,
    installed: numberOr(update.installed_version),
    latest: numberOr(update.latest_version),
    source: textOr(update.latest_source),
    notes: textOr(update.latest_release_notes),
    progress: numberOr(update.progress),
    remaining: numberOr(update.remaining),
  };
}

/**
 * A firmware's version as a person reads it: as its image is named in the
 * index — `SN-TLSR8656-S60-01-v2.1.3.ota` is 2.1.3 — since a file version is
 * the vendor's own number (SONOFF's 2.1.3 is 0x2103, another's is not). The
 * number itself when its image says nothing.
 */
export function versionName(fileVersion: number | null, source: string | null): string | null {
  const named = source ? /[_-]v?(\d+(?:\.\d+)+)\.(?:ota|zigbee|bin)$/i.exec(source.split('/').pop() ?? '') : null;
  if (named) return named[1]!;
  return fileVersion === null ? null : `#${fileVersion}`;
}

const update = (raw: unknown) => updateOf(raw);

/** The firmware's attributes, beside a device's own: diagnostics, none kept in history — the timeline keeps each update. */
function firmwareField(spec: Omit<AttributeSpec, 'part' | 'category' | 'history'>, property: string, read: (raw: unknown) => Value): Field {
  return {
    spec: { ...spec, part: MAIN_PART, category: 'diagnostic', history: false },
    property,
    read,
    write: () => undefined,
    settable: false,
    gettable: false,
  };
}

export const FIRMWARE_KEYS = {
  installed: 'firmware.installed',
  latest: 'firmware.latest',
  state: 'firmware.state',
  progress: 'firmware.progress',
  remaining: 'firmware.remaining',
  notes: 'firmware.notes',
} as const;

/** The fields of a device Zigbee2MQTT can update. */
export const firmwareFields = (): Field[] => [
  firmwareField({ key: FIRMWARE_KEYS.installed, label: 'Firmware', value: { type: 'string' } }, SOFTWARE_PROPERTY, (raw) => textOr(raw)),
  firmwareField(
    {
      key: FIRMWARE_KEYS.state,
      label: 'Firmware update',
      value: {
        type: 'enum',
        options: [
          { value: 'idle', label: 'None offered' },
          { value: 'available', label: 'Available' },
          { value: 'scheduled', label: 'Waiting for the device to ask' },
          { value: 'updating', label: 'Updating' },
        ],
      },
    },
    'update',
    (raw) => update(raw)?.state ?? null
  ),
  // Only a newer one: what it runs is `firmware.installed`, as the device says it.
  firmwareField({ key: FIRMWARE_KEYS.latest, label: 'Newer firmware', value: { type: 'string' } }, 'update', (raw) => {
    const said = update(raw);
    return said && said.latest !== null && said.latest !== said.installed ? versionName(said.latest, said.source) : null;
  }),
  firmwareField({ key: FIRMWARE_KEYS.progress, label: 'Update progress', value: { type: 'number', unit: '%', min: 0, max: 100 } }, 'update', (raw) => {
    const said = update(raw);
    return said?.state === 'updating' ? (said.progress ?? 0) : null;
  }),
  firmwareField({ key: FIRMWARE_KEYS.remaining, label: 'Update time left', value: { type: 'number', unit: 's', min: 0 } }, 'update', (raw) => {
    const said = update(raw);
    return said?.state === 'updating' ? said.remaining : null;
  }),
  firmwareField({ key: FIRMWARE_KEYS.notes, label: 'What the latest firmware changes', value: { type: 'string' } }, 'update', (raw) => {
    const said = update(raw);
    return said && said.latest !== null && said.latest !== said.installed ? said.notes : null;
  }),
];

/** What an update did, as events of the device. */
export const FIRMWARE_EVENTS = {
  updated: 'firmware.updated',
  failed: 'firmware.failed',
  settingsChanged: 'firmware.settings-changed',
} as const;

export const firmwareEvents = (): EventSpec[] => [
  { id: FIRMWARE_EVENTS.updated, label: 'Firmware updated', level: 'info', data: { from: { type: 'string' }, to: { type: 'string' } } },
  { id: FIRMWARE_EVENTS.failed, label: 'Firmware update failed', level: 'warn', description: 'It runs the firmware it had: nothing was changed.', data: { reason: { type: 'string' } } },
  {
    id: FIRMWARE_EVENTS.settingsChanged,
    label: 'Settings changed by a firmware update',
    level: 'warn',
    description: 'A new firmware set some of its own settings otherwise than they were: check them.',
    data: { changed: { type: 'string' } },
  },
];
