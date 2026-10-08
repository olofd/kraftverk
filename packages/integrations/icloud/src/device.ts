import {
  defineDeviceType,
  identityOf,
  linkOf,
  MAIN_PART,
  POSITION_SHAPE,
  type DeviceContext,
  type DeviceDescription,
  type DeviceInfo,
  type DeviceSession,
  type OpenConnection,
  type Reading,
  type SessionHealth,
  type ToolSpec,
} from '@kraftverk/device-sdk';

import { Family } from './account.ts';
import type { FindMyLink } from './link.ts';
import { simulatedFamily } from './simulation.ts';
import type { FoundDevice } from './protocol/index.ts';

/*
  A device in Find My — a phone, a tablet, a Mac, AirPods, a family
  member's — reached through the iCloud account it is in (./account.ts):
  where it is and how sure, its charge and whether it is charging, a sound
  played on it, and lost mode, which a person asks for and confirms. Its
  position is what `distance` in an automation measures: "when Sam's phone
  gets home". Where someone is, is not kept in history.
*/

type Config = Record<string, never>;

const THROUGH_ITS_ACCOUNT = 'A device in Find My is reached through its iCloud account';

/** How long a position stays current: Find My is asked every few minutes while someone moves, rarely while they do not. */
const POSITION_CURRENT_MS = 60 * 60_000;

/** What a Find My device is, as a person names it: what its picture is drawn as. */
const KINDS = ['phone', 'tablet', 'computer', 'watch', 'earbuds', 'other'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { phone: 'Phone', tablet: 'Tablet', computer: 'Computer', watch: 'Watch', earbuds: 'Earbuds', other: 'Other' };

/** Its kind, from how Apple classes it — and, for an accessory, its name. */
export function kindOf(device: Pick<FoundDevice, 'deviceClass' | 'model'>): Kind {
  const of = `${device.deviceClass ?? ''} ${device.model}`.toLowerCase();
  if (of.includes('iphone')) return 'phone';
  if (of.includes('ipad')) return 'tablet';
  if (of.includes('watch')) return 'watch';
  if (of.includes('airpods') || of.includes('beats')) return 'earbuds';
  if (of.includes('mac')) return 'computer';
  return 'other';
}

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Device', kind: 'device', offers: ['identify'] }],
  attributes: [
    { key: 'position', label: 'Where it is', value: POSITION_SHAPE, means: 'position', category: 'primary', currentFor: POSITION_CURRENT_MS },
    { key: 'charge', label: 'Charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'charge', currentFor: POSITION_CURRENT_MS },
    { key: 'charging', label: 'Charging', value: { type: 'boolean', words: { true: 'Charging', false: 'Not charging' } }, currentFor: POSITION_CURRENT_MS },
    { key: 'owner', label: 'Whose it is', description: 'The family member it belongs to, when it is not the account’s own.', value: { type: 'string' }, category: 'diagnostic' },
    {
      key: 'kind',
      label: 'What it is',
      value: { type: 'enum', options: KINDS.map((value) => ({ value, label: KIND_LABEL[value] })) },
      category: 'diagnostic',
    },
    { key: 'nextLook', label: 'Looked for next', description: 'When its account next asks Find My where it is.', value: { type: 'timestamp' }, category: 'diagnostic' },
    { key: 'lookEvery', label: 'Looked for every', description: 'How often its account asks Find My now: every minute while its page is open, every 2 minutes while it moves, every 15 while it is still.', value: { type: 'number', unit: 's', integer: true }, category: 'diagnostic', history: false },
  ],
};

const TOOLS: Readonly<Record<string, ToolSpec>> = {
  lostMode: {
    label: 'Lost mode',
    description: 'Locks it, and shows a message and a number to call on its screen. It stays locked until it is found and unlocked with its passcode.',
    input: {
      fields: {
        phone: { type: 'string', title: 'A number to call', required: true },
        text: { type: 'string', title: 'Message', default: 'This device is lost. Please call the number below.' },
      },
    },
    answer: { type: 'boolean' },
    writes: true,
    confirm: 'Its owner cannot use it until it is unlocked with its passcode.',
  },
  locate: {
    label: 'Locate now',
    description: 'Asks Find My where it is now, not at its account’s next turn. Every ask locates every device on the account, so it asks at most once a minute.',
    answer: { type: 'timestamp' },
    writes: false,
  },
};

/** What Find My said of it, as readings: each as of when Find My located it. */
function readingsOf(device: FoundDevice, answeredAt: string, schedule: ReturnType<FindMyLink['schedule']>): Reading[] {
  const location = device.location;
  return [
    // Where it is — and when Find My knows nowhere (off, no signal), nothing said: where it last was stands, as of when.
    ...(location ? [{ key: 'position', value: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy ?? null }, at: location.at }] : []),
    { key: 'charge', value: device.battery, at: answeredAt },
    // On the charger: charging, or full on it ("Charged").
    { key: 'charging', value: device.batteryStatus === null || device.batteryStatus === 'Unknown' ? null : device.batteryStatus === 'Charging' || device.batteryStatus === 'Charged', at: answeredAt },
    { key: 'owner', value: device.owner, at: answeredAt },
    { key: 'kind', value: kindOf(device), at: answeredAt },
    // When it is looked for next, and how often: what its page says, so nobody wonders when it updates.
    { key: 'nextLook', value: schedule.nextAt, at: answeredAt },
    { key: 'lookEvery', value: Math.round(schedule.everyMs / 1000), at: answeredAt },
  ];
}

