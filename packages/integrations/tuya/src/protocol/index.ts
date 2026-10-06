import {
  identityOf,
  validateConfig,
  type ConfigSchema,
  type OpenConnection,
  type Protocol,
  type SetupAction,
  type SetupChoice,
  type Sighting,
  channelOf,
  directOf,
} from '@kraftverk/device-sdk';

import { fromHex } from './bytes.ts';
import { isRegion, REGIONS, TuyaCloud, TuyaCloudError } from './cloud.ts';
import { decodeBroadcast, DISCOVERY_PORTS } from './discovery.ts';
import type { ProtocolVersion } from './frame.ts';
import { TUYA_PORT, TuyaLink, type TuyaLinkOptions } from './session.ts';
import { pollLogin, qrLoginContent, requestQrToken, smartLifeDevices, SmartLifeError } from './smartlife.ts';

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
export * from './smartlife.ts';
export * from './socket.ts';
export { aesEcbDecrypt, aesEcbEncrypt, aesGcmDecrypt, aesGcmEncrypt } from './crypto/aes.ts';
export { crc32, hmacSha256, md5, sha256 } from './crypto/hash.ts';

const VERSIONS = ['3.3', '3.4', '3.5'] as const;

/** A Tuya device's identity: its device id, the Smart Life app's "Virtual ID". */
export const tuyaIdentity = (deviceId: string): string => identityOf('tuya-local', deviceId);

