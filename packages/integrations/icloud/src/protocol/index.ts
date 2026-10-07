import type { ConfigSchema, ConfigValues, Protocol, SetupAction, SetupActionResult } from '@kraftverk/device-sdk';

import { AppleRefused, IcloudAuth, newState, type IcloudFetch, type IcloudState } from './auth.ts';
import { FindMy } from './findmy.ts';

/**
 * How iCloud is spoken to: Apple's sign-in (SRP, srp.ts; a second factor;
 * trust), iCloud's account, and Find My — over HTTPS to Apple's hosts and no
 * others. Pure: it runs in the app as well as on a server, and the SDK is
 * all it imports.
 *
 * Ported from Home Assistant's `icloud` integration and pyicloud (MIT), and
 * pysrp (MIT); NOTICE.
 */

export * from './auth.ts';
export * from './cookies.ts';
export * from './findmy.ts';
export * from './srp.ts';

/** The account's identity: Apple's id for it, its dsid. */
export const accountIdentity = (dsid: string): string => `icloud-web:${dsid}`;

/** Where iCloud's setup is: the address a way to it has. */
export const ICLOUD_SETUP = 'https://setup.icloud.com';

/**
 * What a way to iCloud stores: the Apple ID, its password — a person's —
 * and the session Apple's sign-in made, kept by the session itself: its
 * trust token, so signing in again asks no code, and its cookies.
 */
export const CREDENTIALS: ConfigSchema = {
  help: 'Your Apple ID and its password stay on this server: they are how it signs in again when Apple ends a session. Apple asks for a code from one of your devices once.',
  fields: {
    appleId: { type: 'string', title: 'Apple ID', description: 'The email address you sign in to iCloud with.', required: true },
    password: { type: 'string', presentation: 'secret', title: 'Password', required: true },
    session: { type: 'string', presentation: 'secret', kept: 'session', title: 'Signed in' },
  },
};

/** The session kept in a connection's secret, read back; a new one when there is none. */
export function stateOf(kept: string | null | undefined): IcloudState {
  if (!kept) return newState();
  try {
    const state = JSON.parse(kept) as IcloudState;
    return typeof state.clientId === 'string' && Array.isArray(state.cookies) ? state : newState();
  } catch {
    return newState();
  }
}

/** What the person is asked for, when Apple asks for a second factor. */
const askFor = (length: number, phone: string | null, canText: boolean): ConfigSchema => ({
  help: phone ? `Apple sent a code by text to ${phone}.` : 'Apple sent a code to your iPhone, iPad or Mac: allow it there, and type it here.',
  fields: {
    code: { type: 'string', title: 'Code', description: `The ${length} digits Apple shows.`, required: !canText },
    ...(canText ? { byText: { type: 'boolean', title: 'Send it by text instead', default: false } } : {}),
  },
});

/** The sign-in, as a setup action: a code asked for in turns, and the session kept. */
const signIn: SetupAction = {
  id: 'signIn',
  label: 'Sign in with Apple',
  description: 'Signs in to iCloud, as icloud.com does: Apple asks for a code from one of your devices, once.',
  async run(ctx, input: ConfigValues): Promise<SetupActionResult> {
    const appleId = typeof ctx.connection.appleId === 'string' ? ctx.connection.appleId.trim() : '';
    const password = ctx.secrets.get('password');
    if (!appleId || !password) return { ok: false, detail: 'Give your Apple ID and its password first' };
    const fetcher: IcloudFetch = (url, init) => ctx.http(url, init);
    const auth = new IcloudAuth(fetcher, stateOf(typeof input.state === 'string' ? input.state : null));
    const done = async (account: Awaited<ReturnType<IcloudAuth['accountLogin']>>): Promise<SetupActionResult> => {
      const devices = account.findMe ? await new FindMy(auth, account).devices().catch(() => null) : null;
      return {
        ok: true,
        detail: `Signed in to iCloud${devices ? `: ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} in Find My, the family’s included` : ''}.`,
        suggestedConfig: { session: JSON.stringify(auth.state) },
      };
    };
    try {
      // A later turn: the code — or a text asked for instead.
      if (typeof input.state === 'string') {
        const phoneId = typeof input.phoneId === 'number' ? input.phoneId : undefined;
        if (input.byText === true) {
          // Asked only now: asking how a code can come has Apple send one to the devices again.
          const phone = (await auth.secondFactor()).phones[0];
          if (!phone) return { ok: false, detail: 'This Apple ID has no trusted number to text a code to', ask: { schema: askFor(6, null, false), carry: { state: JSON.stringify(auth.state) } } };
          await auth.sendTextCode(phone.id);
          return { ok: true, detail: 'A code is on its way by text', ask: { schema: askFor(6, phone.number, false), carry: { state: JSON.stringify(auth.state), phoneId: phone.id } } };
        }
        const code = typeof input.code === 'string' ? input.code.replace(/\s/g, '') : '';
        if (!/^\d{4,8}$/.test(code)) return { ok: false, detail: 'Type the digits Apple shows', ask: { schema: askFor(6, null, false), carry: { state: JSON.stringify(auth.state), ...(phoneId !== undefined ? { phoneId } : {}) } } };
        return await done(await auth.verify(code, phoneId));
      }
      // The first turn: the password, then a second factor if Apple asks for one.
      const signedIn = await auth.signIn(appleId, password);
      if (signedIn === 'signed-in') return await done(await auth.accountLogin());
      const factor = await auth.secondFactor();
      if (factor.byDevice) {
        return { ok: true, detail: 'Apple asks for a code', ask: { schema: askFor(factor.length, null, factor.phones.length > 0), carry: { state: JSON.stringify(auth.state) } } };
      }
      const phone = factor.phones[0];
      if (!phone) return { ok: false, detail: 'Apple asks for a code, and this Apple ID has no trusted device or number to send one to: add one at appleid.apple.com' };
      await auth.sendTextCode(phone.id);
      return { ok: true, detail: 'Apple sent a code by text', ask: { schema: askFor(factor.length, phone.number, false), carry: { state: JSON.stringify(auth.state), phoneId: phone.id } } };
    } catch (error) {
      if (error instanceof AppleRefused) {
        const retry = typeof input.state === 'string' && error.status === 400;
        return { ok: false, detail: error.message, ...(retry ? { ask: { schema: askFor(6, null, false), carry: { state: JSON.stringify(auth.state), ...(typeof input.phoneId === 'number' ? { phoneId: input.phoneId } : {}) } } } : {}) };
      }
      return { ok: false, detail: (error as Error).message };
    }
  },
};

const protocol: Protocol = {
  id: 'icloud-web',
  label: 'iCloud',
  bindings: {
    https: {
      // Apple's sign-in, and iCloud's hosts: its setup, and the services it names at sign-in (p42-fmipweb.icloud.com).
      open: () => ({ alsoOrigins: ['https://idmsa.apple.com', 'https://*.icloud.com'] }),
      // A web service is not found on a network: its address is iCloud's.
      recognise: () => null,
    },
  },
  credentials: { schema: CREDENTIALS, actions: [signIn], first: true, title: 'Your Apple ID' },
};

export default protocol;
