import type { FileMigration } from '@kraftverk/device-sdk';

import { zigbeeIdentity } from './protocol/index.ts';

/*
  How Tuya's entries in a configuration file changed (docs/CONFIG.md), so a
  home kept before comes back after. Each finds its entries by what is
  installed — the types reached through a Tuya gateway — never by a
  product's name: the platform names none.
*/

const GATEWAY = 'tuya.gateway';

type Way = { via?: unknown; through?: unknown; address?: unknown; settings?: Record<string, unknown>; secrets?: Record<string, unknown>; exportable?: unknown };
type Entry = { type?: unknown; name?: unknown; identity?: unknown; connect?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Version 7: a Zigbee socket is reached through its gateway, a device of its
 * own. Until then it was reached "lan" at its gateway's address, "#" its
 * Zigbee address, with the gateway's key; now the gateway is reached "lan"
 * at its own address with that key, and the socket "gateway" through it by
 * its Zigbee address. One gateway entry for each gateway address — two
 * sockets behind one gateway share it, and its key. The gateway's own device
 * id was never in the file: on 3.4 and 3.5 it is not needed, and it is read
 * from the network when the gateway is set up again. The socket is known by
 * its Zigbee address from then on, as the gateway names its members — not
 * by the device id it was known by on the gateway's own connection.
 */
const throughTheGateway: FileMigration = {
  from: 6,
  says: 'A Zigbee socket is reached through its Tuya gateway, which is a device of its own',
  migrate(document, installed) {
    const behindTypes = new Set(installed.filter((type) => type.methods.some((method) => method.through.includes(GATEWAY))).map((type) => type.id));
    const devices: Record<string, unknown> = { ...(isRecord(document.devices) ? document.devices : {}) };
    const gateways = new Map<string, string>();
    const freeKey = () => {
      for (let n = 1; ; n++) {
        const key = n === 1 ? 'tuya-gateway' : `tuya-gateway-${n}`;
        if (!(key in devices)) return key;
      }
    };

    for (const [key, raw] of Object.entries(devices)) {
      const entry = raw as Entry;
      if (!isRecord(entry) || typeof entry.type !== 'string' || !behindTypes.has(entry.type) || !Array.isArray(entry.connect)) continue;
      let zigbee: string | null = null;
      const connect = (entry.connect as Way[]).map((way) => {
        const [host, cid, ...rest] = typeof way?.address === 'string' ? way.address.split('#') : [];
        if (way?.via !== 'lan' || !host || !cid || rest.length) return way;
        let gatewayKey = gateways.get(host);
        if (!gatewayKey) {
          gatewayKey = freeKey();
          gateways.set(host, gatewayKey);
          const { deviceId: _plugsOwnId, ...settings } = way.settings ?? {};
          devices[gatewayKey] = {
            type: GATEWAY,
            name: 'Tuya gateway',
            connect: [{ via: 'lan', address: host, ...(Object.keys(settings).length ? { settings } : {}), ...(way.secrets ? { secrets: way.secrets } : {}), ...(way.exportable === true ? { exportable: true } : {}) }],
          };
        }
        zigbee = cid.toLowerCase();
        return { via: 'gateway', through: gatewayKey, address: zigbee };
      });
      devices[key] = { ...entry, ...(zigbee && entry.identity !== undefined ? { identity: zigbeeIdentity(zigbee) } : {}), connect };
    }
    return { ...document, devices };
  },
};

export default [throughTheGateway];
