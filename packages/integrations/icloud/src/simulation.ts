import type { DeviceContext } from '@kraftverk/device-sdk';

import type { FindMySource } from './account.ts';
import type { FoundDevice } from './protocol/index.ts';

/*
  A family's Find My that is not there, for trying the account and its
  devices with no Apple ID: a phone that goes out and comes back home over
  forty minutes — up to three kilometres east of where the family lives —
  a phone that stays home, and a Mac Find My has no position for. Where
  "home" is comes from the simulation's own settings; every name is made up.
*/

/** How long a phone's trip out and back takes. */
const TRIP_MS = 40 * 60_000;
/** How far out it goes, at most. */
const TRIP_METRES = 3_000;

/** A point so many metres east of another: what the simulated phone walks along. */
const east = (latitude: number, longitude: number, metres: number) => ({ latitude, longitude: longitude + metres / (111_320 * Math.cos((latitude * Math.PI) / 180)) });

export function simulatedFamily(ctx: DeviceContext<Record<string, never>>): FindMySource {
  const latitude = Number(ctx.simulation?.config.latitude ?? 59.3);
  const longitude = Number(ctx.simulation?.config.longitude ?? 18);
  const devices = (): FoundDevice[] => {
    const now = ctx.clock.now();
    const at = new Date(now).toISOString();
    // Out and back: nowhere at the start and end of each trip, furthest half-way.
    const out = TRIP_METRES * Math.abs(Math.sin((Math.PI * (now % TRIP_MS)) / TRIP_MS));
    const charge = 40 + Math.round(30 * Math.abs(Math.cos((Math.PI * (now % TRIP_MS)) / TRIP_MS)));
    return [
      { id: 'simulated-phone-1', name: 'Sam’s iPhone', model: 'iPhone 15', rawModel: 'iPhone15,4', deviceClass: 'iPhone', battery: charge, batteryStatus: 'NotCharging', location: { ...east(latitude, longitude, out), accuracy: 15, at, old: false }, owner: null, lostModeCapable: true },
      { id: 'simulated-phone-2', name: 'Robin’s iPhone', model: 'iPhone 13', rawModel: 'iPhone14,5', deviceClass: 'iPhone', battery: 88, batteryStatus: 'Charging', location: { latitude, longitude, accuracy: 25, at, old: false }, owner: 'Robin', lostModeCapable: true },
      { id: 'simulated-mac', name: 'Sam’s MacBook', model: 'MacBook Air', rawModel: null, deviceClass: 'MacBookAir', battery: null, batteryStatus: null, location: null, owner: null, lostModeCapable: true },
    ];
  };
  return {
    devices: async () => devices(),
    playSound: async (id) => {
      ctx.log.info(`A sound played on ${id}, simulated`);
    },
    lostMode: async (id) => {
      ctx.log.info(`${id} put in lost mode, simulated`);
    },
  };
}
