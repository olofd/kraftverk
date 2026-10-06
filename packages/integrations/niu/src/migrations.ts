import type { FileMigration } from '@kraftverk/device-sdk';

/*
  How NIU's entries in a configuration file changed (docs/CONFIG.md), so a
  home kept before comes back after. Each finds its entries by what is
  installed — the types reached through a NIU account — never by a model's
  name: the platform names no product.
*/

const ACCOUNT = 'niu.account';

type Way = { via?: unknown; through?: unknown; address?: unknown; settings?: Record<string, unknown>; secrets?: Record<string, unknown>; exportable?: unknown };
type Entry = { type?: unknown; name?: unknown; connect?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Version 6: a scooter no longer keeps its NIU account. Until then each
 * scooter was reached "cloud" with the account and its password on it; now
 * the account is a device of its own, reached "cloud", and the scooter is
 * reached through it by its serial. One account entry for each account
 * named — two scooters on one account share it, and its password.
 */
const throughTheAccount: FileMigration = {
  from: 5,
  says: 'A NIU scooter is reached through its NIU account, which is a device of its own',
  migrate(document, installed) {
    const scooterTypes = new Set(installed.filter((type) => type.methods.some((method) => method.through.includes(ACCOUNT))).map((type) => type.id));
    const devices: Record<string, unknown> = { ...(isRecord(document.devices) ? document.devices : {}) };
    const accounts = new Map<string, string>();
    const freeKey = () => {
      for (let n = 1; ; n++) {
        const key = n === 1 ? 'niu-account' : `niu-account-${n}`;
        if (!(key in devices)) return key;
      }
    };

    for (const [key, raw] of Object.entries(devices)) {
      const entry = raw as Entry;
      if (!isRecord(entry) || typeof entry.type !== 'string' || !scooterTypes.has(entry.type) || !Array.isArray(entry.connect)) continue;
      const connect = (entry.connect as Way[]).map((way) => {
        const account = way?.settings?.account;
        const serial = way?.settings?.serial;
        if (way?.via !== 'cloud' || typeof account !== 'string' || typeof serial !== 'string') return way;
        const named = account.trim().toLowerCase();
        let accountKey = accounts.get(named);
        if (!accountKey) {
          accountKey = freeKey();
          accounts.set(named, accountKey);
          devices[accountKey] = {
            type: ACCOUNT,
            name: 'NIU account',
            connect: [{ via: 'cloud', settings: { account: account.trim() }, ...(way.secrets ? { secrets: way.secrets } : {}), ...(way.exportable === true ? { exportable: true } : {}) }],
          };
        }
        return { via: 'account', through: accountKey, address: serial };
      });
      devices[key] = { ...entry, connect };
    }
    return { ...document, devices };
  },
};

export default [throughTheAccount];