const isIpv4 = (input: string): boolean => {
  const parts = input.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

/** A Zigbee address, as a Tuya gateway names the device: 16 hex digits. */
const CID = /^[0-9a-f]{16}$/i;

/**
 * An address as typed: a device's IP address — or, for a device behind a Tuya
 * gateway, the gateway's IP address, `#`, and the device's Zigbee address.
 */
export function parseTuyaAddress(input: string): string | null {
  const [host = '', cid, ...rest] = input.trim().split('#');
  if (rest.length || !isIpv4(host.trim())) return null;
  if (cid === undefined) return host.trim();
  return CID.test(cid.trim()) ? `${host.trim()}#${cid.trim().toLowerCase()}` : null;
}

/** The device behind a gateway an address names, or null for a device reached directly. */
export const cidOfAddress = (address: string): string | null => address.split('#')[1] ?? null;

/** Categories Tuya gives its gateways: Zigbee, Zigbee with Wi-Fi, and the multi-mode ones. */
const GATEWAY_CATEGORIES = new Set(['wg2', 'wfcon', 'wg', 'dgnzk', 'wgsxj']);

/** What setup asks for, stored with the connection; the key encrypted. */
export const CREDENTIALS: ConfigSchema = {
  help:
    'A plug talks on your network only to someone who knows its local key, and the key comes from the Smart Life ' +
    'account it is paired with — once. Signing in fetches it; if you already have it, type it here.',
  fields: {
    deviceId: {
      type: 'string',
      title: 'Device id',
      description: 'Filled in when the plug is found on the network; the Smart Life app calls it "Virtual ID".',
      required: true,
    },
    localKey: { type: 'string', presentation: 'secret', title: 'Local key', description: '16 characters. It never leaves the server.', required: true },
    protocolVersion: {
      type: 'enum',
      title: 'Version',
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
    clientSecret: { type: 'string', presentation: 'secret', title: 'Access Secret', required: true },
  },
};

/**
 * Fetches the plug's local key from the Tuya cloud account it is paired with.
 * The account details are used for this one request and never kept; the key
 * becomes the connection's secret, and the app sees only a placeholder for it.
 */
const fetchKey: SetupAction = {
  id: 'fetchKey',
  label: 'Use a Tuya developer project',
  description: 'If you already have a Tuya IoT Platform cloud project: its Access ID and Secret fetch the keys instead.',
  input: keySchema,
  async run(ctx, input) {
    const parsed = validateConfig(keySchema, input);
    if (!parsed.ok) return { ok: false, detail: parsed.issues.map((issue) => issue.message).join('; ') };
    const region = String(parsed.value.region);
    if (!isRegion(region)) return { ok: false, detail: `Unknown data centre "${region}"` };
    // Any one device on the account finds the rest: the one chosen, or one heard on this network.
    const seed = (typeof ctx.connection.deviceId === 'string' && ctx.connection.deviceId) || ([...heard(ctx.sightings).keys()][0] ?? '');
    if (!seed) return { ok: false, detail: 'No Tuya device has been heard on this network yet, and a project finds your account through one. Type the plug’s device id, or sign in with Smart Life instead.' };

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

/** How long a sign-in QR code is waited for: Tuya's token lapses about then. */
const SIGN_IN_WAIT_MS = 3 * 60_000;

const signInSchema: ConfigSchema = {
  fields: {
    userCode: {
      type: 'string',
      title: 'User Code',
      description: 'In the Smart Life (or Tuya Smart) app: Me → the gear, top right → Account and Security → User Code.',
      required: true,
    },
  },
};

/** Where a device is on this network, from what the transport has heard it announce. */
function heard(sightings: readonly Sighting[]): Map<string, { address: string; version: string }> {
  const found = new Map<string, { address: string; version: string }>();
  for (const sighting of sightings) {
    const hex = sighting.facts.payload;
    const device = typeof hex === 'string' ? decodeBroadcast(fromHex(hex)) : null;
    if (device) found.set(device.gwId, { address: sighting.address, version: device.version });
  }
  return found;
}

/**
 * Signs in with the Smart Life app: a User Code, a QR code the same app scans,
 * and every device on the account comes back with its name and local key —
 * no developer project. Matched against what the network announces, the plug
 * that is here is found as well: the key, the address and the protocol version
 * in one pick.
 *
 * Runs in turns. The first makes the QR code; each after it asks whether it
 * has been scanned, until it has — the app asks again with what `waiting.next`
 * says. The sign-in token is used for the one listing and never kept.
 */
const signIn: SetupAction = {
  id: 'signIn',
  label: 'Sign in with Smart Life',
  description: 'Scan a code with the Smart Life app, and your plugs come back with their names and keys. Nothing else is read, and nothing is kept.',
  input: signInSchema,
  async run(ctx, input) {
    const userCode = String(input.userCode ?? '').trim();
    if (!userCode) return { ok: false, detail: 'The User Code is needed: the app shows it under Me → Settings → Account and Security.' };
    try {
      const token = typeof input.token === 'string' && input.token ? input.token : null;
      const until = typeof input.until === 'string' ? input.until : new Date(Date.now() + SIGN_IN_WAIT_MS).toISOString();
      if (!token) {
        const fresh = await requestQrToken(ctx.http, userCode);
        return {
          ok: true,
          detail: 'Open the Smart Life app, tap the scan icon (top right of Me), and scan this. It asks to authorise “Home Assistant” — the name Tuya gave this sign-in.',
          waiting: { qr: qrLoginContent(fresh), next: { userCode, token: fresh, until }, everyMs: 2_000, until },
        };
      }
      const session = await pollLogin(ctx.http, token, userCode);
      if (!session) {
        return {
          ok: true,
          detail: 'Waiting for the scan…',
          waiting: { qr: qrLoginContent(token), next: { userCode, token, until }, everyMs: 2_000, until },
        };
      }

      const account = await smartLifeDevices(ctx.http, session);
      const devices = account.filter((device) => device.localKey);
      if (!devices.length) return { ok: false, detail: 'Signed in, but the account has no devices that can be reached on a home network.' };
      const here = heard(ctx.sightings);
      /*
        A device behind a gateway — a Zigbee plug — has no address of its own,
        and carries its gateway's key. Its gateway is the account's gateway
        heard on this network; with one such, that is the one. Its Zigbee
        address — the `cid` the gateway knows it by — is Tuya's `uuid` for it.
      */
      const gateways = account.filter((device) => (!device.localKey || GATEWAY_CATEGORIES.has(device.category ?? '')) && here.has(device.id));
      const gateway = gateways.length === 1 ? here.get(gateways[0]!.id)! : null;
      const reach = (device: (typeof devices)[number]) => {
        if (!device.sub) return here.get(device.id) ?? null;
        const cid = device.uuid && CID.test(device.uuid) ? device.uuid.toLowerCase() : null;
        return gateway && cid ? { address: `${gateway.address}#${cid}`, version: gateway.version, through: gateway.address } : null;
      };
      const choices: SetupChoice[] = devices
        .map((device) => {
          const seen = reach(device);
          const plug = device.category === 'cz' || device.category === 'pc';
          return {
            id: device.id,
            label: device.name || device.productName || device.id,
            detail: [
              device.productName,
              seen && 'through' in seen ? `through its gateway at ${seen.through}` : seen ? `on your network at ${seen.address}` : device.sub ? 'behind a gateway not heard on this network' : 'not heard on this network yet',
              device.online === false ? 'offline' : null,
            ]
              .filter(Boolean)
              .join(' · '),
            config: {
              deviceId: device.id,
              localKey: device.localKey,
              ...(seen && (VERSIONS as readonly string[]).includes(seen.version) ? { protocolVersion: seen.version } : {}),
            },
            ...(seen ? { address: seen.address } : {}),
            ...(device.name ? { name: device.name } : {}),
            recommended: plug && Boolean(seen),
          };
        })
        // What is on this network first, then plugs, then the rest.
        .sort((a, b) => Number(Boolean(b.address)) - Number(Boolean(a.address)) || Number(b.recommended) - Number(a.recommended) || a.label.localeCompare(b.label));
      return { ok: true, detail: `Signed in: ${devices.length} device${devices.length === 1 ? '' : 's'} on the account. Which is it?`, choices };
    } catch (error) {
      return { ok: false, detail: error instanceof SmartLifeError ? error.message : (error as Error).message };
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
          detail: `${sighting.address} · Tuya ${device.version}${device.active === false ? ' · not paired yet' : ''}`,
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
          'Set the plug up in the Smart Life (or Tuya Smart) app first, as its maker intends, on your home Wi-Fi — ' +
          'most plugs only join 2.4 GHz. When it switches from the app, it is ready. Then close the app on your ' +
          'phone: while it is open it can keep the plug to itself. Giving the plug a fixed address in your router ' +
          'keeps it where kraftverk expects it.',
      },
      parseAddress: parseTuyaAddress,
      addressLabel: 'IP address (behind a gateway: its IP address#Zigbee address)',
    },
  },
  // Signing in lists the plugs by name, with their keys and — matched against the network — where they are: so it comes first.
  credentials: { schema: CREDENTIALS, actions: [signIn, fetchKey], first: true, title: 'Your Smart Life account' },
};

export default protocol;

/**
 * A Tuya conversation over an open connection: its channel, and the device id,
 * version and local key setup stored with it. `onPush` hears what the plug
 * sends unasked.
 */
export function linkOver(connection: OpenConnection, options: Pick<TuyaLinkOptions, 'log' | 'onPush' | 'onPresence'> = {}): TuyaLink {
  const channel = channelOf(connection, 'bytes', 'Tuya local needs a byte stream');
  const localKey = directOf(connection, 'Tuya local needs a byte stream').secrets.get('localKey');
  if (!localKey) throw new Error('No local key: add it in the plug’s connection settings');
  const deviceId = String(connection.config.deviceId ?? '');
  if (!deviceId) throw new Error('No device id: set the plug up again from the network');
  const version = String(connection.config.protocolVersion ?? 'auto');
  // Behind a gateway, the address names the device there: the link speaks to the gateway about it.
  const cid = cidOfAddress(connection.address);
  return new TuyaLink(channel, {
    deviceId,
    localKey,
    version: (VERSIONS as readonly string[]).includes(version) ? (version as ProtocolVersion) : 'auto',
    ...(cid ? { cid } : {}),
    ...options,
  });
}
