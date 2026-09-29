import { defineRecipe, type Expr } from '@kraftverk/device-sdk';

/**
 * What the station brings to automations (docs/AUTOMATIONS.md): two recipes,
 * as data. Each names capabilities, not this product — a battery that runs
 * low, a mains input that goes away — so any device that offers them fills
 * the role; the station is only where they come from.
 */

/** Raises `mains.lost` and `mains.restored` when the station's mains presence changes — never on its first reading. */
export function mainsWatcher(raise: (event: 'mains.lost' | 'mains.restored') => void): (present: boolean | null) => void {
  let last: boolean | null = null;
  return (present) => {
    if (present === null) return;
    if (last !== null && present !== last) raise(present ? 'mains.restored' : 'mains.lost');
    last = present;
  };
}

const ACTION = {
  type: 'enum',
  title: 'Then turn it',
  options: [
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ],
} as const;

const SWITCH = { label: 'What to switch', description: 'A plug, or one outlet of a station', capabilities: ['switch'] } as const;

/** `switch.set`, on or off as the automation's "Then turn it" says. */
const turn: Expr = { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } };

/** "When the battery stays below 20 % for 5 minutes, turn the charger plug on." */
export const lowBattery = defineRecipe({
  id: 'aferiy.p280.low-battery',
  label: 'When the battery runs low',
  description: 'Switch something when a battery stays below a level for a while: a charger plug on, or a load off.',
  sentence: 'When {battery} stays below {below} for {minutes}, turn {switch} {action}.',
  roles: {
    battery: { label: 'Battery', description: 'A station, or anything that reports its charge', capabilities: ['battery'] },
    switch: SWITCH,
  },
  params: {
    fields: {
      below: { type: 'number', title: 'Below', unit: '%', min: 5, max: 95, step: 5, default: 20 },
      minutes: { type: 'number', title: 'For at least', description: 'So a dip for a moment does not count.', unit: 'min', min: 0, max: 60, step: 1, default: 5 },
      action: { ...ACTION, default: 'on' },
    },
  },
  when: [
    {
      becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'battery.soc' } }, right: { param: 'below' } },
      heldForMinutes: { param: 'minutes' },
    },
  ],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: turn } } }],
});

/** "When the station loses mains power, turn the heater off." */
export const mainsLost = defineRecipe({
  id: 'aferiy.p280.mains-lost',
  label: 'When mains power is lost',
  description: 'Switch something the moment a station says its mains went away: shed a load to save the battery.',
  sentence: 'When {station} loses mains power, turn {switch} {action}.',
  roles: {
    station: { label: 'Mains input', description: 'The mains input of a station that says when it is lost', capabilities: ['acInput'] },
    switch: SWITCH,
  },
  params: { fields: { action: { ...ACTION, default: 'off' } } },
  when: [{ event: { role: 'station', event: 'mains.lost' } }],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: turn } } }],
});
