import type { CapabilityName } from './capabilities.ts';
import { quantityOf, stateClassOf, unitOf, type AttributeSpec } from './description.ts';
import type { StandardMeaningId, StateClass } from './meanings.ts';
import { quantitySpec } from './quantities.ts';

/**
 * Projections: what kraftverk's vocabulary is called in the standards it sits
 * beside (docs/ARCHITECTURE.md §4.1, §4.8).
 *
 * Every quantity, state class, standard meaning and capability says what it is
 * in Home Assistant and in Matter — or says plainly that it has no counterpart,
 * and why. A bridge to either is then a table lookup, not a project, and a new
 * meaning or capability cannot be added without deciding how it projects: the
 * maps below are typed over the whole vocabulary, so a gap does not compile.
 *
 * Matter values are integers in fixed units, so a Matter projection carries the
 * scale from kraftverk's unit to Matter's: power in W is ActivePower in mW,
 * scale 1000.
 */

/** Something with no counterpart, and why — so "none" is a decision, not a gap. */
export type NoProjection = { none: string };

// --- Home Assistant -----------------------------------------------------------

/** A `number` is a value Home Assistant can set: a station's charge limit. A `device_tracker` is where something is. */
export type HomeAssistantPlatform = 'sensor' | 'binary_sensor' | 'switch' | 'number' | 'device_tracker' | 'button';

/** Home Assistant uses the same three state classes, by the same names. */
export const HOME_ASSISTANT_STATE_CLASSES: Readonly<Record<StateClass, string>> = {
  measurement: 'measurement',
  total: 'total',
  total_increasing: 'total_increasing',
};

export type HomeAssistantEntity = {
  platform: HomeAssistantPlatform;
  /** The device class, when it is more specific than the quantity's own (a battery's charge). */
  deviceClass: string | null;
};

// --- Matter -------------------------------------------------------------------

/** The Matter clusters kraftverk's vocabulary maps to, by name and id. */
export const MATTER_CLUSTERS = {
  Identify: 0x0003,
  OnOff: 0x0006,
  LevelControl: 0x0008,
  PowerSource: 0x002f,
  ElectricalPowerMeasurement: 0x0090,
  ElectricalEnergyMeasurement: 0x0091,
  IlluminanceMeasurement: 0x0400,
  TemperatureMeasurement: 0x0402,
  RelativeHumidityMeasurement: 0x0405,
  MediaPlayback: 0x0506,
  KeypadInput: 0x0509,
  ApplicationLauncher: 0x050c,
} as const;

export type MatterCluster = keyof typeof MATTER_CLUSTERS;

export type MatterAttribute = {
  cluster: MatterCluster;
  attribute: string;
  /** Matter's value = kraftverk's × scale, rounded. 1 when the units agree. */
  scale: number;
};

// --- standard meanings --------------------------------------------------------

export type MeaningProjection = {
  homeAssistant: HomeAssistantEntity;
  matter: MatterAttribute | NoProjection;
};

/**
 * Each standard meaning, projected. Power on a device with several flows —
 * a station's input and output — is one ElectricalPowerMeasurement per part:
 * the attribute is the same.
 */
export const MEANING_PROJECTIONS: Readonly<Record<StandardMeaningId, MeaningProjection>> = {
  'charge': {
    homeAssistant: { platform: 'sensor', deviceClass: 'battery' },
    // Matter counts in half-percents: 0–200.
    matter: { cluster: 'PowerSource', attribute: 'BatPercentRemaining', scale: 2 },
  },
  'capacity': {
    homeAssistant: { platform: 'sensor', deviceClass: 'energy_storage' },
    matter: { none: 'Matter states battery capacity in mAh, not energy' },
  },
  'chargeLimit': {
    homeAssistant: { platform: 'number', deviceClass: null },
    matter: { none: 'Matter has no setting for the charge a store stops charging at' },
  },
  'dischargeFloor': {
    homeAssistant: { platform: 'number', deviceClass: null },
    matter: { none: 'Matter has no setting for the charge a store stops supplying at' },
  },
  'input': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'mainsInput': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'solarInput': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'mainsInputLimit': {
    homeAssistant: { platform: 'number', deviceClass: null },
    matter: { none: 'Matter has no setting for how hard a store charges from mains' },
  },
  'output': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'power': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'energy': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    // kWh to mWh.
    matter: { cluster: 'ElectricalEnergyMeasurement', attribute: 'CumulativeEnergyImported', scale: 1_000_000 },
  },
  'voltage': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'Voltage', scale: 1000 },
  },
  'current': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActiveCurrent', scale: 1000 },
  },
  'frequency': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'Frequency', scale: 1000 },
  },
  'mainsPresent': {
    homeAssistant: { platform: 'binary_sensor', deviceClass: 'power' },
    matter: { cluster: 'PowerSource', attribute: 'WiredPresent', scale: 1 },
  },
  'on': {
    homeAssistant: { platform: 'switch', deviceClass: 'outlet' },
    matter: { cluster: 'OnOff', attribute: 'OnOff', scale: 1 },
  },
  'temperature': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    // Hundredths of a degree.
    matter: { cluster: 'TemperatureMeasurement', attribute: 'MeasuredValue', scale: 100 },
  },
  'price': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { none: 'Matter states tariffs in clusters kraftverk does not project yet' },
  },
  'priceRank': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { none: 'Matter has no rank of an hour by price' },
  },
  'cloudCover': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { none: 'Matter has no cloud-cover measurement' },
  },
  'position': {
    // Its latitude, longitude and accuracy are a device tracker's own attributes, gps_accuracy for the last.
    homeAssistant: { platform: 'device_tracker', deviceClass: null },
    matter: { none: 'Matter does not describe where a device is' },
  },
  'playing': {
    homeAssistant: { platform: 'binary_sensor', deviceClass: null },
    matter: { none: 'Matter says what a player does as one of four states (MediaPlayback CurrentState), not as playing or not' },
  },
  'volume': {
    homeAssistant: { platform: 'number', deviceClass: null },
    // 0 to 254 for 0 to 100 %.
    matter: { cluster: 'LevelControl', attribute: 'CurrentLevel', scale: 2.54 },
  },
};

