import {
  identityOf,
  validateConfig,
  type ConfigSchema,
  type OpenConnection,
  type Protocol,
  type SetupAction,
  type SetupChoice,
  type Sighting,
} from '@kraftverk/device-sdk';

import { fromHex } from './bytes.ts';
import { isRegion, REGIONS, TuyaCloud, TuyaCloudError } from './cloud.ts';
import { decodeBroadcast, DISCOVERY_PORTS } from './discovery.ts';
import type { ProtocolVersion } from './frame.ts';
import { TUYA_PORT, TuyaLink } from './session.ts';

/**
 * The Tuya LAN protocol, 3.1 to 3.5: how most Wi-Fi smart plugs are spoken to
 * without their vendor's cloud (docs/ATORCH-S1W.md).
 *
 * Pure code: framing, the crypto, the session handshake, what a discovery
 * broadcast says, and the local-key credential. It rides the `lan` transport:
 * TCP 6668 to the device, and UDP broadcasts to find it.
 */

export * from './cloud.ts';
export * from './discovery.ts';
export * from './frame.ts';
export * from './session.ts';
export * from './socket.ts';
export { aesEcbDecrypt, aesEcbEncrypt, aesGcmDecrypt, aesGcmEncrypt } from './crypto/aes.ts';
export { crc32, hmacSha256, md5, sha256 } from './crypto/hash.ts';

const VERSIONS = ['3.3', '3.4', '3.5'] as const;

/** A Tuya device's identity: its device id, the Smart Life app's "Virtual ID". */
export const tuyaIdentity = (deviceId: string): string => identityOf('tuya-local', deviceId);

const isIpv4 = (input: string): string | null => {
  const trimmed = input.trim();
  const parts = trimmed.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? trimmed : null;
};

/** What setup asks for, stored with the connection; the key encrypted. */
export const CREDENTIALS: ConfigSchema = {
  help:
    'The local key is the one thing a plug will not tell you itself. It comes from the Tuya cloud account the ' +
    'plug is paired with, once — use “Fetch it with my Tuya account”, or see docs/TUYA-LOCAL-KEY.md.',
  fields: {
    deviceId: {
      type: 'string',
      title: 'Device id',
      description: 'Filled in when the plug is found on the network; the Smart Life app calls it "Virtual ID".',
      required: true,
    },
    localKey: { type: 'secret', title: 'Local key', description: '16 characters. It never leaves the server.', required: true },
    protocolVersion: {
      type: 'enum',
      title: 'Protocol',
      description: 'Leave on Detect unless you have a reason not to: a wrong choice looks exactly like a wrong key.',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Detect' },
        { value: '3.3', label: '3.3' },
        { value: '3.4', label: '3.4' },
        { value: '3.5', label: '3.5' },
      ],
    },
  },
};

const keySchema: ConfigSchema = {
  help: 'From a Tuya IoT Platform cloud project — free, and needed once. docs/TUYA-LOCAL-KEY.md walks through it.',
  fields: {
    region: {
      type: 'enum',
      title: 'Data centre',
      description: 'The one you picked when creating the cloud project.',
      default: 'eu',
      required: true,
      options: Object.entries(REGIONS).map(([value, region]) => ({ value, label: region.label })),
    },
    clientId: { type: 'string', title: 'Access ID', required: true },
    clientSecret: { type: 'secret', title: 'Access Secret', required: true },
  },
};

/**
 * Fetches the plug's local key from the Tuya cloud account it is paired with.
 * The account details are used for this one request and never kept; the key
 * becomes the connection's secret, and the app sees only a placeholder for it.
 */
