import { MAIN_PART, valueTypeOf, type AttributeSpec, type ConfigSchema, type DeviceDescription, type DeviceInfo, type EventSpec, type Part, type Reading } from '@kraftverk/device-sdk';

import type { PortId, StationSettings, StationStatus } from './model/types.ts';

/**
 * The AFERIY P280, described in the device model.
 *
 * Everything model-specific lives here rather than in the server: the AC
 * charging steps are 600–1800 W on this machine and 300–1100 W on a FOSSiBOT,
 * the standby timers offer exactly the values BrightEMS offers, and one of the
 * settings can permanently brick the station. None of that is knowledge the
 * core should carry — it is knowledge about *this device*.
 *
 * The core turns this description into the API and the app into screens;
 * neither needs to know what a P280 is. The station model below them — the
 * register map, the decode, the polling client — is in `./model`, and is this
 * package's too: the protocol package knows the wire, not the machine.
 */

/**
 * The outputs, each a part with a switch of its own.
 *
 * The light is deliberately not one. It looks like an outlet — you tap it and
 * the lamp changes — but the station *remembers* the mode across a power cycle,
 * which makes it a setting: `ledMode`, which is also the only path that can
 * express SOS and flash; the port register behind it is a boolean and would
 * silently reduce four modes to two.
 */
export const OUTLETS: readonly { port: PortId; label: string }[] = [
  { port: 'ac', label: 'AC outlets' },
  { port: 'dc', label: '12V DC / car port' },
  { port: 'usb', label: 'USB-A + USB-C' },
];

/** The part an outlet is, and the outlet a part is. */
export const outletPart = (port: PortId): string => `outlet.${port}`;
export const portOf = (part: string): PortId | null => OUTLETS.find((outlet) => outletPart(outlet.port) === part)?.port ?? null;

/**
 * Where each reading is kept. The station's own are its old names, on main;
 * everything on another part begins with the part's id (`outlet.ac.on`), as
 * every key off main must.
 */
export const KEYS = {
  mainsPresent: 'input.ac.present',
  mainsWatts: 'input.ac.watts',
  mainsVolts: 'input.ac.volts',
  mainsHz: 'input.ac.hz',
  solarPresent: 'input.solar.present',
  solarWatts: 'input.solar.watts',
  lightOn: 'light.on',
  lightWatts: 'light.watts',
  outletOn: (port: PortId) => `${outletPart(port)}.on`,
  outletWatts: (port: PortId) => `${outletPart(port)}.watts`,
  packSoc: (pack: number) => `pack.${pack}.soc`,
} as const;

/**
 * The settings every station has, by their standard meanings: what a recipe
 * names without knowing this station's keys. The AC charge limit is the
 * charge limit — solar may fill past it, as the station decides.
 */
const SETTING_MEANINGS: Record<string, string> = {
  chargeLimit: 'chargeLimit',
  dischargeFloor: 'dischargeFloor',
  acChargingWatts: 'mainsInputLimit',
};

/** Where each setting is grouped on a generic settings screen. */
const SECTIONS: Record<string, string> = {
  chargeLimit: 'Battery',
  dischargeFloor: 'Battery',
  acChargingWatts: 'Charging',
  acSilentCharging: 'Charging',
  dcInputType: 'Charging',
  maxChargingCurrent: 'Charging',
  stopChargeAfterMinutes: 'Charging',
  ledMode: 'Light and sound',
  keySound: 'Light and sound',
  usbStandbyMinutes: 'Standby',
  acStandbyMinutes: 'Standby',
  dcStandbyMinutes: 'Standby',
  screenRestSeconds: 'Standby',
  sleepMinutes: 'Standby',
  temperatureUnit: 'Display',
};

const number = (unit: string, precision = 0) => ({ type: 'number' as const, unit, precision });

