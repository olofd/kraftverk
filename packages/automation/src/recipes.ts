import { defineRecipe, type Expr, type Recipe, type RoleSpec, type Step } from './rule.ts';

/**
 * Recipes in the shared vocabulary (docs/AUTOMATIONS.md): rules that name only
 * library capabilities, standard meanings and the events capabilities declare,
 * so any device that offers them fills their roles — a station, a battery
 * monitor, a device nobody has written yet. They live beside the capability
 * library because that is what they are written in; a package's own recipes,
 * which need what only its devices do, ship with the package.
 *
 * Namespaced `standard.`, which no device type may take.
 */

const ACTION = {
  type: 'enum',
  title: 'Then turn it',
  options: [
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ],
} as const;

const SWITCH: RoleSpec = { label: 'What to switch', description: 'A plug, or one outlet of a station', capabilities: ['switch'] };

/** `switch.set`, on or off as the automation's "Then turn it" says. */
const turn: Expr = { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } };

/** "When the battery stays below 20 % for 5 minutes, turn the charger plug on." */
export const lowBattery = defineRecipe({
  id: 'standard.low-battery',
  label: 'When a battery runs low',
  description: 'Switch something when a battery stays below a level for a while: a charger plug on, or a load off.',
  sentence: 'When {battery} stays below {below} for {heldFor}, turn {switch} {action}.',
  roles: {
    battery: { label: 'Battery', description: 'Anything that reports its charge: a station, one of its packs', capabilities: ['battery'] },
    switch: SWITCH,
  },
  params: {
    fields: {
      below: { type: 'number', title: 'Below', unit: '%', min: 5, max: 95, step: 5, default: 20, presentation: 'slider' },
      heldFor: { type: 'number', title: 'For at least', description: 'So a dip for a moment does not count.', unit: 's', min: 0, max: 3600, step: 60, default: 300 },
      action: { ...ACTION, default: 'on' },
    },
  },
  when: [
    {
      becomes: { compare: 'lt', left: { read: { role: 'battery', means: 'charge' } }, right: { param: 'below' } },
      heldFor: { param: 'heldFor' },
    },
  ],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: turn } } }],
});

/** "When the station loses mains power, turn the heater off." */
export const mainsLost = defineRecipe({
  id: 'standard.mains-lost',
  label: 'When mains power is lost',
  description: 'Switch something the moment an AC input says its mains went away: shed a load to save a battery.',
  sentence: 'When {input} loses mains power, turn {switch} {action}.',
  roles: {
    input: { label: 'Mains input', description: 'An AC input that says when mains is lost: a station’s', capabilities: ['acInput'] },
    switch: SWITCH,
  },
  params: { fields: { action: { ...ACTION, default: 'off' } } },
  when: [{ event: { role: 'input', event: 'mains.lost' } }],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: turn } } }],
});

const soc: Expr = { read: { role: 'battery', means: 'charge' } };

/**
 * "Charge the station through the plug that feeds it: on below 15 %, off at
 * 50 %" — a charge window of your own, below what the device's own settings
 * allow, by switching what charges it.
 *
 * One rule, two edges, each with its own id and its own hold: `low` when the
 * charge has stayed below the low level for a while, `high` when it has
 * stayed at the high one or above. Its one step switches the charger on when
 * `low` started it and off when `high` did (`run.trigger`), so each level is
 * written once and the two can never disagree. In between nothing happens —
 * which is the point: the battery charges up from low to high, then runs down
 * again, instead of hovering at one level with the charger clicking. Played
 * by hand between the two, it does nothing either.
 */
