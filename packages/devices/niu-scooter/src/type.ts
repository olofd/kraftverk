import {
  defineDeviceType,
  identityOf,
  MAIN_PART,
  type DeviceContext,
  type DeviceDescription,
  type DeviceInfo,
  type DeviceSession,
  type Reading,
  type SessionHealth,
  type ToolSpec,
  type Value,
} from '@kraftverk/device-sdk';
import { clientOver, NIU_API, NiuError, parseState, type NiuBatteryHealth, type NiuClient, type NiuVehicle, type NiuState, type NiuTotals } from '@kraftverk/protocol-niu-cloud';

/**
 * A NIU electric scooter, as NIU's cloud tells of it (README.md).
 *
 * One of this age has no way in but NIU's cloud: its control unit reports
 * over the mobile network, and we read that back from NIU with the owner's
 * account — as the NIU app does. So it is only as current as its last report,
 * and every reading carries the time the scooter made it, not when we asked:
 * a scooter asleep reports seldom, and says so by its age.
 *
 * What it is for, first: its charge, and whether it is charging — so a smart
 * plug in front of its charger can stop it at a limit ("Charge between two
 * levels", with this battery and that plug). Its range, odometer and state
 * come with them. Where it is — NIU knows its position — is left out: it is
 * where its owner lives and rides.
 *
 * Commands NIU's cloud takes for newer models (the alarm, power) are not
 * here yet: whether this one takes any is still to be learnt, and powering a
 * scooter or disarming its alarm from afar is not something to guess at.
 */

type Config = Record<string, never>;

/** How often it is read while charging, or with a charger in: a charge moves about 1 % in 3–4 minutes. */
const CHARGING_EVERY_MS = 60_000;
/** Otherwise: an idle scooter's charge barely moves, and NIU is asked gently. */
const IDLE_EVERY_MS = 10 * 60_000;
/** Its totals and battery health change slowly. */
const SLOW_EVERY_MS = 30 * 60_000;
/**
 * How long a report stays current. Charging, the scooter reports every few
 * minutes; asleep, seldom — and a charge that old is not known, so nothing
 * acts on it. To be measured on a real one (README.md).
 */
const CURRENT_FOR_MS = 30 * 60_000;

const BATTERY = 'battery';

const DESCRIPTION: DeviceDescription = {
  // The scooter's charge is the scooter's headline, as a station's is: it leads its card, and it is what a charge
  // window charges. The battery part is the pack's own health.
  parts: [
    { id: MAIN_PART, label: 'Scooter', kind: 'device', icon: 'navigation', energy: { role: 'storage' } },
    { id: BATTERY, label: 'Battery', kind: 'battery' },
  ],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%', precision: 0 }, means: 'battery.soc', category: 'primary', currentFor: CURRENT_FOR_MS },
    { key: 'charging', label: 'Charging', value: { type: 'boolean' }, currentFor: CURRENT_FOR_MS },
    { key: 'chargerConnected', label: 'Charger connected', value: { type: 'boolean' }, currentFor: CURRENT_FOR_MS },
    { key: 'minutesToFull', label: 'Until full', value: { type: 'number', unit: 'min', precision: 0 }, quantity: 'duration', currentFor: CURRENT_FOR_MS },
    { key: 'battery.temperature', part: BATTERY, label: 'Temperature', value: { type: 'number', unit: '°C', precision: 0 }, quantity: 'temperature', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'battery.health', part: BATTERY, label: 'Health', value: { type: 'number', unit: '%', precision: 0 }, quantity: 'percent', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'battery.cycles', part: BATTERY, label: 'Charge cycles', value: { type: 'number', integer: true }, stateClass: 'total_increasing', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'range', label: 'Range', value: { type: 'number', unit: 'km', precision: 0 }, quantity: 'distance', currentFor: CURRENT_FOR_MS },
    { key: 'odometer', label: 'Odometer', value: { type: 'number', unit: 'km', precision: 1 }, quantity: 'distance', stateClass: 'total_increasing', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'speed', label: 'Speed', value: { type: 'number', unit: 'km/h', precision: 0 }, quantity: 'speed', currentFor: CURRENT_FOR_MS },
    { key: 'poweredOn', label: 'Powered on', value: { type: 'boolean' }, currentFor: CURRENT_FOR_MS },
    { key: 'alarmArmed', label: 'Alarm armed', value: { type: 'boolean' }, currentFor: CURRENT_FOR_MS },
    // What each value means on this model is still being mapped: raw until it is (README.md).
    { key: 'lockStatus', label: 'Lock status (raw)', value: { type: 'number', integer: true }, category: 'diagnostic', currentFor: CURRENT_FOR_MS },
    { key: 'mobileSignal', label: 'Mobile signal', value: { type: 'number', integer: true }, category: 'diagnostic', currentFor: CURRENT_FOR_MS },
    { key: 'gpsSignal', label: 'GPS signal', value: { type: 'number', integer: true }, category: 'diagnostic', currentFor: CURRENT_FOR_MS },
    { key: 'controlUnitBattery', label: 'Control unit battery', value: { type: 'number', unit: '%', precision: 0 }, quantity: 'percent', category: 'diagnostic', currentFor: CURRENT_FOR_MS },
  ],
  events: [
    { id: 'charging.started', label: 'Started charging', level: 'info', data: { soc: { type: 'number', unit: '%' } } },
    { id: 'charging.finished', label: 'Stopped charging', level: 'info', data: { soc: { type: 'number', unit: '%' } } },
  ],
};

