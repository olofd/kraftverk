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

const DESCRIPTION: DeviceDescription = {
  parts: [{ id: MAIN_PART, label: 'Device', kind: 'device', offers: ['identify'] }],
  attributes: [
    { key: 'position', label: 'Where it is', value: POSITION_SHAPE, means: 'position', category: 'primary', currentFor: POSITION_CURRENT_MS },
    { key: 'charge', label: 'Charge', value: { type: 'number', unit: '%', min: 0, max: 100 }, means: 'charge', currentFor: POSITION_CURRENT_MS },
    { key: 'charging', label: 'Charging', value: { type: 'boolean', words: { true: 'Charging', false: 'Not charging' } }, currentFor: POSITION_CURRENT_MS },
    { key: 'owner', label: 'Whose it is', description: 'The family member it belongs to, when it is not the account’s own.', value: { type: 'string' }, category: 'diagnostic' },
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
};

/** What Find My said of it, as readings: each as of when Find My located it. */
function readingsOf(device: FoundDevice, answeredAt: string): Reading[] {
  const at = device.location?.at ?? answeredAt;
  const position = device.location ? { latitude: device.location.latitude, longitude: device.location.longitude, accuracy: device.location.accuracy ?? null } : null;
  return [
    { key: 'position', value: position, at },
    { key: 'charge', value: device.battery, at: answeredAt },
    { key: 'charging', value: device.batteryStatus === null || device.batteryStatus === 'Unknown' ? null : device.batteryStatus === 'Charging', at: answeredAt },
    { key: 'owner', value: device.owner, at: answeredAt },
  ];
}

/** What it is, as people say and Apple codes it. */
const infoOf = (device: FoundDevice | null): DeviceInfo => ({ manufacturer: 'Apple', ...(device ? { model: device.rawModel ? `${device.model} (${device.rawModel})` : device.model } : {}) });

/** A session over what Find My says of it, wherever that comes from. */
function sessionOver(link: Pick<FindMyLink, 'device' | 'answeredAt' | 'error' | 'playSound' | 'lostMode'>, id: string, via: string, close: () => Promise<void>): DeviceSession {
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
      return device && answeredAt ? readingsOf(device, answeredAt) : [];
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
function simulatedSession(ctx: DeviceContext<Config>): DeviceSession {
  const family = simulatedFamily(ctx);
  let device: FoundDevice | null = null;
  let answeredAt: string | null = null;
  const ask = async () => {
    device = (await family.devices())[0] ?? null;
    answeredAt = new Date(ctx.clock.now()).toISOString();
    ctx.changed();
  };
  ctx.schedule(60_000, ask);
  void ask();
  return sessionOver(
    { device: () => device, answeredAt: () => answeredAt, error: () => null, playSound: () => family.playSound('simulated-phone-1'), lostMode: (options) => family.lostMode('simulated-phone-1', options) },
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
  createSimulator: async (ctx) => simulatedSession(ctx),
});