export const chargeBetween = defineRecipe({
  id: 'standard.charge-between',
  label: 'Charge between two levels',
  description:
    'Switch what charges a battery on when it runs low and off when it has charged enough: a charge window of your own, with a plug that feeds a station, say.',
  sentence: 'Charge {battery} with {charger}: on once it has been below {low} for {lowFor}, off once it has been at {high} or above for {highFor}.',
  roles: {
    battery: { label: 'Battery', description: 'Anything that reports its charge: a station, one of its packs', capabilities: ['battery'] },
    charger: { label: 'What charges it', description: 'A plug that feeds it, or anything that switches its charger', capabilities: ['switch'] },
  },
  params: {
    fields: {
      low: { type: 'number', title: 'Start charging below', unit: '%', min: 5, max: 90, step: 5, default: 15, presentation: 'slider' },
      lowFor: { type: 'number', title: 'Below it for at least', description: 'So a dip under load for a moment does not count.', unit: 's', min: 0, max: 3600, step: 60, default: 120 },
      high: { type: 'number', title: 'Stop charging at', unit: '%', min: 10, max: 100, step: 5, default: 50, presentation: 'slider' },
      highFor: { type: 'number', title: 'At it or above for at least', description: 'So a reading that touches it for a moment does not count.', unit: 's', min: 0, max: 3600, step: 60, default: 120 },
    },
  },
  when: [
    { id: 'low', becomes: { compare: 'lt', left: soc, right: { param: 'low' } }, heldFor: { param: 'lowFor' } },
    { id: 'high', becomes: { compare: 'ge', left: soc, right: { param: 'high' } }, heldFor: { param: 'highFor' } },
  ],
  // A window that is upside down would switch the charger on and off at once; played between the two, nothing is due.
  if: { all: [{ compare: 'lt', left: { param: 'low' }, right: { param: 'high' } }, { compare: 'ne', left: { run: 'trigger' }, right: { value: '' } }] },
  then: [{ command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { compare: 'eq', left: { run: 'trigger' }, right: { value: 'low' } } } } }],
});

// --- sequences (docs/SEQUENCES.md) ------------------------------------------------------

const SUPPLY: RoleSpec = {
  label: 'What powers the charger',
  description: 'What switches power to the charger’s plug and measures what it gives: a station’s AC output, a plug',
  capabilities: ['switch', 'powerMeter'],
};
const CHARGER: RoleSpec = {
  label: 'The charger’s plug',
  description: 'The smart plug the charger is in: it switches the charger and measures what it draws',
  capabilities: ['switch', 'powerMeter'],
};

const set = (role: string, on: boolean): Step => ({ command: { role, capability: 'switch', command: 'set', args: { on: { value: on } } } });
const draws = (role: string): Expr => ({ read: { role, means: 'power' } });

/**
 * "Start charging": power the charger, wait for its plug, switch it on, and
 * make sure it charges — waking a charger that stays idle when its power
 * comes on by switching it off and on again, a few times at most. If it never
 * does, what it switched on is switched off again, unless its owner chose to
 * leave it.
 */
export const startCharging = defineRecipe({
  id: 'standard.start-charging',
  label: 'Start charging',
  description:
    'Power a charger through its supply, switch its plug on, and make sure it draws — switching it off and on again if it stays idle, a few times at most.',
  roles: { supply: SUPPLY, charger: CHARGER },
  params: {
    fields: {
      reachSeconds: {
        type: 'number',
        title: 'Wait for the charger’s plug',
        description: 'It has no power until the supply is on, and needs a moment to be reachable again.',
        unit: 's',
        min: 10,
        max: 600,
        step: 10,
        default: 120,
      },
      chargingAbove: { type: 'number', title: 'Charging when it draws over', description: 'An idle charger draws next to nothing; a charging one, far more.', unit: 'W', min: 5, max: 500, step: 5, default: 50 },
      withinSeconds: { type: 'number', title: 'Give it', description: 'How long the charger is given to start drawing, each time.', unit: 's', min: 5, max: 120, step: 5, default: 20 },
      offSeconds: { type: 'number', title: 'Off for', description: 'When it does not start: how long its plug is switched off before it is switched on again.', unit: 's', min: 3, max: 60, step: 1, default: 5 },
      tries: { type: 'number', title: 'Tries at most', description: 'How often it is switched off and on again before it gives up: some chargers need several.', min: 1, max: 5, step: 1, integer: true, default: 5 },
      ifItFails: {
        type: 'enum',
        title: 'If it never starts charging',
        options: [
          { value: 'switchOff', label: 'Switch it and its supply off again' },
          { value: 'leaveOn', label: 'Leave them on' },
        ],
        default: 'switchOff',
      },
    },
  },
  when: [],
  then: [
    set('supply', true),
    { waitUntil: { condition: { reachable: 'charger' }, atMost: { param: 'reachSeconds' } } },
    set('charger', true),
    {
      ensure: {
        condition: { compare: 'gt', left: draws('charger'), right: { param: 'chargingAbove' } },
        within: { param: 'withinSeconds' },
        tries: { param: 'tries' },
        retry: [set('charger', false), { wait: { for: { param: 'offSeconds' } } }, set('charger', true)],
      },
    },
  ],
  otherwise: [{ choose: { if: { compare: 'eq', left: { param: 'ifItFails' }, right: { value: 'switchOff' } }, then: [set('charger', false), set('supply', false)] } }],
});