/**
 * What a P280 is: the station, its two inputs, its three outlets, its light
 * and — when the station says some are connected — its expansion batteries,
 * each a part whose charge is kept as history like the station's own.
 *
 * Everything its screens draw is here: they read the station's readings, as
 * any screen does, and nothing the description does not declare.
 *
 * Every key off main begins with its part (`input.ac.present`); a pack's is
 * its position, `pack.1.soc`, which the station reports the same way every
 * time.
 */
export function describeStation(packs = 0): DeviceDescription {
  const parts: Part[] = [
    { id: MAIN_PART, label: 'Station', kind: 'device', icon: 'battery-charging', energy: { role: 'storage' } },
    { id: 'input.ac', label: 'Mains', kind: 'input', icon: 'zap', energy: { role: 'source' } },
    { id: 'input.solar', label: 'Solar', kind: 'input', icon: 'sun', energy: { role: 'source' } },
    ...OUTLETS.map((outlet): Part => ({ id: outletPart(outlet.port), label: outlet.label, kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] })),
    // Not a switch: it has four modes, and the station remembers the mode, which makes it the setting `ledMode`.
    { id: 'light', label: 'Light', kind: 'light', energy: { role: 'load' } },
    ...Array.from({ length: packs }, (_, index): Part => ({ id: `pack.${index + 1}`, label: `Pack ${index + 1}`, kind: 'battery', energy: { role: 'storage' }, parent: MAIN_PART })),
  ];

  const attributes: AttributeSpec[] = [
    { key: 'soc', label: 'Charge', value: number('%', 1), quantity: 'percent', means: 'charge', category: 'primary' },
    { key: 'capacityWh', label: 'Capacity', value: number('Wh'), quantity: 'energy', means: 'capacity', category: 'diagnostic' },
    { key: 'inputWatts', label: 'Input', value: number('W'), quantity: 'power', means: 'input' },
    { key: 'outputWatts', label: 'Output', value: number('W'), quantity: 'power', means: 'output' },
    {
      key: 'state',
      label: 'Doing',
      value: {
        type: 'enum',
        options: [
          { value: 'charging', label: 'Charging' },
          { value: 'discharging', label: 'Supplying' },
          { value: 'idle', label: 'Idle' },
          { value: 'standby', label: 'Standby' },
        ],
      },
      means: 'p280.state',
    },
    { key: 'minutesRemaining', label: 'Runtime left', value: number('min'), quantity: 'duration', means: 'p280.minutesRemaining' },
    { key: 'minutesToFull', label: 'Time to full', value: number('min'), quantity: 'duration', means: 'p280.minutesToFull' },
    { key: 'acOutputVolts', label: 'Inverter voltage', value: number('V', 1), quantity: 'voltage', means: 'p280.inverterVolts', category: 'diagnostic' },
    { key: 'acOutputHz', label: 'Inverter frequency', value: number('Hz', 1), quantity: 'frequency', means: 'p280.inverterHz', category: 'diagnostic' },
    { key: 'chargeBookingMinutes', label: 'Charging deferred', value: number('min'), quantity: 'duration', means: 'p280.chargeDeferred' },

    { key: KEYS.mainsPresent, part: 'input.ac', label: 'Mains present', value: { type: 'boolean' }, means: 'mainsPresent' },
    { key: KEYS.mainsWatts, part: 'input.ac', label: 'From mains', value: number('W'), quantity: 'power', means: 'mainsInput', category: 'primary' },
    { key: KEYS.mainsVolts, part: 'input.ac', label: 'Mains voltage', value: number('V', 1), quantity: 'voltage', means: 'voltage' },
    { key: KEYS.mainsHz, part: 'input.ac', label: 'Mains frequency', value: number('Hz', 1), quantity: 'frequency', means: 'frequency', category: 'diagnostic' },
    { key: KEYS.solarPresent, part: 'input.solar', label: 'Solar connected', value: { type: 'boolean' }, means: 'p280.solarPresent' },
    { key: KEYS.solarWatts, part: 'input.solar', label: 'Solar', value: number('W'), quantity: 'power', means: 'solarInput', category: 'primary' },
    { key: KEYS.lightOn, part: 'light', label: 'Light on', value: { type: 'boolean' }, means: 'p280.lightOn' },
    { key: KEYS.lightWatts, part: 'light', label: 'Light draw', value: number('W'), quantity: 'power', means: 'power' },

    ...OUTLETS.flatMap((outlet): AttributeSpec[] => [
      { key: KEYS.outletOn(outlet.port), part: outletPart(outlet.port), label: outlet.label, value: { type: 'boolean' }, means: 'on' },
      { key: KEYS.outletWatts(outlet.port), part: outletPart(outlet.port), label: `${outlet.label} draw`, value: number('W'), quantity: 'power', means: 'power', category: 'primary' },
    ]),

    ...Array.from({ length: packs }, (_, index): AttributeSpec => ({
      key: KEYS.packSoc(index + 1),
      part: `pack.${index + 1}`,
      label: `Pack ${index + 1} charge`,
      value: number('%', 1),
      quantity: 'percent',
      means: 'charge',
      category: 'primary',
    })),

    ...Object.entries(SETTINGS_SCHEMA.fields).map(
      ([key, field]): AttributeSpec => ({
        key,
        label: field.title,
        ...(field.description ? { description: field.description } : {}),
        value: valueTypeOf(field),
        ...(SETTING_MEANINGS[key] ? { means: SETTING_MEANINGS[key] } : {}),
        access: 'write',
        category: 'config',
        section: SECTIONS[key] ?? 'Other',
        ...(DANGEROUS_SETTINGS.has(key) ? { dangerous: true, consequence: 'The wrong value here can leave the station unable to wake.' } : {}),
      })
    ),
  ];

  // Its mains input's, as `acInput` declares them: anything waiting for mains to go hears this station too.
  const events: EventSpec[] = [
    { id: 'mains.lost', label: 'Mains lost', level: 'warn', part: 'input.ac', description: 'Mains power went away: the station runs its outlets from its battery.' },
    { id: 'mains.restored', label: 'Mains back', level: 'info', part: 'input.ac', description: 'Mains power came back.' },
  ];

  return { parts, attributes, events };
}

