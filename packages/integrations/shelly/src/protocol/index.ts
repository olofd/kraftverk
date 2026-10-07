import { heardAs, identityOf, type ConfigSchema, type Protocol, type Sighting } from '@kraftverk/device-sdk';

/**
 * How a Shelly (Gen2 and later: Plus, Pro, Gen3, Gen4) is spoken to: JSON-RPC
 * over a WebSocket at /rpc on port 80 of the home network (rpc.ts,
 * websocket.ts), signed with a SHA-256 digest when it has a password. Pure:
 * bytes in, values out, over the channel the home network's transport
 * opened — it runs in the app as well as on a server.
 *
 * Ported from Home Assistant's `shelly` integration and the `aioshelly`
 * library it uses (both Apache-2.0; NOTICE).
 */

export * from './rpc.ts';
export * from './websocket.ts';

/** The port a Shelly answers its RPC on. */
export const SHELLY_PORT = 80;

/** A Shelly's permanent identity: its MAC, as it names itself. */
export const shellyIdentity = (mac: string): string => identityOf('shelly-rpc', mac.toLowerCase().replace(/[^0-9a-f]/g, ''));

/** What `Shelly.GetDeviceInfo` answers, as far as a session needs it. */
export type DeviceInfo = {
  /** Its own id: `shellyplusplugs-c4dee2a1b2c3`. */
  id: string;
  mac: string;
  /** The model code: `SNPL-00112EU`. */
  model: string;
  /** Which generation of the RPC it speaks: 2, 3, 4. */
  gen: number;
  /** The firmware's version: `1.4.4`. */
  ver: string;
  /** The application — what kind of device it is — `PlusPlugS`, `Plus1PM`. */
  app: string;
  /** What its owner named it, if anyone did. */
  name: string | null;
  /** Whether it asks for a password. */
  auth_en: boolean;
};

/** What a device of its kind's `switch:<n>` component says, as `Shelly.GetStatus` and its notifications carry it. */
export type SwitchStatus = {
  id: number;
  output?: boolean;
  /** Active power, in W, where it measures. */
  apower?: number;
  voltage?: number;
  current?: number;
  freq?: number;
  /** Its energy count: `total` in Wh. */
  aenergy?: { total?: number };
  temperature?: { tC?: number | null };
};

/** Everything it says of itself: components by key — `switch:0`, `wifi`, `sys` — merged as notifications come. */
export type DeviceStatus = Readonly<Record<string, unknown>>;

/** The switch components a status has, in order of their number. */
export function switchesOf(status: DeviceStatus): SwitchStatus[] {
  return Object.entries(status)
    .filter(([key, value]) => /^switch:\d+$/.test(key) && value && typeof value === 'object')
    .map(([key, value]) => ({ ...(value as SwitchStatus), id: Number(key.slice('switch:'.length)) }))
    .sort((a, b) => a.id - b.id);
}

/** A status with a change merged in: what NotifyStatus carries is only what moved, component by component. */
export function merged(status: DeviceStatus, change: Readonly<Record<string, unknown>>): DeviceStatus {
  const next: Record<string, unknown> = { ...status };
  for (const [key, value] of Object.entries(change)) {
    const before = next[key];
    next[key] = before && typeof before === 'object' && value && typeof value === 'object' && !Array.isArray(value) ? mergeObjects(before as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return next;
}

function mergeObjects(before: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(change)) {
    const was = next[key];
    next[key] = was && typeof was === 'object' && value && typeof value === 'object' && !Array.isArray(value) ? mergeObjects(was as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return next;
}

/** A device's id as mDNS names it — `shellyplusplugs-c4dee2a1b2c3` — and the MAC at its end. */
const DEVICE_ID = /^shelly[a-z0-9]*-([0-9a-f]{12})$/i;

/** What it asks for when it has a password: nothing more, as a Shelly signs in only as admin. */
export const CREDENTIALS: ConfigSchema = {
  fields: {
    password: {
      type: 'string',
      presentation: 'secret',
      title: 'Device password',
      description: 'Only if you set one for it, in the Shelly app or its own web page. Left empty, none is used.',
    },
  },
};

/** An address typed by hand: an IPv4 address, or a local name. */
const parseAddress = (input: string): string | null => {
  const text = input.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text) && text.split('.').every((part) => Number(part) <= 255)) return text;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(text) ? text : null;
};

const protocol: Protocol = {
  id: 'shelly-rpc',
  label: 'Shelly RPC',
  bindings: {
    lan: {
      open: () => ({ port: SHELLY_PORT }),
      // What a Shelly announces over mDNS: its id as the instance, and its generation and application in TXT.
      recognise(sighting: Sighting) {
        const service = heardAs(sighting, 'mdns').find((said) => said.service === '_shelly._tcp');
        if (!service) return null;
        const mac = DEVICE_ID.exec(service.instance)?.[1];
        const gen = Number(service.txt.gen);
        if (!mac || !(gen >= 2)) return null;
        const app = service.txt.app ?? null;
        return {
          name: app ? `Shelly ${app}` : 'Shelly',
          identity: shellyIdentity(mac),
          ...(app ? { model: app } : {}),
          detail: `${sighting.address} · Gen ${gen}${service.txt.ver ? ` · ${service.txt.ver}` : ''}`,
        };
      },
      instructions: {
        title: 'Get it on your network',
        body:
          'Set the Shelly up on your home Wi-Fi with the Shelly app, or with its own access point and web page, as its maker intends. ' +
          'Once it is on the network it is found here by itself. Keep its firmware current: Gen2 and later are reached this way.',
      },
      parseAddress,
      addressLabel: 'IP address',
    },
  },
  credentials: { schema: CREDENTIALS },
};

export default protocol;
