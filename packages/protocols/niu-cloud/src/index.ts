import type { ConfigSchema, OpenConnection, Protocol, SetupAction, SetupChoice } from '@kraftverk/device-sdk';

import { NIU_ACCOUNT, NIU_API, NiuClient, NiuError, signIn, type NiuHttp } from './api.ts';

export * from './api.ts';
export { md5Hex } from './md5.ts';

/**
 * The NIU cloud as a protocol: how a scooter NIU's servers speak for is
 * reached — over HTTPS, to the API host, and to the sign-in host beside it
 * (`alsoOrigins`), and nowhere else.
 *
 * A NIU scooter of this age has no way in but NIU's cloud: its control unit
 * reports over the mobile network, and the app reads it back from NIU. So
 * this is a cloud connection, always, and says so.
 *
 * Its credentials are the NIU app's account: an email or phone number, and
 * the password — kept as the connection's secret, encrypted, and sent to NIU
 * (hashed, as the app does) to sign in. Signing in lists the scooters on the
 * account, so which one is yours is a pick, not a serial number to find.
 */

export const CREDENTIALS: ConfigSchema = {
  help: 'NIU scooters of this age are reached through NIU’s cloud, with the account you use in the NIU app. Signing in lists your scooters.',
  fields: {
    account: { type: 'string', title: 'Email or phone number', description: 'The one you sign in to the NIU app with.', required: true },
    password: {
      type: 'string',
      presentation: 'secret',
      title: 'Password',
      description: 'Kept encrypted on your server, and sent only to NIU, to sign in.',
      required: true,
    },
    serial: { type: 'string', title: 'Serial number', description: 'Filled in when you pick your scooter.', required: true },
  },
};

const signInSchema: ConfigSchema = {
  fields: {
    account: CREDENTIALS.fields.account!,
    password: CREDENTIALS.fields.password!,
  },
};

/** Signs in with the NIU app's account and lists its scooters: the one picked brings its serial, and the account. */
const signInAction: SetupAction = {
  id: 'signIn',
  label: 'Sign in with your NIU account',
  description: 'The account you use in the NIU app. Your scooters come back by name; nothing is changed on them.',
  input: signInSchema,
  async run(ctx, input) {
    const account = String(input.account ?? '').trim();
    const password = String(input.password ?? '');
    if (!account || !password) return { ok: false, detail: 'Both the account and its password are needed.' };
    const http: NiuHttp = (url, init) => ctx.http(url, init);
    try {
      await signIn(http, account, password);
      const scooters = await new NiuClient(http, { account, password }).scooters();
      if (!scooters.length) return { ok: false, detail: 'Signed in, but there is no scooter on this account. Is it bound to it in the NIU app?' };
      const choices: SetupChoice[] = scooters.map((scooter) => ({
        id: scooter.serial,
        label: scooter.name ?? scooter.model ?? 'NIU scooter',
        detail: [scooter.model, `serial ${scooter.serial}`].filter(Boolean).join(' · '),
        config: { account, password, serial: scooter.serial },
        // Always reached at the API; nothing to find on a network.
        address: NIU_API,
        ...(scooter.name ? { name: scooter.name } : {}),
        recommended: scooters.length === 1,
      }));
      return { ok: true, detail: `Signed in: ${scooters.length} scooter${scooters.length === 1 ? '' : 's'} on the account. Which is it?`, choices };
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
      // Nothing to find: a scooter is picked from the account.
      recognise: () => null,
    },
  },
  credentials: { schema: CREDENTIALS, actions: [signInAction], first: true, title: 'Your NIU account' },
};

export default protocol;

/** A signed-in client over an open connection: its channel, and the account and scooter setup stored with it. */
export function clientOver(connection: OpenConnection, now?: () => number): { client: NiuClient; serial: string } {
  if (connection.channel.kind !== 'http') throw new Error('The NIU cloud is reached over HTTPS');
  const channel = connection.channel;
  const account = String(connection.config.account ?? '').trim();
  const serial = String(connection.config.serial ?? '').trim();
  const password = connection.secrets.get('password');
  if (!account || !password) throw new Error('No NIU account: sign in again in the scooter’s connection settings');
  if (!serial) throw new Error('No scooter chosen: pick it again in the connection settings');
  return { client: new NiuClient((url, init) => channel.fetch(url, init), { account, password }, now), serial };
}
