import { defineContribution, defineFunction, defineRecipe } from '@kraftverk/automation';
import { defineDeviceType, MAIN_PART, type DeviceDescription, type DeviceSession, type Value } from '@kraftverk/device-sdk';

/*
  Kinds of device of the hub's tests' own, beside the lamp (`src/testing.ts`):
  a station with a battery, a mains input, outlets it switches and settings
  it keeps — one of which can harm it; a plug with a power meter, drawing
  240 W, whose tools include one that cannot be undone; and a forecast, a
  service with a recipe of its own. Each is only ever added simulated: the
  least that exercises what the home does with such things, naming no
  product.
*/

/** A device's state as a simulator keeps it, every value read now. */
type State = Record<string, Value>;

/** A simulator: its state, read as observed now; a switch on a part sets `<part>.on` (or `on` on main); settings written as told. */
function simulator(state: State, options: { description?: DeviceDescription; info?: Record<string, string>; switched?: (part: string, on: boolean) => void; tools?: DeviceSession['tools']; query?: DeviceSession['query'] }): DeviceSession {
  return {
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: new Date().toISOString() }),
    readings: () => Object.entries(state).map(([key, value]) => ({ key, value, at: new Date().toISOString() })),
    description: () => options.description ?? null,
    info: () => options.info ?? null,
    async command(request) {
      if (request.capability !== 'switch' || typeof request.args.on !== 'boolean') return { accepted: false, error: 'It only switches' };
      state[request.part === MAIN_PART ? 'on' : `${request.part}.on`] = request.args.on;
      options.switched?.(request.part, request.args.on);
      return { accepted: true };
    },
    async write(patch) {
      Object.assign(state, patch);
      return { ...state };
    },
    identity: () => ({ id: null, name: null }),
    ...(options.query ? { query: options.query } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    close: async () => {},
  };
}

/** A way to reach each over the lamp's bus: every type needs one of its own, and these are only ever simulated. */
const overTheBus = [{ id: 'bus', label: 'Test bus', protocol: 'test-lamp', transport: 'bus', reach: 'local' as const, updates: 'poll' as const }];
const neverOverTheBus = {
  async identify(): Promise<never> {
    throw new Error('Only simulated in these tests');
  },
  async createSession(): Promise<never> {
    throw new Error('Only simulated in these tests');
  },
};

// --- a station -----------------------------------------------------------------------

/** A station: its battery on main, a mains input, AC and DC outlets it switches, and two settings — one that can harm it. */
const STATION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device', energy: { role: 'storage' } },
    { id: 'input.ac', label: 'Mains', kind: 'input' },
    { id: 'outlet.ac', label: 'AC outlets', kind: 'outlet', offers: ['switch'] },
    { id: 'outlet.dc', label: '12V DC / car port', kind: 'outlet', offers: ['switch'] },
  ],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'charge' },
    { key: 'input.ac.present', part: 'input.ac', label: 'Mains present', value: { type: 'boolean' }, means: 'mainsPresent' },
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'AC outlets', value: { type: 'boolean' }, means: 'on' },
    { key: 'outlet.ac.watts', part: 'outlet.ac', label: 'AC draw', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power' },
    { key: 'outlet.dc.on', part: 'outlet.dc', label: '12V DC / car port', value: { type: 'boolean' }, means: 'on' },
    {
      key: 'ledMode',
      label: 'Light',
      value: { type: 'enum', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'sos', label: 'SOS' }] },
      access: 'write',
      category: 'config',
    },
    {
      key: 'sleepMinutes',
      label: 'Sleeps after',
      value: { type: 'enum', options: [{ value: '0', label: 'Never' }, { value: '480', label: '8 hours' }] },
      access: 'write',
      category: 'config',
      dangerous: true,
      consequence: 'Asleep, it cannot be reached until someone wakes it.',
    },
  ],
  events: [
    { id: 'mains.lost', part: 'input.ac', label: 'Mains lost', level: 'warn' },
    { id: 'mains.restored', part: 'input.ac', label: 'Mains back', level: 'info' },
  ],
};