const fetchKey: SetupAction = {
  id: 'fetchKey',
  label: 'Fetch it with my Tuya account',
  description: 'A plug will not reveal its own local key; it comes from the cloud account the plug is paired with. This is the only step that touches Tuya, and it happens once.',
  input: keySchema,
  async run(ctx, input) {
    const parsed = validateConfig(keySchema, input);
    if (!parsed.ok) return { ok: false, detail: parsed.issues.map((issue) => issue.message).join('; ') };
    const region = String(parsed.value.region);
    if (!isRegion(region)) return { ok: false, detail: `Unknown data centre "${region}"` };
    const seed = typeof ctx.connection.deviceId === 'string' ? ctx.connection.deviceId : '';
    if (!seed) return { ok: false, detail: 'Choose the plug first: its device id is how the cloud finds your account.' };

    const cloud = new TuyaCloud(region, String(parsed.value.clientId), String(parsed.value.clientSecret), ctx.http);
    try {
      await cloud.authenticate();
      const devices = await cloud.allDevices(seed);
      const mine = devices.find((device) => device.id === seed);
      if (mine) {
        return {
          ok: true,
          detail: `Got the key for “${mine.name || mine.id}”. It is kept on the server, and never sent to this screen.`,
          suggestedConfig: { localKey: mine.localKey },
        };
      }
      const choices: SetupChoice[] = devices.map((device) => ({
        id: device.id,
        label: device.name || device.id,
        detail: [device.productName, device.category, device.online === false ? 'offline' : null].filter(Boolean).join(' · '),
        config: { deviceId: device.id, localKey: device.localKey },
        recommended: device.category === 'cz' || device.category === 'pc',
      }));
      return { ok: true, detail: `Got keys for ${devices.length} device(s). Pick the plug.`, choices };
    } catch (error) {
      return { ok: false, detail: error instanceof TuyaCloudError ? error.message : (error as Error).message };
    }
  },
};

const protocol: Protocol = {
  id: 'tuya-local',
  label: 'Tuya local',
  bindings: {
    lan: {
      open: () => ({ port: TUYA_PORT }),
      filter: { udpPorts: DISCOVERY_PORTS },
      recognise(sighting: Sighting) {
        const hex = sighting.facts.payload;
        if (typeof hex !== 'string') return null;
        const device = decodeBroadcast(fromHex(hex));
        if (!device) return null;
        return {
          name: device.productKey ? `Tuya device (${device.productKey})` : 'Tuya device',
          identity: tuyaIdentity(device.gwId),
          ...(device.productKey ? { model: device.productKey } : {}),
          detail: `${sighting.address} · protocol ${device.version}${device.active === false ? ' · not paired yet' : ''}`,
          // The broadcast is authoritative about the version, so it is taken
          // rather than rediscovered on every connect.
          config: {
            deviceId: device.gwId,
            protocolVersion: (VERSIONS as readonly string[]).includes(device.version) ? device.version : 'auto',
          },
        };
      },
      instructions: {
        title: 'Get the plug ready',
        body:
          'Pair the plug in the Smart Life or Tuya Smart app first, on a 2.4 GHz Wi-Fi network — the same home ' +
          'network as {host}. Paired plugs announce themselves every few seconds, and appear in the next step. ' +
          'Giving the plug a fixed address in your router keeps it from moving.',
      },
      parseAddress: isIpv4,
      addressLabel: 'IP address',
    },
  },
  credentials: { schema: CREDENTIALS, actions: [fetchKey] },
};

export default protocol;

/**
 * A Tuya conversation over an open connection: its channel, and the device id,
 * version and local key setup stored with it.
 */
export function linkOver(connection: OpenConnection, log?: (message: string) => void): TuyaLink {
  if (connection.channel.kind !== 'bytes') throw new Error('The Tuya local protocol speaks over a byte stream');
  const localKey = connection.secrets.get('localKey');
  if (!localKey) throw new Error('No local key: add it in the plug’s connection settings');
  const deviceId = String(connection.config.deviceId ?? '');
  if (!deviceId) throw new Error('No device id: set the plug up again from the network');
  const version = String(connection.config.protocolVersion ?? 'auto');
  return new TuyaLink(connection.channel, {
    deviceId,
    localKey,
    version: (VERSIONS as readonly string[]).includes(version) ? (version as ProtocolVersion) : 'auto',
    log,
  });
}
