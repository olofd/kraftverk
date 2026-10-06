import {
  defineDeviceType,
  identityOf,
  MAIN_PART,
  type DeviceContext,
  type DeviceDescription,
  type DeviceInfo,
  type DeviceSession,
  type DeviceType,
  type DeviceTypeMeta,
  type OpenConnection,
  type Reading,
  type SessionHealth,
  type ToolSpec,
  type Value,
} from '@kraftverk/device-sdk';
import { clientOver, NIU_API, NiuError, parseState, type NiuBatteryHealth, type NiuClient, type NiuVehicle, type NiuState, type NiuTotals } from '@kraftverk/protocol-niu-cloud';

import { ago, REPORT_TRUSTED_MS } from './report.ts';

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
 * How long a report stays current. Charging or switched on, the scooter
 * reports every few minutes, and a report older than this is not known — so
 * nothing acts on it. Parked, it reports seldom, but nothing moves: see
 * `confirmedSince`. To be measured on a real one (README.md).
 */
const CURRENT_FOR_MS = REPORT_TRUSTED_MS;

const BATTERY = 'battery';

const YES_NO = { true: 'Yes', false: 'No' };

/**
 * Parked: not charging, no charger in, not switched on. Its charge does not
 * move then, so its last report stands for as long as NIU keeps answering —
 * however long ago the scooter made it. A scooter left in the garage for a
 * week still has its charge, and a plug in front of its charger can act on it.
 */
export const isParked = (state: NiuState): boolean => state.charging !== true && state.poweredOn !== true;

/**
 * When its report was last confirmed to still hold: parked, when NIU last
 * answered (`Reading.confirmedAt`) — its readings stay current from then,
 * while their time stays when the scooter reported. Charging or switched on,
 * an old report may have moved on: nothing confirms it but a new one.
 */
export function confirmedSince(state: NiuState, reportedAt: string, answeredAt: string): string | null {
  return isParked(state) && Date.parse(answeredAt) > Date.parse(reportedAt) ? answeredAt : null;
}

/** Its state in a word, for the line beside its health: what a person asks first. */
const stateWord = (state: NiuState): string => (state.charging ? 'Charging' : state.poweredOn ? 'Switched on' : 'Parked');

