import {
  validateConfig,
  type ConfigValues,
  type SetupAction,
  type SetupActionResult,
  type SetupChoice,
} from '@kraftverk/plugin-sdk';

import { isRegion, REGIONS, TuyaCloud, TuyaCloudError } from './cloud.ts';
import { scan } from './discovery.ts';
import { PROFILES } from './profiles.ts';

/**
 * Getting from "I own a plug" to "the server can talk to it".
 *
 * Two things stand in the way, and neither can be typed from memory: the plug's
 * address and device id, and its local key. The first is on the network and
 * free to read; the second exists only in Tuya's cloud. One helper each, both
 * declared as `SetupAction`s so the app renders them without knowing anything
 * about Tuya.
 */

const findSchema = {
  fields: {
    seconds: {
      type: 'number' as const,
      title: 'Listen for',
      description: 'Devices announce themselves every few seconds.',
      default: 12,
      min: 3,
      max: 60,
      unit: 's',
      integer: true,
    },
  },
};

const keySchema = {
  help:
    'These come from a Tuya IoT Platform cloud project — free, and needed once. ' +
    'See docs/TUYA-LOCAL-KEY.md for the five-minute walkthrough.',
  fields: {
    region: {
      type: 'enum' as const,
      title: 'Data centre',
      description: 'The one you picked when creating the cloud project.',
      default: 'eu',
      required: true,
      options: Object.entries(REGIONS).map(([value, region]) => ({ value, label: region.label })),
    },
    clientId: { type: 'string' as const, title: 'Access ID', required: true },
    clientSecret: { type: 'secret' as const, title: 'Access Secret', required: true },
    deviceId: {
      type: 'string' as const,
      title: 'Any device id from the account',
      description:
        'Tuya has no "list my devices" call — naming one device is how the project finds your ' +
        'account. Use one from Find plugs above.',
      required: true,
    },
  },
};

export const SETUP_ACTIONS: readonly SetupAction[] = [
  {
    id: 'discover',
    title: 'Find plugs on this network',
    description:
      'Listens for Tuya announcements. Needs no credentials, and reports each plug’s address and protocol version.',
    actionLabel: 'Scan',
    input: findSchema,
  },
  {
    id: 'fetchKeys',
    title: 'Fetch local keys from Tuya',
    description:
      'A plug will not reveal its own local key; it comes from the cloud account the plug is paired with. This is the only step that touches Tuya, and it happens once.',
    actionLabel: 'Fetch keys',
    input: keySchema,
  },
];

export async function runSetupAction(id: string, input: ConfigValues): Promise<SetupActionResult> {
  if (id === 'discover') return discover(input);
  if (id === 'fetchKeys') return fetchKeys(input);
  return { ok: false, detail: `Unknown setup action "${id}"` };
}

async function discover(input: ConfigValues): Promise<SetupActionResult> {
  const parsed = validateConfig(findSchema, input);
  if (!parsed.ok) return { ok: false, detail: parsed.issues[0]?.message ?? 'Invalid input' };

  const found = await scan(Number(parsed.value.seconds ?? 12) * 1000);

  if (found.length === 0) {
    return {
      ok: false,
      detail:
        'No Tuya devices announced themselves. They must be on this LAN segment and already ' +
        'paired in Smart Life; some Wi-Fi networks block client-to-client broadcasts.',
    };
  }

  const choices: SetupChoice[] = found.map((device) => ({
    id: device.gwId,
    label: device.ip,
    detail: `protocol ${device.version}${device.productKey ? ` · ${device.productKey}` : ''}${
      device.active === false ? ' · not paired' : ''
    }`,
    config: {
      host: device.ip,
      deviceId: device.gwId,
      // The broadcast is authoritative about the version, so take it rather
      // than making the link rediscover it on every connect.
      protocolVersion: device.version.startsWith('3.') ? device.version : 'auto',
    },
  }));

  return {
    ok: true,
    detail: `Found ${found.length} device${found.length === 1 ? '' : 's'}. Pick the plug feeding your station.`,
    choices,
    data: { devices: found },
  };
}

async function fetchKeys(input: ConfigValues): Promise<SetupActionResult> {
  const parsed = validateConfig(keySchema, input);
  if (!parsed.ok) {
    return { ok: false, detail: parsed.issues.map((issue) => issue.message).join('; ') };
  }

  const region = String(parsed.value.region);
  if (!isRegion(region)) return { ok: false, detail: `Unknown data centre "${region}"` };

  const cloud = new TuyaCloud(region, String(parsed.value.clientId), String(parsed.value.clientSecret));

  try {
    await cloud.authenticate();
    const devices = await cloud.allDevices(String(parsed.value.deviceId));

    const choices: SetupChoice[] = devices.map((device) => ({
      id: device.id,
      label: device.name || device.id,
      detail: [device.productName, device.category, device.online === false ? 'offline' : null]
        .filter(Boolean)
        .join(' · '),
      config: { deviceId: device.id, localKey: device.localKey },
      // The plug we are configuring is a socket with a meter; nudge toward it.
      recommended: device.category === 'cz' || device.category === 'pc',
    }));

    return {
      ok: true,
      detail:
        `Got keys for ${devices.length} device${devices.length === 1 ? '' : 's'}. ` +
        `Pick the plug — its key is applied to the form, and never leaves this server.`,
      choices,
      // Deliberately no `data`: the raw response contains every key on the
      // account, and it has no business in a log or a debug panel.
    };
  } catch (error) {
    if (error instanceof TuyaCloudError) return { ok: false, detail: error.message };
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Profiles offered in the config form, for the app to render. */
export const PROFILE_OPTIONS = PROFILES.map((profile) => ({
  value: profile.id,
  label: profile.label,
}));