/** What it is, as people say and Apple codes it. */
const infoOf = (device: FoundDevice | null): DeviceInfo => ({ manufacturer: 'Apple', ...(device ? { model: device.rawModel ? `${device.model} (${device.rawModel})` : device.model } : {}) });

/** A session over what Find My says of it, wherever that comes from. */
function sessionOver(link: Pick<FindMyLink, 'device' | 'answeredAt' | 'error' | 'playSound' | 'lostMode' | 'locate' | 'watch' | 'schedule'>, id: string, via: string, close: () => Promise<void>): DeviceSession {
  return {
    health(): SessionHealth {
      const device = link.device();
      const error = link.error();
      const at = device?.location?.at ?? link.answeredAt();
      if (error) return { status: 'error', detail: error, lastReadingAt: at };
      if (!device) return { status: 'connecting', detail: `Asking Find My ${via}`, lastReadingAt: null };
      const where = device.location ? (device.location.old ? 'where it last was' : 'located') : 'Find My does not know where it is';
      return { status: 'connected', detail: `${where} · ${via}`, lastReadingAt: at };
    },
    readings: () => {
      const device = link.device();
      const answeredAt = link.answeredAt();
      return device && answeredAt ? readingsOf(device, answeredAt, link.schedule()) : [];
    },
    // Its own page open: its account asks every minute until then. Shown in a list, or waited on by an automation, it is asked as ever: every ask locates every device on the account.
    wantFresh: (until, close) => {
      if (close) link.watch(until);
    },
    info: () => infoOf(link.device()),
    identity: () => ({ id: identityOf('icloud-web', id), name: link.device()?.name ?? null }),
    async command(request) {
      if (request.capability !== 'identify' || request.command !== 'identify') return { accepted: false, error: `It takes no ${request.capability}.${request.command}` };
      try {
        await link.playSound();
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as Error).message };
      }
    },
    tools: {
      lostMode: async (input) => {
        await link.lostMode({ phone: String(input.phone ?? ''), text: String(input.text ?? '') });
        return true;
      },
      locate: async () => {
        const device = await link.locate();
        return device.location?.at ?? link.answeredAt();
      },
    },
    close,
  };
}

/** A device through its account: what Find My tells the account of it, read through its link. */
async function memberSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  const id = ctx.connection!.address;
  let linked: FindMyLink | null = null;
  const link = await linkOf<FindMyLink>(ctx.connection, () => linked && ctx.changed(), THROUGH_ITS_ACCOUNT);
  linked = link;
  if (link.device()) ctx.changed();
  return sessionOver(link, id, 'through its iCloud account', async () => link.close());
}

/** A phone that is not there, going out and back from where the simulation says home is. */
async function simulatedSession(ctx: DeviceContext<Config>): Promise<DeviceSession> {
  // The same account's schedule as a real one: every minute while its page is open, rarely otherwise.
  const family = new Family(simulatedFamily(ctx));
  const link = await family.link('simulated-phone-1', () => ctx.changed());
  ctx.schedule(15_000, () => family.poll());
  ctx.changed();
  return sessionOver(
    link,
    'simulated-phone-1',
    'simulated: out and back',
    async () => undefined
  );
}

export default defineDeviceType<Config>({
  id: 'icloud.device',
  kind: 'hardware',
  meta: {
    name: 'Device in Find My',
    brand: 'Apple',
    category: 'phone',
    icon: 'smartphone',
    description: 'A phone, tablet, Mac or AirPods in Find My — yours or your family’s — through your iCloud account: where it is, how charged, and a sound played on it.',
    support: 'experimental',
    supportNote: 'Ported from Home Assistant’s iCloud integration: read from Find My on iCloud.',
  },
  config: { fields: {} },
  describe: () => DESCRIPTION,
  tools: TOOLS,
  connections: [
    {
      id: 'account',
      label: 'Through your iCloud account',
      description: 'Through the iCloud account its Find My is on, which asks Apple for every device at once. Needs the internet.',
      through: ['icloud.account'],
      reach: 'cloud',
      updates: 'poll',
    },
  ],

  /** Read once through its account: which device, and how it is — never where, in words. */
  async identify(connection: OpenConnection) {
    const link = await linkOf<FindMyLink>(connection, () => {}, THROUGH_ITS_ACCOUNT);
    try {
      const device = await link.ask();
      const said = [device.battery === null ? null : `${device.battery} % charged`, device.batteryStatus === 'Charging' ? 'charging' : null, device.location ? 'located' : 'not located by Find My', device.owner ? `${device.owner}’s` : null].filter(Boolean);
      return {
        identity: identityOf('icloud-web', connection.address),
        model: device.model,
        name: device.name,
        summary: `${device.model}: ${said.join(', ')}.`,
        info: infoOf(device),
      };
    } finally {
      link.close();
    }
  },

  createSession: memberSession,
  createSimulator: simulatedSession,
});