/**
 * The station's own settings.
 *
 * Values and steps are this model's, confirmed against real hardware — see
 * `docs/P280-FINDINGS.md`. `sleepMinutes` has no "never" option because writing
 * zero to that register permanently destroys the station, which is why it is
 * also named in `dangerous` rather than merely omitted from the list.
 */
export const SETTINGS_SCHEMA: ConfigSchema = {
  fields: {
    chargeLimit: {
      type: 'number',
      title: 'AC charge limit',
      description: 'Caps charging from mains only — solar will still fill the pack past this.',
      min: 60,
      max: 100,
      unit: '%',
      integer: true,
    },
    dischargeFloor: {
      type: 'number',
      title: 'Discharge floor',
      description: 'Outputs cut off below this level.',
      min: 0,
      max: 50,
      unit: '%',
      integer: true,
    },
    acChargingWatts: {
      type: 'number',
      title: 'AC charging power',
      description: 'How hard the station pulls from the wall: 600 W to 1.8 kW, in the P280’s five steps.',
      min: 600,
      max: 1800,
      step: 300,
      unit: 'W',
      integer: true,
      presentation: 'slider',
    },
    acSilentCharging: {
      type: 'boolean',
      title: 'Silent AC charging',
      description: 'Slower, but keeps the fans down.',
    },
    dcInputType: {
      type: 'enum',
      title: 'DC input type',
      description: 'What is plugged into the XT90 input. Changing this also moves the current ceiling.',
      options: [
        { value: 'pv', label: 'Solar (PV)' },
        { value: 'dc', label: 'DC charger' },
      ],
    },
    maxChargingCurrent: {
      type: 'number',
      title: 'Max charging current',
      description: 'Ceiling for the XT90 input.',
      min: 1,
      max: 20,
      unit: 'A',
      integer: true,
    },
    stopChargeAfterMinutes: {
      type: 'number',
      title: 'Delay charging',
      description: 'A live countdown, not a clock time. Zero means charge now.',
      min: 0,
      max: 1439,
      unit: 'min',
      integer: true,
    },
    ledMode: {
      type: 'enum',
      title: 'LED mode',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
        { value: 'sos', label: 'SOS' },
        { value: 'flash', label: 'Flash' },
      ],
    },
    keySound: { type: 'boolean', title: 'Key sound' },
    usbStandbyMinutes: {
      type: 'enum',
      title: 'USB no-load standby',
      description: 'Short by design — USB switches itself off quickly with nothing drawing.',
      options: [
        { value: '0', label: 'Never' },
        { value: '3', label: '3m' },
        { value: '5', label: '5m' },
        { value: '10', label: '10m' },
        { value: '30', label: '30m' },
      ],
    },
    acStandbyMinutes: {
      type: 'enum',
      title: 'AC no-load standby',
      options: [
        { value: '0', label: 'Never' },
        { value: '480', label: '8h' },
        { value: '960', label: '16h' },
        { value: '1440', label: '24h' },
      ],
    },
    dcStandbyMinutes: {
      type: 'enum',
      title: 'DC no-load standby',
      options: [
        { value: '0', label: 'Never' },
        { value: '480', label: '8h' },
        { value: '960', label: '16h' },
        { value: '1440', label: '24h' },
      ],
    },
    screenRestSeconds: {
      type: 'enum',
      title: 'Screen shutdown',
      description: 'How long the station’s own display stays lit.',
      options: [
        { value: '0', label: 'Never' },
        { value: '180', label: '3 min' },
        { value: '300', label: '5 min' },
        { value: '600', label: '10 min' },
        { value: '1800', label: '30 min' },
      ],
    },
    sleepMinutes: {
      type: 'enum',
      title: 'Whole machine unused time',
      description:
        'Idle time before the station powers down completely. There is deliberately no “never”: ' +
        'that value permanently destroys the station, and the vendor app omits it too.',
      options: [
        { value: '5', label: '5m' },
        { value: '10', label: '10m' },
        { value: '30', label: '30m' },
        { value: '480', label: '8h' },
      ],
    },
    temperatureUnit: {
      type: 'enum',
      title: 'Temperature unit',
      description: 'Display preference only — the station has no register for this.',
      options: [
        { value: 'C', label: 'Celsius' },
        { value: 'F', label: 'Fahrenheit' },
      ],
    },
  },
};

