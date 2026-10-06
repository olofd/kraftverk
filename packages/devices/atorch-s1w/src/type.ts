import type { ProfileDatapoint, SocketProfile } from '@kraftverk/integration-tuya/protocol';
import { defineTuyaSocket } from '@kraftverk/integration-tuya';
import type { Unit } from '@kraftverk/device-sdk';

/**
 * The ATORCH S1W / S1WP / S1BW: a Tuya energy socket with an LCD meter, its own
 * protection, and the plug kraftverk's reserve feature was designed around —
 * upstream of a power station's AC input.
 *
 * Every datapoint here was established on a real S1BW (README.md): changed in
 * the maker's app while kraftverk held the plug's connection, and read off the
 * wire. The relay is switched on DP 131 in words; DP 1 only reports it, and
 * writing DP 1 leaves the relay where it was while the plug reports otherwise.
 *
 * What is offered as a setting is chosen, not everything the plug has: what
 * happens after a power cut, the safety cut-off, and the display. The plug's own
 * modes and timers (its "smart power off", its countdown, its pricing) are
 * kraftverk's automations' and history's job, done better there; they are read,
 * so that a cut they cause is explained, and never offered.
 */

const number = (unit: Unit | undefined, min: number, max: number, step?: number) =>
  ({ type: 'number', ...(unit ? { unit } : {}), min, max, ...(step ? { step, precision: Math.max(0, -Math.floor(Math.log10(step))) } : { integer: true }) }) as const;

const SAFETY = 'Safety cut-off';
const DISPLAY = 'Display';
const BILL = 'Bill';

/** A limit whose wrong value cuts what the plug feeds, or stops protecting it. */
const LIMIT = { access: 'write', category: 'config', section: SAFETY, dangerous: true } as const;

/** Read to explain what the plug did; not a setting. */
const FACT = { category: 'diagnostic', history: false } as const;

