import { describe, expect, test } from 'bun:test';

import { platformsOf, type HttpChannel } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, fakeConnection } from '@kraftverk/device-sdk/testing';
import { md5Hex, NIU_ACCOUNT, NIU_API } from '../src/protocol/index.ts';

import account from '../src/account.ts';
import migrations from '../src/migrations.ts';

/**
 * The NIU account: signed in once, a bridge to every scooter on it
 * (docs/PLAN-INTEGRATIONS.md §4.3) — and how a configuration file written
 * before it existed comes back with it. Every account and serial here is
 * made up.
 */

/** NIU's sign-in host and API, answering one made-up account with two made-up scooters. */
function niu(): HttpChannel {
  const answer = (data: unknown) => new Response(JSON.stringify({ status: 0, data }));
  return {
    kind: 'http',
    connected: true,
    onConnectedChange: () => () => undefined,
    fetch: async (url, init) => {
      if (url === `${NIU_ACCOUNT}/v3/api/oauth2/token`) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('password') !== md5Hex('correct horse')) return new Response(JSON.stringify({ status: 2003, desc: 'wrong' }));
        return answer({ token: { access_token: 't', refresh_token: 'r', token_expires_in: 7200 } });
      }
      if (url === `${NIU_API}/v5/scooter/list`) return answer({ items: [{ sn_id: 'N0TAREALSERIAL01', scooter_name: 'Blixten' }, { sn: 'N0TAREALSERIAL02', sku_name: 'NQi GT' }] });
      return new Response('', { status: 404 });
    },
    close: async () => undefined,
  };
}

const over = (password = 'correct horse') =>
  fakeConnection({ method: 'cloud', protocol: 'niu-cloud', transport: 'https', address: NIU_API, channel: niu(), config: { account: 'Rider@Example.test ' }, secrets: { password } });

describe('a NIU account', () => {
  test('keeps the device-type contract: an account, a bridge, its simulator bringing scooters', async () => {
    expect(await checkDeviceTypeContract(account)).toEqual([]);
    expect([account.kind, account.meta.category, account.bridge]).toEqual(['account', 'account', { fallback: 'niu.scooter' }]);
  });

  test('held only where its password may stay, and where NIU answers: never in a browser — two facts, kept apart', () => {
    const way = account.connections[0]!;
    expect(way.needs).toEqual({ trusted: 'your NIU password stays at home' });
    expect(platformsOf(way, { platforms: ['system', 'web', 'native'] })).toEqual(['system', 'native']);
  });

  test('checked once: the scooters on it, and who it is — its sign-in, written plainly', async () => {
    const identified = await account.identify(over(), { config: {}, log: console as never, home: null, signal: AbortSignal.timeout(5_000) });
    expect(identified).toMatchObject({ identity: 'niu-cloud:account:rider@example.test', summary: 'Signed in: Blixten, NQi GT are on it.' });
  });

  test('a wrong password is said, not guessed around', async () => {
    await expect(account.identify(over('wrong'), { config: {}, log: console as never, home: null, signal: AbortSignal.timeout(5_000) })).rejects.toThrow('did not accept');
  });
});

describe("a file kept before the account was a device of its own", () => {
  /** What is installed: the generic scooter, and a product reached through the account, by made-up ids. */
  const installed = [
    { id: 'niu.account', methods: [{ id: 'cloud', through: [] }] },
    { id: 'niu.scooter', methods: [{ id: 'account', through: ['niu.account'] }] },
    { id: 'niu.model-x', methods: [{ id: 'account', through: ['niu.account'] }] },
    { id: 'acme.plug', methods: [{ id: 'cloud', through: [] }] },
  ];
  /** As version 5 wrote it: each scooter with its own account and password. */
  const kept = {
    kraftverk: 5,
    devices: {
      scooter: { type: 'niu.model-x', name: 'Scooter', connect: [{ via: 'cloud', settings: { account: 'rider@example.test', serial: 'N0TAREALSERIAL01' }, secrets: { password: { secret: 'scooter.password' } } }] },
      other: { type: 'niu.scooter', name: 'Other', connect: [{ via: 'cloud', settings: { account: 'Rider@example.test', serial: 'N0TAREALSERIAL02' }, secrets: { password: { secret: 'other.password' } } }] },
      plug: { type: 'acme.plug', name: 'Plug', connect: [{ via: 'cloud', settings: { account: 'someone', serial: 'X' } }] },
    },
  };

  test('comes back as an account, once for both scooters on it, and each scooter reached through it by its serial', () => {
    const [migration] = migrations;
    expect(migration!.from).toBe(5);
    const migrated = migration!.migrate(kept, installed) as { devices: Record<string, { type: string; name: string; connect: unknown[] }> };
    expect(migrated.devices['niu-account']).toEqual({
      type: 'niu.account',
      name: 'NIU account',
      connect: [{ via: 'cloud', settings: { account: 'rider@example.test' }, secrets: { password: { secret: 'scooter.password' } } }],
    });
    expect(migrated.devices.scooter!.connect).toEqual([{ via: 'account', through: 'niu-account', address: 'N0TAREALSERIAL01' }]);
    expect(migrated.devices.other!.connect).toEqual([{ via: 'account', through: 'niu-account', address: 'N0TAREALSERIAL02' }]);
    // What is not NIU's is left as it was.
    expect(migrated.devices.plug).toEqual(kept.devices.plug);
    expect(Object.keys(migrated.devices).filter((key) => key.startsWith('niu-account'))).toEqual(['niu-account']);
  });
});