const DESCRIPTION: DeviceDescription = {
  // The scooter's charge is the scooter's headline, as a station's is: it leads its card, and it is what a charge
  // window charges. The battery part is the pack's own health.
  parts: [
    { id: MAIN_PART, label: 'Scooter', kind: 'device', icon: 'navigation', energy: { role: 'storage' } },
    { id: BATTERY, label: 'Battery', kind: 'battery' },
  ],
  // In the order a person asks: how full, how far, is it charging. A card shows the first three.
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%', precision: 0 }, means: 'charge', category: 'primary', currentFor: CURRENT_FOR_MS },
    { key: 'range', label: 'Range', value: { type: 'number', unit: 'km', precision: 0 }, quantity: 'distance', currentFor: CURRENT_FOR_MS },
    { key: 'charging', label: 'Charging', value: { type: 'boolean', words: YES_NO }, currentFor: CURRENT_FOR_MS },
    { key: 'minutesToFull', label: 'Until full', value: { type: 'number', unit: 'min', precision: 0 }, quantity: 'duration', currentFor: CURRENT_FOR_MS },
    { key: 'odometer', label: 'Odometer', value: { type: 'number', unit: 'km', precision: 1 }, quantity: 'distance', stateClass: 'total_increasing', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'poweredOn', label: 'Switched on', value: { type: 'boolean', words: YES_NO }, currentFor: CURRENT_FOR_MS },
    { key: 'alarmArmed', label: 'Alarm', value: { type: 'boolean', words: { true: 'Armed', false: 'Not armed' } }, currentFor: CURRENT_FOR_MS },
    { key: 'battery.health', part: BATTERY, label: 'Health', value: { type: 'number', unit: '%', precision: 0 }, quantity: 'percent', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'battery.temperature', part: BATTERY, label: 'Temperature', value: { type: 'number', unit: '°C', precision: 0 }, quantity: 'temperature', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    { key: 'battery.cycles', part: BATTERY, label: 'Charge cycles', value: { type: 'number', integer: true }, stateClass: 'total_increasing', category: 'diagnostic', currentFor: SLOW_EVERY_MS * 2 },
    // What NIU says for working things out, not for reading at a glance, and nothing to keep a history of: a speed
    // from reports minutes apart is no speed curve; a lock status is raw until mapped (README.md).
    { key: 'speed', label: 'Speed at its last report', value: { type: 'number', unit: 'km/h', precision: 0 }, quantity: 'speed', category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
    { key: 'online', label: 'Reaching NIU', value: { type: 'boolean', words: YES_NO }, category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
    { key: 'lockStatus', label: 'Lock status (raw)', value: { type: 'number', integer: true }, category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
    { key: 'mobileSignal', label: 'Mobile signal', value: { type: 'number', integer: true }, category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
    { key: 'gpsSignal', label: 'GPS signal', value: { type: 'number', integer: true }, category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
    { key: 'controlUnitBattery', label: 'Control unit battery', value: { type: 'number', unit: '%', precision: 0 }, quantity: 'percent', category: 'diagnostic', history: false, currentFor: CURRENT_FOR_MS },
  ],
  events: [
    { id: 'charging.started', label: 'Started charging', level: 'info', data: { soc: { type: 'number', unit: '%' } } },
    { id: 'charging.finished', label: 'Stopped charging', level: 'info', data: { soc: { type: 'number', unit: '%' } } },
  ],
};

/** Figures in, readings out — each stamped with when the scooter reported it. */
export function readingsOf(
  state: NiuState | null,
  batteries: readonly NiuBatteryHealth[],
  totals: NiuTotals | null,
  at: string,
  slowAt: string | null,
  confirmedAt: string | null = null
): Reading[] {
  const readings: Reading[] = [];
  const add = (key: string, value: Value, when: string | null) => {
    if (!when) return;
    // The report's readings, confirmed since while it still stands; the slow ones are asked for on their own.
    readings.push(when === at && confirmedAt ? { key, value, at: when, confirmedAt } : { key, value, at: when });
  };
  if (state) {
    add('soc', state.soc, at);
    add('charging', state.charging, at);
    add('online', state.online, at);
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
      'Everything NIU’s cloud says about the scooter, exactly as it says it: its state, its battery and its totals — never where it is. For working out what a value means: change one thing on the scooter, read again, and compare.',
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
  /** When the scooter made its last report; and when NIU last gave it to us. */
  let stateAt: string | null = null;
  let answeredAt: string | null = null;
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
  };

  const read = async () => {
    const next = await client.state(serial);
    const event = chargingEventOf(state, next);
    state = next;
    answeredAt = new Date().toISOString();
    // When the scooter reported it; NIU not saying, when we were told.
    stateAt = next.at ?? answeredAt;
    if (event) ctx.event(event.id, { soc: event.soc });
  };

  const tick = async () => {
    const busy = state?.charging === true || state?.poweredOn === true;
    const due = Date.now() - lastAsked >= (busy ? CHARGING_EVERY_MS : IDLE_EVERY_MS);
    const slowDue = Date.now() - lastSlow >= SLOW_EVERY_MS;
    if (!due && !slowDue) return;
    try {
      if (due) {
        lastAsked = Date.now();
        await read();
      }
      // Asked, answered or not: one that failed waits its turn as one that answered does.
      if (slowDue) {
        lastSlow = Date.now();
        await readSlow();
      }
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
      // No clock time here: the server's time zone need not be its owner's. When it reported is `lastReadingAt`, for the app to say.
      return { status: 'connected', detail: `${stateWord(state)} · through NIU’s cloud`, lastReadingAt: stateAt };
    },
    readings: () => (state && stateAt && answeredAt ? readingsOf(state, batteries, totals, stateAt, slowAt, confirmedSince(state, stateAt, answeredAt)) : []),
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
    online: true,
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
    // As NIU names a model: its name, then its finish.
    info: () => ({ manufacturer: 'NIU', model: 'UQi-GT Citi Black (Matte)', serial: 'SIMULATED' }),
    command: async () => ({ accepted: false, error: 'It takes no commands here yet' }),
    tools: {
      raw: async () => ({ from: 'simulated', state: json(state()), batteries: json(batteries), totals: json({ totalMileage: odometer }) }),
    },
    close: async () => undefined,
  };
}

/**
 * A model of NIU scooter: what it is called, the names NIU gives it, how well
 * it is known. Everything else — how it is reached, what it reports — is the
 * common NIU scooter's, until the model shows it differs.
 */
export type NiuScooterModel = {
  /** Stable forever: `niu.uqi-gt`. */
  id: string;
  meta: Omit<DeviceTypeMeta, 'brand' | 'category' | 'icon'> & { icon?: string };
};

/**
 * A NIU scooter type: the common one, or a model's own (a package per model,
 * with its pictures and, in time, what only that model does). Each model
 * starts as this and keeps what it has in common.
 */
export function defineNiuScooter(model: NiuScooterModel): DeviceType<Config> {
  return defineDeviceType<Config>({
    id: model.id,
    kind: 'hardware',
    meta: { icon: 'navigation', ...model.meta, brand: 'NIU', category: 'vehicle' },
    config: { fields: {} },
    ...COMMON,
  });
}

/** What every NIU scooter has in common: how it is reached and read, and what it reports. */
const COMMON = {
  describe: (): DeviceDescription => DESCRIPTION,
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
      needs: { trusted: 'your NIU password stays at home, and NIU’s cloud does not answer a web page' },
    },
  ],

  async identify(connection: OpenConnection) {
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
      state.at ? `last reported ${ago(state.at)}` : 'NIU gives no report time',
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
  createSimulator: async (ctx: DeviceContext<Config>) => simulatedSession(ctx),
} satisfies Omit<DeviceType<Config>, 'id' | 'kind' | 'meta' | 'config'>;

/**
 * Any NIU scooter NIU's cloud speaks for, whatever the model: the common
 * one. A model with a package of its own is offered as that model instead
 * when the check step reads its name.
 */
export default defineNiuScooter({
  id: 'niu.scooter',
  meta: {
    name: 'NIU scooter',
    description: 'A NIU electric scooter, read from NIU’s cloud with your NIU account: its charge, whether it is charging, its range and its odometer. With a smart plug in front of its charger, charge it to a limit.',
    support: 'experimental',
    supportNote: 'Read from NIU’s cloud the way others found it. A model of its own, where there is one, knows more.',
  },
});

export type { NiuClient };