/**
 * The station's own settings that can damage it. `sleepMinutes` has no
 * "never" option because writing zero to that register permanently destroys
 * the station, which is why it is also marked dangerous rather than merely
 * omitted from the list.
 */
export const DANGEROUS_SETTINGS: ReadonlySet<string> = new Set(['sleepMinutes']);

/**
 * Everything the station reports, and its settings, as readings. None at all
 * before the station's first reading: the zeros in their place were charted as
 * a flat battery.
 */
export function readings(status: StationStatus, settings: StationSettings | null): Reading[] {
  const at = status.lastUpdated;
  if (at === null) return [];
  const port = (id: PortId) => status.ports.find((candidate) => candidate.id === id);

  return [
    { key: 'soc', value: status.level, at },
    { key: 'capacityWh', value: status.capacityWh || null, at },
    { key: 'inputWatts', value: status.totalInputWatts, at },
    { key: 'outputWatts', value: status.totalOutputWatts, at },
    { key: 'state', value: status.state, at },
    { key: 'minutesRemaining', value: status.minutesRemaining, at },
    { key: 'minutesToFull', value: status.minutesToFull, at },
    { key: 'acOutputVolts', value: status.acOutputVolts, at },
    { key: 'acOutputHz', value: status.acOutputHz, at },
    { key: 'chargeBookingMinutes', value: status.chargeBookingMinutes, at },
    { key: KEYS.mainsPresent, value: status.gridConnected, at },
    { key: KEYS.mainsWatts, value: status.acInputWatts, at },
    { key: KEYS.mainsVolts, value: status.acInputVolts, at },
    { key: KEYS.mainsHz, value: status.acInputHz, at },
    { key: KEYS.solarPresent, value: status.solarConnected, at },
    { key: KEYS.solarWatts, value: status.solarInputWatts, at },
    { key: KEYS.lightOn, value: port('led')?.enabled ?? null, at },
    { key: KEYS.lightWatts, value: port('led')?.watts ?? null, at },
    ...OUTLETS.flatMap((outlet): Reading[] => [
      { key: KEYS.outletOn(outlet.port), value: port(outlet.port)?.enabled ?? null, at },
      { key: KEYS.outletWatts(outlet.port), value: port(outlet.port)?.watts ?? null, at },
    ]),
    ...status.expansionSoc.map((soc, index): Reading => ({ key: KEYS.packSoc(index + 1), value: soc, at })),
    ...(settings ? Object.entries(settingsToValues(settings)).map(([key, value]): Reading => ({ key, value, at })) : []),
  ];
}

