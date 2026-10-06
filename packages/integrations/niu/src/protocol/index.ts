import { channelOf, directOf, identityOf, type ConfigSchema, type OpenConnection, type Protocol, type SetupAction } from '@kraftverk/device-sdk';

import { NIU_ACCOUNT, NiuClient, NiuError, signIn, type NiuHttp } from './api.ts';

export * from './api.ts';
export { md5Hex } from './md5.ts';

/**
 * The NIU cloud as a protocol: how a NIU account is reached — over HTTPS, to
 * the API host and the sign-in host beside it (`alsoOrigins`) and nowhere
 * else. A scooter is not spoken to: it is read through its account's link
 * (`../link.ts`).
 *
 * A NIU scooter of this age has no way in but NIU's cloud: its control unit
 * reports over the mobile network, and the app reads it back from NIU. So
 * the account is a cloud connection, always, and says so.
 *
 * Its credentials are the NIU app's account: an email or phone number, and
 * the password — kept as the account connection's secret, encrypted, and
 * sent to NIU (hashed, as the app does) to sign in. One account, one
 * password, however many scooters are on it.
 */

export const CREDENTIALS: ConfigSchema = {
  help: 'NIU scooters of this age are reached through NIU’s cloud, with the account you use in the NIU app. Signing in finds every scooter on it.',
  fields: {
    account: { type: 'string', title: 'Email or phone number', description: 'The one you sign in to the NIU app with.', required: true },
    password: {
      type: 'string',
      presentation: 'secret',
      title: 'Password',
      description: 'Kept encrypted where the account is held, and sent only to NIU, to sign in.',
      required: true,
    },
  },
};

/** The account's identity: NIU names none, so its sign-in, as written — what makes adding it twice the same account. */
export const accountIdentity = (account: string): string => identityOf('niu-cloud', `account:${account.trim().toLowerCase()}`);

/** Signs in with the NIU app's account, and says how many scooters are on it: the account and password, checked. */
const signInAction: SetupAction = {
  id: 'signIn',
  label: 'Sign in with your NIU account',
  description: 'The account you use in the NIU app. Your scooters are found on it; nothing is changed on them.',
  input: CREDENTIALS,
  async run(ctx, input) {
    const account = String(input.account ?? '').trim();
    const password = String(input.password ?? '');
    if (!account || !password) return { ok: false, detail: 'Both the account and its password are needed.' };
    const http: NiuHttp = (url, init) => ctx.http(url, init);
    try {
      await signIn(http, account, password);
      const scooters = await new NiuClient(http, { account, password }).scooters();
      const said = scooters.length === 1 ? '1 scooter on it' : `${scooters.length} scooters on it`;
      return { ok: true, detail: scooters.length ? `Signed in: ${said}.` : 'Signed in, but there is no scooter on this account. Is it bound to it in the NIU app?', suggestedConfig: { account, password } };
    } catch (error) {
      return { ok: false, detail: error instanceof NiuError ? error.message : `NIU could not be reached: ${(error as Error).message}` };
    }
  },
};

const protocol: Protocol = {
  id: 'niu-cloud',
  label: 'NIU cloud',
  bindings: {
    https: {
      // The API is the address; the sign-in host is the one other it may reach.
      open: () => ({ alsoOrigins: [NIU_ACCOUNT] }),
      // Nothing to find: the account is signed into.
      recognise: () => null,
    },
  },
  credentials: { schema: CREDENTIALS, actions: [signInAction], first: true, title: 'Your NIU account' },
};

export default protocol;

/** A signed-in client over an account's open connection: its channel, and the account stored with it. */
export function clientOver(connection: OpenConnection, now?: () => number): { client: NiuClient; account: string } {
  const channel = channelOf(connection, 'http', 'The NIU cloud is reached over HTTPS');
  const account = String(connection.config.account ?? '').trim();
  const password = directOf(connection, 'The NIU cloud is reached over HTTPS').secrets.get('password');
  if (!account || !password) throw new Error('No NIU account: sign in again in the account’s connection settings');
  return { client: new NiuClient((url, init) => channel.fetch(url, init), { account, password }, now), account };
}
