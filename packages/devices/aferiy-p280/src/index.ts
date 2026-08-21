import type {
  ConfigSchema,
  ControlSpec,
  DeviceDescriptor,
  MeasurementSpec,
  Reading,
} from '@kraftverk/plugin-sdk';
import type { StationSettings, StationStatus } from '@kraftverk/protocol';

/**
 * The AFERIY P280, described in the device model.
 *
 * Everything model-specific lives here rather than in the server: the AC
 * charging steps are 600–1800 W on this machine and 300–1100 W on a FOSSiBOT,
 * the standby timers offer exactly the values BrightEMS offers, and one of the
 * settings can permanently brick the station. None of that is knowledge the
 * core should carry — it is knowledge about *this device*.
 *
 * The server turns these declarations into the API; the app turns them into
 * screens. Neither needs to know what a P280 is.
 */

export const MEASUREMENTS: MeasurementSpec[] = [
  { key: 'soc', label: 'Charge', unit: '%', kind: 'percent', precision: 1, primary: true },
  { key: 'inputWatts', label: 'Input', unit: 'W', kind: 'power', precision: 0 },
  { key: 'outputWatts', label: 'Output', unit: 'W', kind: 'power', precision: 0 },
  { key: 'solarWatts', label: 'Solar', unit: 'W', kind: 'power', precision: 0 },
  { key: 'acInputWatts', label: 'From mains', unit: 'W', kind: 'power', precision: 0 },
  { key: 'acInputVolts', label: 'Mains voltage', unit: 'V', kind: 'voltage', precision: 1 },
  { key: 'acOutputVolts', label: 'Inverter voltage', unit: 'V', kind: 'voltage', precision: 1 },
  { key: 'minutesRemaining', label: 'Runtime left', unit: 'min', kind: 'duration', precision: 0 },
  { key: 'minutesToFull', label: 'Time to full', unit: 'min', kind: 'duration', precision: 0 },
  { key: 'gridConnected', label: 'Mains present', unit: '', kind: 'state' },
  { key: 'acOn', label: 'AC outlets', unit: '', kind: 'state' },
  { key: 'dcOn', label: '12V DC', unit: '', kind: 'state' },
  { key: 'usbOn', label: 'USB', unit: '', kind: 'state' },
  { key: 'acWatts', label: 'AC outlet draw', unit: 'W', kind: 'power', precision: 0 },
  { key: 'dcWatts', label: 'DC draw', unit: 'W', kind: 'power', precision: 0 },
  { key: 'usbWatts', label: 'USB draw', unit: 'W', kind: 'power', precision: 0 },
];

/**
 * The three outputs, and nothing else.
 *
 * The light is deliberately absent. It looks like a control — you tap it and
 * the lamp changes — but the station *remembers* the mode across a power cycle,
 * and the SDK draws the line exactly there: momentary is a control, remembered
 * is a setting. It lives in `SETTINGS_SCHEMA` as `ledMode`, which is also the
 * only path that can express SOS and flash; the port register behind it is a
 * boolean and would silently reduce four modes to two.
 *
 * Declaring it in both places was the tempting mistake. The generic device
 * screen would then have shown a control that the generic control endpoint
 * cannot honour.
 */
export const CONTROLS: ControlSpec[] = [
  { id: 'ac', label: 'AC outlets', kind: 'switch', capability: 'station.ports', measurementKey: 'acOn' },
  { id: 'dc', label: '12V DC / car port', kind: 'switch', capability: 'station.ports', measurementKey: 'dcOn' },
  { id: 'usb', label: 'USB-A + USB-C', kind: 'switch', capability: 'station.ports', measurementKey: 'usbOn' },
];

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
      type: 'enum',
      title: 'AC charging power',
      description: 'How hard the station pulls from the wall. These five steps are the P280’s.',
      options: [
        { value: '600', label: '600 W' },
        { value: '900', label: '900 W' },
        { value: '1200', label: '1.2 kW' },
        { value: '1500', label: '1.5 kW' },
        { value: '1800', label: '1.8 kW' },
      ],
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
        { value: 'dc', label: 'DC adapter' },
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

/** Settings where a wrong value damages hardware rather than annoying you. */
export const DANGEROUS_SETTINGS = ['sleepMinutes'] as const;

export function descriptor(id: string, name: string, model: string): DeviceDescriptor {
  return {
    id,
    name,
    kind: 'power-station',
    icon: 'zap',
    description: model,
    measurements: MEASUREMENTS,
    controls: CONTROLS,
    settings: { schema: SETTINGS_SCHEMA, dangerous: [...DANGEROUS_SETTINGS] },
    capabilities: ['station.ports'],
  };
}

/** Station telemetry, flattened into the readings the device model expects. */
export function readings(status: StationStatus): Reading[] {
  const at = status.lastUpdated;
  const port = (id: string) => status.ports.find((candidate) => candidate.id === id);

  return [
    { key: 'soc', value: status.level, at },
    { key: 'inputWatts', value: status.totalInputWatts, at },
    { key: 'outputWatts', value: status.totalOutputWatts, at },
    { key: 'solarWatts', value: status.solarInputWatts, at },
    { key: 'acInputWatts', value: status.acInputWatts, at },
    { key: 'acInputVolts', value: status.acInputVolts, at },
    { key: 'acOutputVolts', value: status.acOutputVolts, at },
    { key: 'minutesRemaining', value: status.minutesRemaining, at },
    { key: 'minutesToFull', value: status.minutesToFull, at },
    { key: 'gridConnected', value: status.gridConnected, at },
    { key: 'acOn', value: port('ac')?.enabled ?? null, at },
    { key: 'dcOn', value: port('dc')?.enabled ?? null, at },
    { key: 'usbOn', value: port('usb')?.enabled ?? null, at },
    { key: 'acWatts', value: port('ac')?.watts ?? null, at },
    { key: 'dcWatts', value: port('dc')?.watts ?? null, at },
    { key: 'usbWatts', value: port('usb')?.watts ?? null, at },
  ];
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
    acChargingWatts: String(settings.acChargingWatts),
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
  'acChargingWatts',
  'usbStandbyMinutes',
  'acStandbyMinutes',
  'dcStandbyMinutes',
  'screenRestSeconds',
  'sleepMinutes',
]);

/** The reverse: a form's values, back into a settings patch for the driver. */
export function valuesToSettings(values: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    patch[key] = NUMERIC_ENUMS.has(key) ? Number(value) : value;
  }
  return patch;
}