/**
 * "Stop charging": in reverse — the charger's plug off at once, then its
 * supply, but only if nothing else draws from it: the supply is watched for a
 * few seconds after the charger is off, and left on if anything draws more
 * than a little.
 */
export const stopCharging = defineRecipe({
  id: 'standard.stop-charging',
  label: 'Stop charging',
  description:
    'Switch a charger’s plug off, then its supply — unless something else still draws from the supply, watched for a few seconds after the charger is off.',
  roles: { supply: SUPPLY, charger: CHARGER },
  params: {
    fields: {
      watchSeconds: { type: 'number', title: 'Watch the supply for', description: 'After the charger is off, how long the supply is watched for anything else drawing from it.', unit: 's', min: 3, max: 120, step: 1, default: 5 },
      othersBelow: {
        type: 'number',
        title: 'Nothing else draws below',
        description: 'What the supply may still give with the charger off and count as nothing: its own idle draw.',
        unit: 'W',
        min: 1,
        max: 200,
        step: 1,
        default: 10,
      },
    },
  },
  when: [],
  then: [
    set('charger', false),
    {
      watch: {
        condition: { compare: 'lt', left: draws('supply'), right: { param: 'othersBelow' } },
        for: { param: 'watchSeconds' },
        then: [set('supply', false)],
      },
    },
  ],
});

const rank: Expr = { read: { role: 'prices', means: 'priceRank' } };

/**
 * "Charge in the day's four cheapest hours" — from any service that reports
 * what an hour's price ranks among the day's (`energyPrice`). Two edges, as
 * the charge window has: into the cheapest hours it turns on, out of them it
 * turns off, and it sets the switch to "among the cheapest?" either way.
 */
export const cheapHours = defineRecipe({
  id: 'standard.cheap-hours',
  label: 'In the cheapest hours',
  description: 'Switch something on in the day’s cheapest hours, by the electricity price, and off again in the others: a charger, a heater.',
  sentence: 'Turn {switch} on in the {hours} cheapest hours of the day by {prices}, off in the others.',
  roles: {
    prices: { label: 'Prices', description: 'Where the electricity prices come from', capabilities: ['energyPrice'] },
    switch: { label: 'What to switch', description: 'A plug, or one outlet of a station', capabilities: ['switch'] },
  },
  params: {
    fields: {
      hours: { type: 'number', title: 'How many hours', description: 'How many of the day’s hours it is on: the cheapest that many.', min: 1, max: 23, step: 1, integer: true, default: 4 },
    },
  },
  when: [{ becomes: { compare: 'le', left: rank, right: { param: 'hours' } } }, { becomes: { compare: 'gt', left: rank, right: { param: 'hours' } } }],
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { compare: 'le', left: rank, right: { param: 'hours' } } } } }],
});

export const STANDARD_RECIPES: readonly Recipe[] = [lowBattery, chargeBetween, mainsLost, startCharging, stopCharging, cheapHours];