/** What the station says about itself. */
export function infoOf(status: StationStatus): DeviceInfo {
  return {
    manufacturer: 'AFERIY',
    model: status.model,
    ...(status.firmware ? { firmware: { ...status.firmware } } : {}),
  };
}

/**
 * Settings as the schema describes them.
 *
 * Enums are strings in the schema language and numbers on the wire, so the two
 * conversions live here — next to the schema that caused them — rather than
 * being rediscovered by every caller.
 */
export function settingsToValues(settings: StationSettings): Record<string, string | number | boolean> {
  return {
    chargeLimit: settings.chargeLimit,
    dischargeFloor: settings.dischargeFloor,
    acChargingWatts: settings.acChargingWatts,
    acSilentCharging: settings.acSilentCharging,
    dcInputType: settings.dcInputType,
    maxChargingCurrent: settings.maxChargingCurrent,
    stopChargeAfterMinutes: settings.stopChargeAfterMinutes,
    ledMode: settings.ledMode,
    keySound: settings.keySound,
    usbStandbyMinutes: String(settings.usbStandbyMinutes),
    acStandbyMinutes: String(settings.acStandbyMinutes),
    dcStandbyMinutes: String(settings.dcStandbyMinutes),
    screenRestSeconds: String(settings.screenRestSeconds),
    sleepMinutes: String(settings.sleepMinutes),
    temperatureUnit: settings.temperatureUnit,
  };
}

const NUMERIC_ENUMS = new Set([
  'usbStandbyMinutes',
  'acStandbyMinutes',
  'dcStandbyMinutes',
  'screenRestSeconds',
  'sleepMinutes',
]);

/**
 * A partial patch as schema values: only the keys it has. `settingsToValues`
 * needs the whole set, and given one field would send "undefined" for every
 * numeric enum it lacks.
 */
export function patchToValues(patch: Partial<StationSettings>): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    values[key] = NUMERIC_ENUMS.has(key) ? String(value) : (value as string | number | boolean);
  }
  return values;
}

/** The reverse: a form's values, back into a settings patch for the station. */
export function valuesToSettings(values: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    patch[key] = NUMERIC_ENUMS.has(key) ? Number(value) : value;
  }
  return patch;
}

export * from './model/types.ts';
export { STATION_TOOLS } from './tools.ts';
export { stationView, type StationAsSeen } from './view.ts';
export { AC_CHARGING_WATTS, HOLDING, INPUT, LED_MODE_VALUES, WRITABLE, type WriteRule } from './model/registers.ts';
export { describeRegisters, type RegisterDump, type RegisterRow } from './model/diagnostics.ts';
export { PORT_LABELS, buildSettings, buildStatus } from './model/station.ts';
export { PortSwitchError, ReadOnlyError, StaleWriteError, StationClient, type StationLink } from './model/client.ts';

export {
  NO_WRITES_IN_FLIGHT,
  portKey,
  settingsKeys,
  withPending,
  writesInFlight,
  type StationWriteKey,
  type WritesInFlight,
} from './writes.ts';