/** Figures in, readings out — each stamped with when the scooter reported it. */
export function readingsOf(state: NiuState | null, batteries: readonly NiuBatteryHealth[], totals: NiuTotals | null, at: string, slowAt: string | null): Reading[] {
  const readings: Reading[] = [];
  const add = (key: string, value: Value, when: string | null) => {
    if (when) readings.push({ key, value, at: when });
  };
  if (state) {
    add('soc', state.soc, at);
    add('charging', state.charging, at);
    add('chargerConnected', state.chargerConnected, at);
    add('minutesToFull', state.minutesToFull, at);
    add('range', state.rangeKm, at);
    add('speed', state.speedKmh, at);
    add('poweredOn', state.poweredOn, at);
    add('alarmArmed', state.alarmArmed, at);
    add('lockStatus', state.lockStatus, at);
    add('mobileSignal', state.gsm, at);
    add('gpsSignal', state.gps, at);
    add('controlUnitBattery', state.controlUnitBattery, at);
  }
  // One battery in a UQi: its health is the battery's. Several: the first's, until a scooter with two is mapped.
  const battery = batteries[0];
  if (battery) {
    add('battery.temperature', battery.temperature, slowAt);
    add('battery.health', battery.health, slowAt);
    add('battery.cycles', battery.cycles, slowAt);
  }
  if (totals) add('odometer', totals.odometerKm, slowAt);
  return readings;
}

/** A charge that started or stopped between two reports: an event, with the charge then. Not on the first report. */
export function chargingEventOf(before: NiuState | null, now: NiuState): { id: 'charging.started' | 'charging.finished'; soc: number | null } | null {
  if (before?.charging === null || before?.charging === undefined || now.charging === null || before.charging === now.charging) return null;
  return { id: now.charging ? 'charging.started' : 'charging.finished', soc: now.soc };
}

/** Where a scooter is: left out of everything this reads, the raw tool too. */
const PLACE_FIELDS = new Set(['postion', 'position', 'lat', 'lng', 'latitude', 'longitude', 'gpsList', 'location', 'address']);

/** A NIU answer with its position taken out, for reading by a person. */
export function withoutPlace(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPlace);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PLACE_FIELDS.has(key)).map(([key, inner]) => [key, withoutPlace(inner)]));
  }
  return value;
}

const TOOLS: Readonly<Record<string, ToolSpec>> = {
  raw: {
    label: 'What NIU says',
    description:
      'Every field NIU’s cloud gives for the scooter, raw — its state (and which of NIU’s calls answered), its batteries and its totals — with its position left out. How a model is mapped: change one thing, read again, see what moved.',
    writes: false,
    answer: {
      type: 'object',
      fields: { from: { type: 'string' }, state: { type: 'string' }, batteries: { type: 'string' }, totals: { type: 'string' } },
      required: ['from', 'state'],
    },
  },
};

const json = (value: unknown) => JSON.stringify(withoutPlace(value), null, 2);