/** What a simulated station says it is: its type's description, and the pack it has plugged in. */
const WITH_PACK: DeviceDescription = {
  ...STATION,
  parts: [...STATION.parts!, { id: 'pack.1', label: 'Pack 1', kind: 'battery', energy: { role: 'storage' } }],
  attributes: [...STATION.attributes, { key: 'pack.1.soc', part: 'pack.1', label: 'Pack 1 charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'charge' }],
};

export const stationType = defineDeviceType({
  id: 'test.station',
  kind: 'hardware',
  meta: { name: 'Test station', category: 'power-station', support: 'experimental', icon: 'zap', models: ['S1'] },
  describe: () => STATION,
  config: { fields: {} },
  connections: overTheBus,
  ...neverOverTheBus,
  async createSimulator() {
    const state: State = { soc: 80, 'input.ac.present': true, 'outlet.ac.on': false, 'outlet.ac.watts': 0, 'outlet.dc.on': false, ledMode: 'off', sleepMinutes: '0', 'pack.1.soc': 78 };
    return simulator(state, { description: WITH_PACK, info: { manufacturer: 'Test works', model: 'S1' } });
  },
});

// --- a plug --------------------------------------------------------------------------

const PLUG: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Socket', kind: 'outlet', offers: ['switch'] }],
  attributes: [
    { key: 'on', label: 'Power', value: { type: 'boolean' }, means: 'on' },
    { key: 'watts', label: 'Power', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power' },
  ],
};

export const plugType = defineDeviceType({
  id: 'test.plug',
  kind: 'hardware',
  meta: { name: 'Test plug', category: 'smart-plug', support: 'experimental', icon: 'power', models: ['P1'] },
  describe: () => PLUG,
  config: { fields: {} },
  tools: {
    resetEnergy: {
      label: 'Reset the energy total',
      description: 'Sets the energy it has counted back to zero.',
      writes: true,
      confirm: 'Its energy total goes back to zero, and cannot be brought back.',
      answer: { type: 'boolean' },
    },
    rotateScreen: { label: 'Turn the screen', description: 'Turns its display round.', writes: true, answer: { type: 'boolean' } },
  },
  connections: overTheBus,
  ...neverOverTheBus,
  async createSimulator() {
    // On, and drawing: switching it off is cutting a load.
    const state: State = { on: true, watts: 240 };
    return simulator(state, {
      switched: (_part, on) => void (state.watts = on ? 240 : 0),
      tools: { resetEnergy: async () => true, rotateScreen: async () => true },
    });
  },
});

// --- a forecast ----------------------------------------------------------------------

const FORECAST: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Forecast', kind: 'sensor', offers: ['weather.forecast'] }],
  attributes: [],
};

/** A forecast is a service: reached, in its other way, only from a node trusted with an account's password. */
export const forecastType = defineDeviceType({
  id: 'test.forecast',
  kind: 'service',
  meta: { name: 'Test forecast', category: 'weather', support: 'experimental', icon: 'cloud' },
  describe: () => FORECAST,
  config: { fields: {} },
  connections: [...overTheBus, { id: 'cloud', label: 'Its cloud', protocol: 'test-lamp', transport: 'bus', reach: 'cloud', updates: 'poll', needs: { trusted: 'your account password stays at home' } }],
  ...neverOverTheBus,
  async createSimulator() {
    return simulator(
      {},
      {
        // Clear skies, hour by hour.
        query: async () => Array.from({ length: 72 }, (_, hour) => ({ at: new Date(Date.now() + hour * 3_600_000).toISOString(), cloudCover: 0 })),
      }
    );
  },
});

const skyLooks = defineFunction({
  id: 'test.forecast.skyLooks',
  label: 'How the sky looks',
  description: 'Sunny or cloudy, on the day asked about.',
  needs: { capabilities: ['weather.forecast'] },
  args: { day: { type: 'enum', options: [{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }] } },
  returns: { type: 'enum', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },
  async evaluate() {
    return { value: 'sunny', detail: 'It looks sunny' };
  },
});

/** "If tomorrow is sunny, turn the plug on": the recipe the forecast's package brings. */
const forecastSwitch = defineRecipe({
  id: 'test.forecast.forecast-switch',
  label: 'Switch by the forecast',
  description: 'Once a day, switch something on or off depending on whether the day looks sunny.',
  sentence: 'At {at}, if {day} looks {condition} by {forecast}, turn {switch} {action}.',
  roles: {
    forecast: { label: 'Forecast', description: 'Where the forecast comes from', capabilities: ['weather.forecast'] },
    switch: { label: 'What to switch', description: 'A plug, or one outlet of a station', capabilities: ['switch'] },
  },
  params: {
    fields: {
      at: { type: 'enum', title: 'When', default: '07:00', options: ['07:00', '09:00'].map((hour) => ({ value: hour, label: hour })) },
      day: { type: 'enum', title: 'Which day', default: 'today', options: [{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }] },
      condition: { type: 'enum', title: 'If it looks', default: 'sunny', options: [{ value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }] },
      action: { type: 'enum', title: 'Then turn it', default: 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
    },
  },
  when: [{ at: { param: 'at' } }],
  if: { compare: 'eq', left: { call: 'test.forecast.skyLooks', role: 'forecast', args: { day: { param: 'day' } } }, right: { param: 'condition' } },
  then: [{ command: { role: 'switch', capability: 'switch', command: 'set', args: { on: { compare: 'eq', left: { param: 'action' }, right: { value: 'on' } } } } }],
});

export const forecastContribution = defineContribution({ functions: [skyLooks], recipes: [forecastSwitch] });
