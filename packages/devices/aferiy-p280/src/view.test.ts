import { describe, expect, test } from 'bun:test';

import { nodeId } from '@kraftverk/device-sdk';

import { infoOf, readings } from './index.ts';
import type { StationSettings, StationStatus } from './model/types.ts';
import { stationView } from './view.ts';

/*
  The station's screens draw from its readings, not from a tool of their own:
  what the session reports, read back, is the station as it was — every
  figure the dashboard shows is a declared attribute.
*/

const AT = '2026-09-29T12:00:00.000Z';

const STATUS: StationStatus = {
  name: 'P280',
  model: 'P280',
  firmware: { ac: '1.2', controllerA: '1.4', controllerB: '1.4', panel: '2.0' },
  state: 'charging',
  link: { mode: 'device', state: 'connected', transport: 'mqtt', mac: 'AABBCCDDEEFF', lastSeen: AT },
  level: 62.5,
  expansionSoc: [80, 41.5],
  capacityWh: 2048,
  gridConnected: true,
  solarConnected: false,
  acInputWatts: 612,
  solarInputWatts: 0,
  totalInputWatts: 612,
  totalOutputWatts: 45,
  acInputVolts: 231.4,
  acInputHz: 50,
  acOutputVolts: 230.1,
  acOutputHz: 50,
  minutesToFull: 95,
  minutesRemaining: null,
  chargeBookingMinutes: 0,
  ports: [
    { id: 'ac', label: 'AC outlets', enabled: true, watts: 40 },
    { id: 'dc', label: '12V DC / car port', enabled: false, watts: 0 },
    { id: 'usb', label: 'USB-A + USB-C', enabled: true, watts: 5 },
    { id: 'led', label: 'Light', enabled: false, watts: 0 },
  ],
  lastUpdated: AT,
};

const SETTINGS: StationSettings = {
  chargeLimit: 80,
  dischargeFloor: 10,
  acChargingWatts: 900,
  dcInputType: 'pv',
  maxChargingCurrent: 12,
  acSilentCharging: false,
  stopChargeAfterMinutes: 0,
  ledMode: 'off',
  keySound: true,
  usbStandbyMinutes: 10,
  acStandbyMinutes: 480,
  dcStandbyMinutes: 0,
  screenRestSeconds: 300,
  sleepMinutes: 30,
  temperatureUnit: 'C',
};

const health = { status: 'connected' as const, detail: 'Connected', lastReadingAt: AT, node: nodeId('n-0000000000a1'), transport: 'mqtt' };

describe('the station, from its readings', () => {
  test('is what it reported: every figure, every output, every pack and every setting', () => {
    const { status, settings } = stationView({ readings: readings(STATUS, SETTINGS), info: infoOf(STATUS), health, address: 'AABBCCDDEEFF', simulated: false });
    expect(status).toEqual(STATUS);
    expect(settings).toEqual(SETTINGS);
  });

  test('is nothing before its first reading', () => {
    expect(stationView({ readings: [], info: null, health, address: null, simulated: false })).toEqual({ status: null, settings: null });
  });

  test('has no settings until it has said all of them: half would be written back as guesses', () => {
    const some = readings(STATUS, SETTINGS).filter((reading) => reading.key !== 'sleepMinutes');
    expect(stationView({ readings: some, info: null, health, address: null, simulated: false }).settings).toBeNull();
  });

  test('says how it is reached from its health, and a simulator has no address', () => {
    const { status } = stationView({ readings: readings(STATUS, SETTINGS), info: null, health: { ...health, status: 'connecting' }, address: 'AABBCCDDEEFF', simulated: true });
    expect(status?.link).toEqual({ mode: 'simulator', state: 'waiting', transport: 'mqtt', mac: null, lastSeen: AT });
  });
});