async function realSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  if (!ctx.connection) throw new Error('A NIU scooter is reached through NIU’s cloud');
  const { client, serial } = clientOver(ctx.connection);

  let state: NiuState | null = null;
  let stateAt: string | null = null;
  let batteries: NiuBatteryHealth[] = [];
  let totals: NiuTotals | null = null;
  let slowAt: string | null = null;
  let scooter: NiuVehicle | null = null;
  let lastAsked = 0;
  let lastSlow = 0;
  let error: string | null = null;

  const readSlow = async () => {
    [batteries, totals] = await Promise.all([client.batteries(serial), client.totals(serial)]);
    slowAt = new Date().toISOString();
    lastSlow = Date.now();
  };

  const read = async () => {
    const next = await client.state(serial);
    const event = chargingEventOf(state, next);
    state = next;
    // When the scooter reported it; NIU not saying, when we were told.
    stateAt = next.at ?? new Date().toISOString();
    if (event) ctx.event(event.id, { soc: event.soc });
  };

  const tick = async () => {
    const busy = state?.charging === true || state?.chargerConnected === true;
    const due = Date.now() - lastAsked >= (busy ? CHARGING_EVERY_MS : IDLE_EVERY_MS);
    const slowDue = Date.now() - lastSlow >= SLOW_EVERY_MS;
    if (!due && !slowDue) return;
    try {
      if (due) {
        lastAsked = Date.now();
        await read();
      }
      if (slowDue) await readSlow();
      error = null;
    } catch (thrown) {
      error = thrown instanceof NiuError ? thrown.message : `NIU could not be reached: ${(thrown as Error).message}`;
      ctx.log.warn(error);
    }
    ctx.changed();
  };

  // Which scooter this is, by name and model, for its About page: once.
  void client
    .scooters()
    .then((all) => {
      scooter = all.find((candidate) => candidate.serial === serial) ?? null;
      ctx.changed();
    })
    .catch(() => undefined);
  ctx.schedule(CHARGING_EVERY_MS / 2, tick);
  void tick();

  return {
    health(): SessionHealth {
      if (error) return { status: 'error', detail: error, lastReadingAt: stateAt };
      if (!state || !stateAt) return { status: 'connecting', detail: 'Asking NIU’s cloud', lastReadingAt: null };
      return { status: 'connected', detail: `Last reported ${new Date(stateAt).toLocaleString()}, through NIU’s cloud`, lastReadingAt: stateAt };
    },
    readings: () => (stateAt ? readingsOf(state, batteries, totals, stateAt, slowAt) : []),
    info: (): DeviceInfo => ({ manufacturer: 'NIU', serial, ...(scooter?.model ? { model: scooter.model } : {}) }),
    identity: () => ({ id: identityOf('niu-cloud', serial), name: scooter?.name ?? null }),
    command: async () => ({ accepted: false, error: 'It takes no commands here yet: which ones NIU’s cloud takes for this model is still being learnt' }),
    tools: {
      raw: async () => {
        const [{ data, from }, batteriesRaw, totalsRaw] = await Promise.all([client.stateRaw(serial), client.batteriesRaw(serial).catch((thrown) => ({ error: (thrown as Error).message })), client.totalsRaw(serial).catch((thrown) => ({ error: (thrown as Error).message }))]);
        return { from, state: json(data), batteries: json(batteriesRaw), totals: json(totalsRaw) };
      },
    },
    close: async () => undefined,
  };
}

/**
 * A scooter with no NIU account: it charges from 30 % to 90 % at about 1 %
 * in 3.5 minutes — as a UQi's battery on its charger — then is ridden back
 * down, and again. Its reports are a minute apart, as NIU's are while charging.
 */
