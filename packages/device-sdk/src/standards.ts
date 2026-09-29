import type { CapabilityName } from './capabilities.ts';
import { quantityOf, stateClassOf, unitOf, type AttributeSpec } from './description.ts';
import type { Quantity, StandardMeaningId, StateClass } from './meanings.ts';

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

export type HomeAssistantPlatform = 'sensor' | 'binary_sensor' | 'switch';

/**
 * Home Assistant's sensor device class for a quantity, and the units it
 * accepts for it; null where Home Assistant has no class and shows the unit as
 * given (a percentage that is not a battery).
 */
export const HOME_ASSISTANT_QUANTITIES: Readonly<Record<Quantity, { deviceClass: string | null; units: readonly string[] }>> = {
  power: { deviceClass: 'power', units: ['W', 'kW'] },
  energy: { deviceClass: 'energy', units: ['Wh', 'kWh', 'MWh'] },
  percent: { deviceClass: null, units: ['%'] },
  voltage: { deviceClass: 'voltage', units: ['V', 'mV'] },
  current: { deviceClass: 'current', units: ['A', 'mA'] },
  temperature: { deviceClass: 'temperature', units: ['°C', '°F', 'K'] },
  frequency: { deviceClass: 'frequency', units: ['Hz', 'kHz'] },
  duration: { deviceClass: 'duration', units: ['s', 'min', 'h', 'd'] },
  humidity: { deviceClass: 'humidity', units: ['%'] },
  illuminance: { deviceClass: 'illuminance', units: ['lx'] },
  signal: { deviceClass: 'signal_strength', units: ['dBm', 'dB'] },
  // An on/off state is a binary sensor, not a sensor with a class.
  state: { deviceClass: null, units: [''] },
};

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
  OnOff: 0x0006,
  PowerSource: 0x002f,
  ElectricalPowerMeasurement: 0x0090,
  ElectricalEnergyMeasurement: 0x0091,
  IlluminanceMeasurement: 0x0400,
  TemperatureMeasurement: 0x0402,
  RelativeHumidityMeasurement: 0x0405,
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
  'battery.soc': {
    homeAssistant: { platform: 'sensor', deviceClass: 'battery' },
    // Matter counts in half-percents: 0–200.
    matter: { cluster: 'PowerSource', attribute: 'BatPercentRemaining', scale: 2 },
  },
  'battery.capacity': {
    homeAssistant: { platform: 'sensor', deviceClass: 'energy_storage' },
    matter: { none: 'Matter states battery capacity in mAh, not energy' },
  },
  'power.in': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'power.in.ac': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'power.in.solar': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'power.out': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'power.draw': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActivePower', scale: 1000 },
  },
  'energy.total': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    // kWh to mWh.
    matter: { cluster: 'ElectricalEnergyMeasurement', attribute: 'CumulativeEnergyImported', scale: 1_000_000 },
  },
  'voltage.ac': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'Voltage', scale: 1000 },
  },
  'current.ac': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'ActiveCurrent', scale: 1000 },
  },
  'frequency.ac': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { cluster: 'ElectricalPowerMeasurement', attribute: 'Frequency', scale: 1000 },
  },
  'grid.present': {
    homeAssistant: { platform: 'binary_sensor', deviceClass: 'power' },
    matter: { cluster: 'PowerSource', attribute: 'WiredPresent', scale: 1 },
  },
  'switch.on': {
    homeAssistant: { platform: 'switch', deviceClass: 'outlet' },
    matter: { cluster: 'OnOff', attribute: 'OnOff', scale: 1 },
  },
  'weather.temp': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    // Hundredths of a degree.
    matter: { cluster: 'TemperatureMeasurement', attribute: 'MeasuredValue', scale: 100 },
  },
  'weather.cloud': {
    homeAssistant: { platform: 'sensor', deviceClass: null },
    matter: { none: 'Matter has no cloud-cover measurement' },
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
  'weather.forecast': {
    homeAssistant: { none: 'MQTT discovery has no weather platform, and Home Assistant has its own forecasts' },
    matter: { none: 'Matter does not describe forecasts' },
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
    deviceClass: meaning?.homeAssistant.deviceClass ?? (platform === 'sensor' && quantity ? HOME_ASSISTANT_QUANTITIES[quantity].deviceClass : null),
    stateClass: stateClass ? HOME_ASSISTANT_STATE_CLASSES[stateClass] : null,
    unit: platform === 'sensor' && unit ? unit : null,
  };
}