const DATAPOINTS: readonly ProfileDatapoint[] = [
  // --- what the plug did, and why -------------------------------------------------------------
  {
    dp: 132,
    key: 'cutBy',
    label: 'Switched itself off',
    description: 'Why the plug switched its power off by itself: its safety cut-off, or a rule set in the maker’s app.',
    value: {
      type: 'enum',
      options: [
        { value: 'none', label: 'No' },
        { value: 'underVoltage', label: 'The voltage was too low' },
        { value: 'overVoltage', label: 'The voltage was too high' },
        { value: 'overCurrent', label: 'The current was too high' },
        { value: 'overPower', label: 'The power was too high' },
        { value: 'lowPower', label: 'A rule in the maker’s app: the draw stayed low' },
        { value: 'highPower', label: 'A rule in the maker’s app: the draw stayed high' },
        { value: 'timedOn', label: 'A timer in the maker’s app' },
        { value: 'timedOff', label: 'A timer in the maker’s app' },
        { value: 'cycle', label: 'A timer in the maker’s app' },
        { value: 'countdown', label: 'A countdown in the maker’s app' },
      ],
    },
    wire: {
      none: 'off',
      underVoltage: 'lvp',
      overVoltage: 'ovp',
      overCurrent: 'ocp',
      overPower: 'opp',
      lowPower: 'outage_a',
      highPower: 'outage_b',
      timedOn: 'timing_open',
      timedOff: 'timing_close',
      cycle: 'loop_timing',
      countdown: 'countdown',
    },
    category: 'diagnostic',
    example: 'none',
    raises: { event: 'cut', label: 'The plug switched itself off', level: 'warn', clear: 'none' },
  },
  {
    dp: 142,
    key: 'backOnIn',
    label: 'Back on in',
    description: 'After a safety cut-off the plug waits until the fault has cleared, counts this down, and switches itself back on.',
    value: { type: 'number', unit: 's', integer: true, min: 0 },
    quantity: 'duration',
    ...FACT,
    example: 0,
  },
  {
    dp: 118,
    key: 'rule',
    label: 'Rule inside the plug',
    description: 'A rule set in the maker’s app that the plug can run by itself. kraftverk shows it so a cut is explained; its own automations do the same job.',
    value: {
      type: 'enum',
      options: [
        { value: 'none', label: 'None' },
        { value: 'lowPower', label: 'Off when the draw stays low' },
        { value: 'highPower', label: 'Off when the draw stays high' },
        { value: 'timedOff', label: 'Off after a time' },
        { value: 'timedOn', label: 'On after a time' },
        { value: 'cycle', label: 'On and off in a cycle' },
      ],
    },
    // The plug's words are its screen's pages: "safety_protection" is the price and bill page, "wifi1" the protection page. Neither runs a rule.
    wire: { none: ['safety_protection', 'wifi1'], lowPower: 'outage_a', highPower: 'outage_b', timedOff: 'timing_close', timedOn: 'timing_open', cycle: 'loop_timing' },
    // Written only to clear it — "leave the switching to kraftverk" — never offered as a choice.
    access: 'write',
    ...FACT,
    example: 'none',
  },
  { dp: 119, key: 'lowPowerWatts', label: 'Low-draw rule: under', value: number('W', 1, 999), quantity: 'power', ...FACT, example: 100 },
  { dp: 120, key: 'lowPowerMinutes', label: 'Low-draw rule: for', value: number('min', 1, 99), quantity: 'duration', ...FACT, example: 10 },
  { dp: 121, key: 'highPowerWatts', label: 'High-draw rule: over', value: number('W', 1, 9999), quantity: 'power', ...FACT, example: 500 },
  { dp: 122, key: 'highPowerHours', label: 'High-draw rule: for', value: number('h', 1, 99), quantity: 'duration', ...FACT, example: 1 },
  { dp: 135, key: 'temperature', label: 'Temperature inside', value: { type: 'number', unit: '°C', integer: true }, quantity: 'temperature', stateClass: 'measurement', category: 'diagnostic', example: 40 },

  // --- after a power cut -----------------------------------------------------------------------
  {
    dp: 138,
    key: 'afterPowerCut',
    label: 'After a power cut',
    description: 'What the plug does when the mains comes back. It keeps this itself, so it holds even with kraftverk down.',
    value: { type: 'enum', options: [{ value: 'asItWas', label: 'Back to how it was' }, { value: 'on', label: 'Always on' }, { value: 'off', label: 'Stay off' }] },
    // "colse": the plug's own spelling.
    wire: { asItWas: 'memory', on: 'open', off: 'colse' },
    access: 'write',
    category: 'config',
    section: 'Power',
    consequence: 'Stay off leaves whatever it feeds without power after every cut until someone switches it on — a flat station with no way to charge.',
    example: 'asItWas',
  },

  // --- the safety cut-off ------------------------------------------------------------------------
  {
    dp: 139,
    key: 'safetyCutOff',
    label: 'Safety cut-off',
    description: 'Cuts the power when the supply or the load goes outside the limits below, and turns it back on once the fault has cleared.',
    value: { type: 'boolean' },
    ...LIMIT,
    consequence: 'Off, the plug no longer cuts on too much current or power, or a bad supply.',
    example: true,
  },
  { dp: 104, key: 'maxVoltage', label: 'Voltage above', value: number('V', 0.1, 275, 0.1), quantity: 'voltage', scale: 1, ...LIMIT, consequence: 'Set below the mains voltage, the plug cuts at once.', example: 265 },
  { dp: 141, key: 'minVoltage', label: 'Voltage below', value: number('V', 0.1, 275, 0.1), quantity: 'voltage', scale: 1, ...LIMIT, consequence: 'Set above the mains voltage, the plug cuts at once.', example: 75 },
  { dp: 105, key: 'maxCurrent', label: 'Current above', value: number('A', 0.01, 20, 0.01), quantity: 'current', scale: 2, ...LIMIT, consequence: 'Set below what the load draws, the plug cuts it.', example: 16 },
  { dp: 106, key: 'maxPower', label: 'Power above', value: number('W', 1, 4500), quantity: 'power', ...LIMIT, consequence: 'Set below what the load draws, the plug cuts it.', example: 4500 },
  { dp: 103, key: 'cutAfter', label: 'Wait before cutting', description: 'How long a fault must last. Short spikes shorter than this are ridden through.', value: number('s', 0, 2, 0.1), quantity: 'duration', scale: 1, ...LIMIT, example: 0.3 },
  {
    dp: 137,
    key: 'backOnAfter',
    label: 'Back on after',
    description: 'How long the fault must have been gone before the plug switches itself back on.',
    value: number('min', 0, 99),
    quantity: 'duration',
    ...LIMIT,
    example: 3,
  },

  // --- display -------------------------------------------------------------------------------------
  { dp: 108, key: 'brightness', label: 'Brightness', value: number(undefined, 1, 9), access: 'write', category: 'config', section: DISPLAY, example: 6 },
  { dp: 109, key: 'dimmedBrightness', label: 'Dimmed brightness', value: number(undefined, 1, 9), access: 'write', category: 'config', section: DISPLAY, example: 3 },
  { dp: 110, key: 'dimAfter', label: 'Dim after', value: number('s', 3, 99), quantity: 'duration', access: 'write', category: 'config', section: DISPLAY, example: 60 },
  {
    dp: 117,
    key: 'dimmedShows',
    label: 'When dimmed, show',
    value: { type: 'enum', options: [{ value: 'readings', label: 'The readings' }, { value: 'clock', label: 'The start screen' }, { value: 'nothing', label: 'Nothing' }] },
    // "Screen off" is "calendar" on the wire; "original" is the start screen.
    wire: { readings: 'measurement', clock: 'original', nothing: 'calendar' },
    access: 'write',
    category: 'config',
    section: DISPLAY,
    example: 'readings',
  },
  { dp: 111, key: 'keyBeep', label: 'Beep on key press', value: { type: 'boolean' }, access: 'write', category: 'config', section: DISPLAY, example: true },
  {
    dp: 107,
    key: 'language',
    label: 'Language',
    value: { type: 'enum', options: [{ value: 'english', label: 'English' }, { value: 'chinese', label: 'Chinese' }] },
    access: 'write',
    category: 'config',
    section: DISPLAY,
    example: 'english',
  },

  // --- the bill on its screen ------------------------------------------------------------------
  {
    dp: 101,
    key: 'price',
    label: 'Price per kWh',
    description: 'What its screen multiplies the energy by to show a cost. In your own currency: the plug keeps no unit.',
    value: number(undefined, 0, 999.99, 0.01),
    scale: 2,
    access: 'write',
    category: 'config',
    section: BILL,
    example: 1,
  },
  { dp: 102, key: 'cost', label: 'Cost on its screen', value: { type: 'number', precision: 2, min: 0 }, scale: 3, category: 'diagnostic', example: 0 },
];