function simulatedSession(ctx: DeviceContext<Config>): DeviceSession {
  let soc = ctx.store.get<number>('soc') ?? 55;
  let charging = ctx.store.get<boolean>('charging') ?? true;
  let odometer = ctx.store.get<number>('odometer') ?? 4180.4;
  let at = new Date().toISOString();
  const state = (): NiuState => ({
    at,
    soc: Math.round(soc),
    batteries: [{ compartment: 'A', connected: true, soc: Math.round(soc) }],
    charging,
    chargerConnected: charging,
    minutesToFull: charging ? Math.round((100 - soc) * 3.5) : null,
    rangeKm: Math.round(soc * 0.55),
    speedKmh: charging ? 0 : 24,
    poweredOn: !charging,
    alarmArmed: charging,
    lockStatus: charging ? 0 : 1,
    gsm: 4,
    gps: charging ? 2 : 5,
    controlUnitBattery: 100,
  });

  ctx.schedule(60_000, () => {
    const before = state();
    if (charging) soc = Math.min(90, soc + 60 / 210);
    else {
      soc = Math.max(30, soc - 0.8);
      odometer += 0.4;
    }
    if (charging && soc >= 90) charging = false;
    else if (!charging && soc <= 30) charging = true;
    at = new Date().toISOString();
    ctx.store.set('soc', soc);
    ctx.store.set('charging', charging);
    ctx.store.set('odometer', odometer);
    const event = chargingEventOf(before, state());
    if (event) ctx.event(event.id, { soc: event.soc });
    ctx.changed();
  });

  const batteries: NiuBatteryHealth[] = [{ compartment: 'A', soc: null, temperature: 21, health: 96, cycles: 212 }];
  return {
    health: () => ({ status: 'connected', detail: 'Simulated: charging and riding by itself', lastReadingAt: at }),
    readings: () => readingsOf(state(), batteries, { odometerKm: Math.round(odometer * 10) / 10, daysOwned: 1800 }, at, at),
    info: () => ({ manufacturer: 'NIU', model: 'UQi GT Sport', serial: 'SIMULATED' }),
    command: async () => ({ accepted: false, error: 'It takes no commands here yet' }),
    tools: {
      raw: async () => ({ from: 'simulated', state: json(state()), batteries: json(batteries), totals: json({ totalMileage: odometer }) }),
    },
    close: async () => undefined,
  };
}

export default defineDeviceType<Config>({
  id: 'niu.scooter',
  kind: 'hardware',
  meta: {
    name: 'NIU scooter',
    brand: 'NIU',
    models: ['UQi GT Sport', 'UQi GT'],
    category: 'vehicle',
    description: 'A NIU electric scooter, read from NIU’s cloud with your NIU account: its charge, whether it is charging, its range and its odometer. With a smart plug in front of its charger, charge it to a limit.',
    support: 'experimental',
    supportNote: 'Read from NIU’s cloud the way others found it; being mapped on a 2019 UQi GT Sport.',
    icon: 'navigation',
  },
  config: { fields: {} },
  describe: () => DESCRIPTION,
  tools: TOOLS,
  connections: [
    {
      id: 'cloud',
      label: 'NIU’s cloud',
      description: 'Through NIU’s servers, with the account you use in the NIU app. Needs the internet: the scooter reports to NIU over the mobile network.',
      protocol: 'niu-cloud',
      transport: 'https',
      address: NIU_API,
      reach: 'cloud',
      serverOnly: 'your NIU password stays on your server, and NIU’s cloud does not answer a web page.',
    },
  ],

  async identify(connection) {
    const { client, serial } = clientOver(connection);
    const scooters = await client.scooters();
    const scooter = scooters.find((candidate) => candidate.serial === serial);
    if (!scooter) throw new Error('That scooter is no longer on the NIU account');
    const { data } = await client.stateRaw(serial);
    const state = parseState(data);
    const said = [
      state.soc === null ? 'charge not known' : `${Math.round(state.soc)} % charged`,
      state.charging ? 'charging' : null,
      state.rangeKm === null ? null : `${state.rangeKm} km of range`,
      state.at ? `last reported ${new Date(state.at).toLocaleString()}` : 'NIU gives no report time',
    ].filter(Boolean);
    return {
      identity: identityOf('niu-cloud', serial),
      model: scooter.model,
      ...(scooter.name ? { name: scooter.name } : {}),
      summary: `${scooter.model ?? 'NIU scooter'}: ${said.join(', ')}.`,
      info: { manufacturer: 'NIU', serial, ...(scooter.model ? { model: scooter.model } : {}) },
    };
  },

  createSession: realSession,
  createSimulator: async (ctx) => simulatedSession(ctx),
});

export type { NiuClient };