// --- capabilities -------------------------------------------------------------

export type CapabilityProjection = {
  /** How Home Assistant shows a device offering it; its attributes project one by one. */
  homeAssistant: { platforms: readonly HomeAssistantPlatform[]; commands: Readonly<Record<string, string>> } | NoProjection;
  /** The cluster it is, and what each command is called there. */
  matter: { clusters: readonly MatterCluster[]; commands: Readonly<Record<string, string>> } | NoProjection;
};

export const CAPABILITY_PROJECTIONS: Readonly<Record<CapabilityName, CapabilityProjection>> = {
  switch: {
    homeAssistant: { platforms: ['switch'], commands: { set: 'turn_on / turn_off' } },
    matter: { clusters: ['OnOff'], commands: { set: 'On / Off' } },
  },
  powerMeter: {
    homeAssistant: { platforms: ['sensor'], commands: {} },
    matter: { clusters: ['ElectricalPowerMeasurement', 'ElectricalEnergyMeasurement'], commands: {} },
  },
  battery: {
    homeAssistant: { platforms: ['sensor'], commands: {} },
    matter: { clusters: ['PowerSource'], commands: {} },
  },
  acInput: {
    homeAssistant: { platforms: ['binary_sensor', 'sensor'], commands: {} },
    matter: { clusters: ['PowerSource'], commands: {} },
  },
  energyPrice: {
    homeAssistant: { platforms: ['sensor'], commands: {} },
    matter: { none: 'Matter states tariffs in clusters kraftverk does not project yet' },
  },
  'weather.forecast': {
    homeAssistant: { none: 'MQTT discovery has no weather platform, and Home Assistant has its own forecasts' },
    matter: { none: 'Matter does not describe forecasts' },
  },
  identify: {
    homeAssistant: { platforms: ['button'], commands: { identify: 'press (device class identify)' } },
    matter: { clusters: ['Identify'], commands: { identify: 'Identify' } },
  },
  location: {
    homeAssistant: { platforms: ['device_tracker'], commands: {} },
    matter: { none: 'Matter does not describe where a device is' },
  },
  mediaPlayback: {
    homeAssistant: { none: 'MQTT discovery has no media player: Home Assistant reaches a TV with its own integration' },
    matter: { clusters: ['MediaPlayback'], commands: { set: 'Play / Pause', next: 'Next', previous: 'Previous' } },
  },
  keypadInput: {
    homeAssistant: { none: 'MQTT discovery has no remote: Home Assistant reaches a TV with its own integration' },
    matter: { clusters: ['KeypadInput'], commands: { press: 'SendKey' } },
  },
  applicationLauncher: {
    homeAssistant: { none: 'MQTT discovery has no media player: Home Assistant reaches a TV with its own integration' },
    matter: { clusters: ['ApplicationLauncher'], commands: { launch: 'LaunchApp' } },
  },
  volume: {
    homeAssistant: { platforms: ['number'], commands: { set: 'set_value' } },
    matter: { clusters: ['LevelControl'], commands: { set: 'MoveToLevel' } },
  },
};

export const isProjected = <T extends object>(projection: T | NoProjection): projection is T => !('none' in projection);

/**
 * How Home Assistant should show one attribute — a standard meaning or a
 * type's own: its platform, device class, state class and unit. What a bridge
 * publishes for it. An enum is a sensor with options; text is a sensor too.
 */
export function homeAssistantEntityOf(attribute: Pick<AttributeSpec, 'value' | 'means' | 'quantity' | 'stateClass'>): HomeAssistantEntity & {
  stateClass: string | null;
  unit: string | null;
} {
  const meaning = attribute.means && Object.hasOwn(MEANING_PROJECTIONS, attribute.means) ? MEANING_PROJECTIONS[attribute.means as StandardMeaningId] : null;
  const quantity = quantityOf(attribute);
  const platform = meaning?.homeAssistant.platform ?? (attribute.value.type === 'boolean' ? 'binary_sensor' : 'sensor');
  const stateClass = platform === 'sensor' ? stateClassOf(attribute) : null;
  const unit = unitOf(attribute);
  return {
    platform,
    deviceClass:
      meaning?.homeAssistant.deviceClass ??
      (attribute.value.type === 'timestamp' ? 'timestamp' : platform === 'sensor' && quantity ? quantitySpec(quantity).homeAssistant : null),
    stateClass: stateClass ? HOME_ASSISTANT_STATE_CLASSES[stateClass] : null,
    unit: platform === 'sensor' && unit ? unit : null,
  };
}
