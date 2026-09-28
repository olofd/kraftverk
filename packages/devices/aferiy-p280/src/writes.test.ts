import { describe, expect, test } from 'bun:test';

import type { StationSettings, StationStatus } from './model/types.ts';

import { portKey, settingsKeys, withPending, writesInFlight, type StationWriteKey } from './writes.ts';

const status = {
  ports: [
    { id: 'ac', label: 'AC outlets', enabled: true, watts: 7 },
    { id: 'usb', label: 'USB-A + USB-C', enabled: false, watts: 0 },
  ],
} as unknown as StationStatus;

const settings = { chargeLimit: 60, acStandbyMinutes: 0, maxChargingCurrent: 20, dcInputType: 'pv' } as StationSettings;

const pending = (entries: [StationWriteKey, unknown][]) => new Map(entries);

describe('a station, while it is being written', () => {
  test('an output shows the position asked for, and keeps its watts until the station reports', () => {
    const shown = withPending(status, settings, pending([[portKey('ac'), false]]));
    expect(shown.status?.ports.find((port) => port.id === 'ac')).toMatchObject({ enabled: false, watts: 7 });
    expect(shown.status?.ports.find((port) => port.id === 'usb')?.enabled).toBe(false);
    expect(shown.settings).toBe(settings);
  });

  test('a setting shows the value asked for', () => {
    const shown = withPending(status, settings, pending([['acStandbyMinutes', 480]]));
    expect(shown.settings?.acStandbyMinutes).toBe(480);
    expect(shown.status).toBe(status);
  });

  test('nothing pending leaves both exactly as confirmed', () => {
    const shown = withPending(status, settings, pending([]));
    expect(shown.status).toBe(status);
    expect(shown.settings).toBe(settings);
  });

  test('the DC input type also holds the current, which the station moves by itself', () => {
    expect(settingsKeys({ dcInputType: 'dc' })).toEqual({ dcInputType: 'dc', maxChargingCurrent: undefined });
    // Held, but shown as confirmed until the readback says what the station chose.
    const shown = withPending(status, settings, pending(Object.entries(settingsKeys({ dcInputType: 'dc' })) as [StationWriteKey, unknown][]));
    expect(shown.settings).toMatchObject({ dcInputType: 'dc', maxChargingCurrent: 20 });
    expect(writesInFlight(pending([['dcInputType', 'dc'], ['maxChargingCurrent', undefined]])).settings).toEqual(
      new Set(['dcInputType', 'maxChargingCurrent'])
    );
  });

  test('pending keys are split into outputs and settings for the screens', () => {
    const inFlight = writesInFlight(pending([[portKey('ac'), true], ['ledMode', 'sos']]));
    expect([...inFlight.ports]).toEqual(['ac']);
    expect([...inFlight.settings]).toEqual(['ledMode']);
  });
});