/**
 * Its datapoints, as the unit showed them (README.md §4). Left out on purpose,
 * the Datapoints tool still showing each raw:
 * - the countdown and timers (9, 124–130): kraftverk's automations time things,
 *   and say why when they act;
 * - the price mode (136): tiers B and C have no settings the app showed;
 * - the switch mode (112): "normally open" was never tried, and may stop the
 *   plug being switched remotely;
 * - resetting Wi-Fi and every setting (114, 115): the plug leaves the network.
 * The plug's own rules (118–122) are read, to explain a cut, and can be
 * stopped; they are not set from here, because switching the plug from
 * kraftverk takes it out of Auto and ends them anyway.
 */
export const ATORCH_S1: SocketProfile = {
  id: 'atorch-s1',
  label: 'ATORCH S1W / S1WP / S1BW',
  productKeys: ['sqrf2g1amfutn4co', 'pl28o0wkaopyft8u'],
  relay: { dp: 131, on: 'open', off: 'close', status: 1, cutWhile: { dp: 132, clear: 'off' } },
  metrics: {
    amps: { dp: 18, scale: 3 },
    watts: { dp: 19, scale: 2 },
    volts: { dp: 20, scale: 2 },
    kwh: { dp: 123, scale: 3 },
    hz: { dp: 133, scale: 2 },
    powerFactor: { dp: 134, scale: 2 },
  },
  datapoints: DATAPOINTS,
  // "Faster refresh after activation": readings every second, lapsing after five minutes (README.md §4).
  refresh: { dp: 140, lapsesAfterMs: 5 * 60_000 },
  buttons: [
    { id: 'rotateScreen', dp: 116, label: 'Turn the screen around', description: 'Turns what the plug’s screen shows upside down, or back: for a plug that sits the other way up in its socket.' },
    {
      id: 'resetEnergy',
      dp: 113,
      label: 'Reset the energy counter',
      description: 'Sets the energy total the plug counts, and the cost its screen shows, back to zero. kraftverk’s own history is kept.',
      confirm: 'The plug’s energy total and cost go back to zero, and cannot be brought back. kraftverk’s history of it is kept.',
    },
  ],
};

export default defineTuyaSocket({
  id: 'atorch.s1w',
  meta: {
    name: 'ATORCH S1W',
    brand: 'ATORCH',
    models: ['S1W', 'S1WP', 'S1BW'],
    description: 'A Wi-Fi socket with a power meter, a display and its own safety cut-off, switched and read over your home network with no cloud.',
    support: 'verified',
    supportNote: 'Every datapoint established on an S1BW, protocol 3.5.',
    docsUrl: 'packages/devices/atorch-s1w/README.md',
  },
  profiles: [ATORCH_S1],
});
