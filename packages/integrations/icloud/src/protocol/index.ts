import type { ConfigSchema, ConfigValues, Protocol, SetupAction, SetupActionResult } from '@kraftverk/device-sdk';

import { AppleRefused, IcloudAuth, newState, type IcloudFetch, type IcloudState } from './auth.ts';
import { FindMy } from './findmy.ts';
import type { AuthOptions, TrustedPhone } from './options.ts';

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
export * from './options.ts';
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
    appleId: { type: 'string', title: 'Apple ID', description: 'The email address you sign in to iCloud with.', required: true, autocomplete: 'username' },
    password: { type: 'string', presentation: 'secret', title: 'Password', required: true, autocomplete: 'current-password' },
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

/** What the person is asked for, when Apple asks for a second factor: where the code went, and — when it went to the devices — a number it can be texted to instead. */
const askFor = (length: number, sentTo: TrustedPhone | null, textTo: TrustedPhone | null): ConfigSchema => ({
  help: sentTo
    ? sentTo.mode === 'voice' ? `Apple is calling ${sentTo.number} with a code.` : `Apple sent a code by text to ${sentTo.number}.`
    : 'Apple shows a code on your iPhone, iPad or Mac: tap Allow there, and type it here.',
  fields: {
    code: { type: 'string', presentation: 'code', length, title: 'Code', description: `The ${length} digits Apple shows.`, required: !textTo },
    ...(textTo ? { byText: { type: 'boolean', title: `Text it to ${textTo.number} instead`, default: false } } : {}),
  },
});

/** A trusted number carried between turns, read back. */
function phoneIn(value: unknown): TrustedPhone | null {
  if (typeof value !== 'string') return null;
  try {
    const phone = JSON.parse(value) as TrustedPhone;
    return typeof phone.id === 'number' && typeof phone.number === 'string' ? phone : null;
  } catch {
    return null;
  }
}

/** What Apple said it takes, in a line for the log: no number, no name. */
const optionsLine = (options: AuthOptions) =>
  `Apple asks for a code: route ${options.route ?? 'none'}, ${options.devices ? 'trusted devices' : 'no trusted device'}, ${options.phones.length} trusted ${options.phones.length === 1 ? 'number' : 'numbers'}${options.securityKeys.length ? `, ${options.securityKeys.length} security keys` : ''}${options.bridge ? ', bridge offered' : ''}`;

/** The sign-in, as a setup action: with what is typed, a code asked for in turns, and the session kept. */
const signIn: SetupAction = {
  id: 'signIn',
  label: 'Sign in',
  description: 'Signs in to iCloud, as icloud.com does: Apple asks for a code from one of your devices, once.',
  // The step's own button: the Apple ID and password typed above it are what it signs in with.
  primary: true,
  async run(ctx, input: ConfigValues): Promise<SetupActionResult> {
    // What is typed now, or what was kept before: signing in again needs only what is missing.
    const typed = (field: string) => (typeof input[field] === 'string' && (input[field] as string).trim() ? (input[field] as string).trim() : null);
    const appleId = typed('appleId') ?? (typeof ctx.connection.appleId === 'string' ? ctx.connection.appleId.trim() : '');
    const password = (typeof input.password === 'string' && input.password ? input.password : null) ?? ctx.secrets.get('password');
    const fetcher: IcloudFetch = (url, init) => ctx.http(url, init);
    const auth = new IcloudAuth(fetcher, stateOf(typeof input.state === 'string' ? input.state : null), undefined, (line) => ctx.log.info(`iCloud: ${line}`));
    const carry = (more: ConfigValues = {}): ConfigValues => ({ state: JSON.stringify(auth.state), ...more });
    const done = async (account: Awaited<ReturnType<IcloudAuth['accountLogin']>>): Promise<SetupActionResult> => {
      const devices = account.findMe ? await new FindMy(auth, account).devices().catch(() => null) : null;
      ctx.log.info(`iCloud: signed in${devices ? `, ${devices.length} in Find My` : ''}`);
      return {
        ok: true,
        detail: `Signed in to iCloud${devices ? `: ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} in Find My, the family’s included` : ''}.`,
        suggestedConfig: { session: JSON.stringify(auth.state) },
      };
    };
    try {
      // A later turn: the code — or a text asked for instead.
      if (typeof input.state === 'string') {
        const sentTo = phoneIn(input.phone);
        const textTo = phoneIn(input.textTo);
        if (input.byText === true && textTo) {
          await auth.sendTextCode(textTo);
          return { ok: true, detail: textTo.mode === 'voice' ? 'Apple is calling with a code' : 'A code is on its way by text', ask: { schema: askFor(6, textTo, null), carry: carry({ phone: JSON.stringify(textTo) }) } };
        }
        const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/g, '') : '';
        if (!/^\d{4,8}$/.test(code)) return { ok: false, detail: 'Type the digits Apple shows', ask: { schema: askFor(6, sentTo, textTo), carry: carry({ ...(sentTo ? { phone: JSON.stringify(sentTo) } : {}), ...(textTo ? { textTo: JSON.stringify(textTo) } : {}) }) } };
        return await done(await auth.verify(code, sentTo ?? undefined));
      }

      // The first turn: the password, then a second factor if Apple asks for one.
      if (!appleId || !password) return { ok: false, detail: 'Type your Apple ID and its password' };
      // Kept in the setup as soon as they are typed: a code asked for next is given with them in hand.
      const typedConfig = { appleId, password };
      const signedIn = await auth.signIn(appleId, password);
      if (signedIn === 'signed-in') {
        const result = await done(await auth.accountLogin());
        return { ...result, suggestedConfig: { ...typedConfig, ...result.suggestedConfig } };
      }
      const options = await auth.authOptions();
      ctx.log.info(`iCloud: ${optionsLine(options)}`);
      const textTo = options.phones[0] ?? null;
      if (options.devices) {
        try {
          await auth.requestCode();
          return { ok: true, detail: 'Apple asks for a code', suggestedConfig: typedConfig, ask: { schema: askFor(options.length, null, textTo), carry: carry(textTo ? { textTo: JSON.stringify(textTo) } : {}) } };
        } catch (error) {
          if (!(error instanceof AppleRefused) || !textTo) throw error;
          ctx.log.warn(`iCloud: no code shown on the devices (${error.message}); texting one instead`);
        }
      }
      if (!textTo) {
        if (options.securityKeys.length) return { ok: false, detail: 'This Apple ID signs in with a security key, which kraftverk cannot use yet' };
        return { ok: false, detail: 'Apple asks for a code, and this Apple ID has no trusted device or number to send one to: add one at account.apple.com' };
      }
      await auth.sendTextCode(textTo);
      return { ok: true, detail: textTo.mode === 'voice' ? 'Apple is calling with a code' : 'Apple sent a code by text', suggestedConfig: typedConfig, ask: { schema: askFor(options.length, textTo, null), carry: carry({ phone: JSON.stringify(textTo) }) } };
    } catch (error) {
      ctx.log.warn(`iCloud: ${(error as Error).message}`);
      if (error instanceof AppleRefused && typeof input.state === 'string' && (error.status === 400 || error.status === 409)) {
        // Another try, or a text: the code's question stays.
        const sentTo = phoneIn(input.phone);
        const textTo = phoneIn(input.textTo);
        return { ok: false, detail: error.message, ask: { schema: askFor(6, sentTo, textTo), carry: carry({ ...(sentTo ? { phone: JSON.stringify(sentTo) } : {}), ...(textTo ? { textTo: JSON.stringify(textTo) } : {}) }) } };
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
