import { LIGHT_EXPOSES, MOTION_EXPOSES, PLUG_EXPOSES, SENSOR_EXPOSES, SWITCH_EXPOSES } from './played.ts';
import type { Expose } from './protocol/index.ts';
import { defineZigbeeType } from './zigbee-type.ts';

/*
  The generic Zigbee types, a shelf each (docs/PLAN-ZIGBEE.md §5.3): which
  one a device behind the coordinator is offered as follows from what it
  exposes (`Shape.shelf`), and a group from what its members can do. Each is
  the same implementation (`defineZigbeeType`).
*/

const CLIMATE_EXPOSES: readonly Expose[] = [
  {
    type: 'climate',
    features: [
      { type: 'numeric', name: 'local_temperature', property: 'local_temperature', label: 'Local temperature', access: 5, unit: '°C' },
      { type: 'numeric', name: 'occupied_heating_setpoint', property: 'occupied_heating_setpoint', label: 'Heating setpoint', access: 7, unit: '°C', value_min: 5, value_max: 30, value_step: 0.5 },
      { type: 'enum', name: 'system_mode', property: 'system_mode', label: 'System mode', access: 7, values: ['off', 'heat', 'auto'] },
      { type: 'enum', name: 'running_state', property: 'running_state', label: 'Running state', access: 5, values: ['idle', 'heat'] },
    ],
  },
  { type: 'numeric', name: 'battery', property: 'battery', label: 'Battery', access: 1, unit: '%', category: 'diagnostic' },
];

const LOCK_EXPOSES: readonly Expose[] = [
  { type: 'lock', features: [{ type: 'binary', name: 'state', property: 'state', label: 'State', access: 7, value_on: 'LOCK', value_off: 'UNLOCK' }] },
  { type: 'numeric', name: 'battery', property: 'battery', label: 'Battery', access: 1, unit: '%', category: 'diagnostic' },
];

const COVER_EXPOSES: readonly Expose[] = [
  {
    type: 'cover',
    features: [
      { type: 'enum', name: 'state', property: 'state', label: 'State', access: 3, values: ['OPEN', 'CLOSE', 'STOP'] },
      { type: 'numeric', name: 'position', property: 'position', label: 'Position', access: 7, unit: '%', value_min: 0, value_max: 100 },
    ],
  },
];

export const zigbeePlug = defineZigbeeType({
  id: 'zigbee2mqtt.plug',
  name: 'Zigbee plug',
  category: 'smart-plug',
  icon: 'power',
  description: 'A Zigbee plug paired with the dongle on this server: it switches, and measures what it feeds when it can.',
  typical: PLUG_EXPOSES,
});

export const zigbeeSwitch = defineZigbeeType({
  id: 'zigbee2mqtt.switch',
  name: 'Zigbee switch',
  category: 'relay',
  icon: 'toggle-right',
  description: 'A Zigbee switch or relay paired with the dongle on this server: each of its outputs switched on its own.',
  typical: SWITCH_EXPOSES,
});

export const zigbeeLight = defineZigbeeType({
  id: 'zigbee2mqtt.light',
  name: 'Zigbee light',
  category: 'light',
  icon: 'sun',
  description: 'A Zigbee bulb or light paired with the dongle on this server: on and off, its brightness and its colour.',
  typical: LIGHT_EXPOSES,
});

export const zigbeeSensor = defineZigbeeType({
  id: 'zigbee2mqtt.sensor',
  name: 'Zigbee sensor',
  category: 'sensor',
  icon: 'activity',
  description: 'A Zigbee sensor or button paired with the dongle on this server: what it measures, and each press as it happens.',
  typical: SENSOR_EXPOSES,
  /*
    A simulated one is a sensor in a room someone uses: its temperature and
    humidity, and motion — someone comes in as it starts, and again every
    few minutes, each time moving for a minute.
  */
  simulated: {
    exposes: [...SENSOR_EXPOSES.filter((expose) => expose.name !== 'linkquality'), ...MOTION_EXPOSES.filter((expose) => expose.name === 'occupancy')],
    plays(say, clock) {
      let quiet: ReturnType<typeof clock.setTimeout> | null = null;
      const walk = () => {
        say({ occupancy: true });
        quiet = clock.setTimeout(() => say({ occupancy: false }), WALK_MS);
      };
      walk();
      const again = clock.setInterval(walk, WALK_EVERY_MS);
      return () => (clock.clear(quiet), clock.clear(again));
    },
  },
});

/** How long a simulated someone moves for, and how often they come back. */
const WALK_MS = 60_000;
const WALK_EVERY_MS = 4 * 60_000;

export const zigbeeClimate = defineZigbeeType({
  id: 'zigbee2mqtt.climate',
  name: 'Zigbee thermostat',
  category: 'climate',
  icon: 'thermometer',
  description: 'A Zigbee thermostat or radiator valve paired with the dongle on this server: its temperature, and its setpoint — changed only by a person.',
  typical: CLIMATE_EXPOSES,
});

export const zigbeeLock = defineZigbeeType({
  id: 'zigbee2mqtt.lock',
  name: 'Zigbee lock',
  category: 'lock',
  icon: 'lock',
  description: 'A Zigbee lock paired with the dongle on this server: locked or not — opened only by a person.',
  typical: LOCK_EXPOSES,
});

export const zigbeeCover = defineZigbeeType({
  id: 'zigbee2mqtt.cover',
  name: 'Zigbee blind',
  category: 'cover',
  icon: 'columns',
  description: 'A Zigbee blind, curtain or shutter paired with the dongle on this server: where it is, and where to go.',
  typical: COVER_EXPOSES,
});

export const zigbeeGroup = defineZigbeeType({
  id: 'zigbee2mqtt.group',
  name: 'Zigbee group',
  category: 'relay',
  icon: 'layers',
  description: 'A group of Zigbee plugs or switches, made on the coordinator: switched as one, every one at once.',
  typical: PLUG_EXPOSES.filter((expose) => expose.type === 'switch'),
  group: true,
});

export const zigbeeLightGroup = defineZigbeeType({
  id: 'zigbee2mqtt.light-group',
  name: 'Zigbee light group',
  category: 'light',
  icon: 'layers',
  description: 'A group of Zigbee lights, made on the coordinator: a room’s lamps switched and dimmed as one, every one at once.',
  typical: LIGHT_EXPOSES.filter((expose) => expose.type === 'light'),
  group: true,
});
