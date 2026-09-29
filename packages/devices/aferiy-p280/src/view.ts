import type { ConnectionHealth, DeviceInfo, Reading, Value } from '@kraftverk/device-sdk';

import { KEYS, OUTLETS, SETTINGS_SCHEMA, valuesToSettings } from './index.ts';
import { PORT_LABELS } from './model/station.ts';
import type { FirmwareVersions, PortState, StationSettings, StationState, StationStatus } from './model/types.ts';

/**
 * The station as its screens draw it, read back out of its readings — the
 * same readings every screen, the history and the automations see, carried
 * live by whoever holds it. Nothing here asks the station anything: what the
 * description does not declare, the dashboard cannot show.
 */

/** What a screen has of a device: its readings, what it said about itself, how it is doing, and how it is reached. */
export type StationAsSeen = {
  readings: readonly Reading[];
  info: DeviceInfo | null;
  health: ConnectionHealth;
  /** The address of the connection in use: the station's MAC. */
  address: string | null;
  simulated: boolean;
};

const STATES: readonly StationState[] = ['charging', 'discharging', 'idle', 'standby'];

export function stationView(source: StationAsSeen): { status: StationStatus | null; settings: StationSettings | null } {
  const byKey = new Map(source.readings.map((reading) => [reading.key, reading]));
  const soc = byKey.get('soc');
  // Nothing before its first reading: the zeros in their place were charted as a flat battery.
  if (!soc?.at) return { status: null, settings: null };

  const value = (key: string): Value => byKey.get(key)?.value ?? null;
  const number = (key: string): number | null => {
    const found = value(key);
    return typeof found === 'number' ? found : null;
  };
  const flag = (key: string): boolean | null => {
    const found = value(key);
    return typeof found === 'boolean' ? found : null;
  };
  const port = (id: PortState['id'], on: string, watts: string): PortState => ({ id, label: PORT_LABELS[id], enabled: flag(on) ?? false, watts: number(watts) ?? 0 });

  const packs: number[] = [];
  for (let pack = 1; byKey.has(KEYS.packSoc(pack)); pack++) packs.push(number(KEYS.packSoc(pack)) ?? 0);

  const state = value('state');
  const firmware = source.info?.firmware as Partial<FirmwareVersions> | undefined;
  const lastUpdated = [...byKey.values()].reduce<string | null>((latest, reading) => (reading.at && (!latest || reading.at > latest) ? reading.at : latest), null);

  const status: StationStatus = {
    name: source.info?.model ?? 'P280',
    model: source.info?.model ?? 'P280',
    firmware: firmware?.ac && firmware.controllerA && firmware.controllerB && firmware.panel ? (firmware as FirmwareVersions) : null,
    state: STATES.includes(state as StationState) ? (state as StationState) : 'idle',
    link: {
      mode: source.simulated ? 'simulator' : 'device',
      state: source.health.status === 'connected' ? 'connected' : source.health.status === 'connecting' ? 'waiting' : 'offline',
      ...(source.health.transport ? { transport: source.health.transport } : {}),
      mac: source.simulated ? null : source.address,
      lastSeen: source.health.lastReadingAt,
    },
    level: number('soc'),
    expansionSoc: packs,
    capacityWh: number('capacityWh') ?? 0,
    gridConnected: flag(KEYS.mainsPresent),
    solarConnected: flag(KEYS.solarPresent),
    acInputWatts: number(KEYS.mainsWatts) ?? 0,
    solarInputWatts: number(KEYS.solarWatts) ?? 0,
    totalInputWatts: number('inputWatts') ?? 0,
    totalOutputWatts: number('outputWatts') ?? 0,
    acInputVolts: number(KEYS.mainsVolts) ?? 0,
    acInputHz: number(KEYS.mainsHz) ?? 0,
    acOutputVolts: number('acOutputVolts') ?? 0,
    acOutputHz: number('acOutputHz') ?? 0,
    minutesToFull: number('minutesToFull'),
    minutesRemaining: number('minutesRemaining'),
    chargeBookingMinutes: number('chargeBookingMinutes') ?? 0,
    ports: [...OUTLETS.map((outlet) => port(outlet.port, KEYS.outletOn(outlet.port), KEYS.outletWatts(outlet.port))), port('led', KEYS.lightOn, KEYS.lightWatts)],
    lastUpdated,
  };

  // Its settings are readings too; all of them, or none: a screen that drew half would write the rest as guesses.
  const keys = Object.keys(SETTINGS_SCHEMA.fields);
  const known = keys.every((key) => value(key) !== null);
  const settings = known ? (valuesToSettings(Object.fromEntries(keys.map((key) => [key, value(key)]))) as StationSettings) : null;

  return { status, settings };
}
