import type { ConfigValues, SetupAction, SetupActionResult, SetupContext } from '@kraftverk/device-sdk';

import { AppleBusy, AppleRefused, IcloudAuth, stateOf, type IcloudAccount, type IcloudFetch } from './auth.ts';
import { FindMy } from './findmy.ts';
import type { AuthOptions, TrustedPhone } from './options.ts';

/*
  Signing in, as a setup action (docs/ICLOUD.md §3.1): the Apple ID and
  password typed above it; then — when Apple asks for one — a code, asked
  for on the trusted devices and typed here, with "Didn't get a code?" one
  tap away: shown again, texted, or read out by a call, each waiting a
  little longer than the last so Apple is not asked too often.

  What the next turn needs rides in `carry`, never shown: Apple's session
  half made, and how this sign-in may be answered (`Talk`).
*/

/** How this sign-in's code may come, carried between its turns. */
type Talk = {
  length: number;
  /** Whether Apple can show a code on a trusted device. */
  devices: boolean;
  phones: TrustedPhone[];
  /** Where the last code was sent: a number, or the devices (null). */
  sentTo: TrustedPhone | null;
  /** How many times a code has been sent; and when the last was. */
  sends: number;
  at: number;
};

/** How long before a code may be asked for again: longer each time, as Apple's own page waits. */
const cooldownMs = (sends: number) => Math.min(120, 30 * 2 ** Math.max(0, sends - 1)) * 1000;

const GET_ONE = 'None? On an iPhone signed in to this Apple ID: Settings › your name › Sign-In & Security › Get Verification Code.';

/** The question, as it stands: where the code went, the boxes for it, and the other ways it can come. */
function question(auth: IcloudAuth, talk: Talk, detail: string, ok = true): SetupActionResult {
  const after = new Date(talk.at + cooldownMs(talk.sends)).toISOString();
  const to = talk.sentTo;
  return {
    ok,
    detail,
    ask: {
      schema: {
        help: to
          ? to.mode === 'voice'
            ? `Apple is calling ${to.number}: it reads out a code.`
            : `Apple sent a code by text to ${to.number}.`
          : 'Apple shows a code on your iPhone, iPad or Mac: tap Allow there, then type it here.',
        fields: {
          code: { type: 'string', presentation: 'code', length: talk.length, title: 'Code', description: talk.devices ? `The ${talk.length} digits Apple shows. ${GET_ONE}` : `The ${talk.length} digits.`, required: true },
        },
      },
      carry: { state: JSON.stringify(auth.state), talk: JSON.stringify(talk) },
      instead: {
        title: 'Didn’t get a code?',
        options: [
          ...(talk.devices ? [{ label: 'Show it on my devices again', answer: { again: 'devices' }, after }] : []),
          ...talk.phones.flatMap((phone) => [
            { label: `Text it to ${phone.number}`, answer: { sendTo: JSON.stringify({ ...phone, mode: 'sms' }) }, after },
            { label: `Call ${phone.number}`, answer: { sendTo: JSON.stringify({ ...phone, mode: 'voice' }) }, after },
          ]),
        ],
      },
    },
  };
}

function parsed<T>(value: unknown, holds: (each: T) => boolean): T | null {
  if (typeof value !== 'string') return null;
  try {
    const each = JSON.parse(value) as T;
    return each && holds(each) ? each : null;
  } catch {
    return null;
  }
}

const talkIn = (value: unknown) => parsed<Talk>(value, (talk) => typeof talk.length === 'number' && Array.isArray(talk.phones));
const phoneIn = (value: unknown) => parsed<TrustedPhone>(value, (phone) => typeof phone.id === 'number' && typeof phone.number === 'string' && (phone.mode === 'sms' || phone.mode === 'voice'));

/** What Apple said it takes, in a line for the log: no number, no name. */
const optionsLine = (options: AuthOptions) =>
  `Apple asks for a code: route ${options.route ?? 'none'}, ${options.devices ? 'trusted devices' : 'no trusted device'}, ${options.phones.length} trusted ${options.phones.length === 1 ? 'number' : 'numbers'}${options.securityKeys.length ? `, ${options.securityKeys.length} security keys` : ''}${options.bridge ? ', bridge offered' : ''}`;

/** Signed in: who is in its Find My — or why nothing can be. */
async function signedIn(ctx: SetupContext, auth: IcloudAuth, account: IcloudAccount): Promise<SetupActionResult> {
  const session = { session: JSON.stringify(auth.state) };
  if (!account.findMe) {
    ctx.log.info('iCloud: signed in, but Find My is not offered on the web');
    return {
      ok: true,
      detail: 'Signed in, but Apple offers no Find My for this Apple ID on the web: turn Find My on on your iPhone (Settings › your name › Find My) — and, if Advanced Data Protection is on, Access iCloud Data on the Web — then sign in again.',
      suggestedConfig: session,
    };
  }
  const devices = await new FindMy(auth, account).devices().catch(() => null);
  ctx.log.info(`iCloud: signed in${devices ? `, ${devices.length} in Find My` : ''}`);
  const names = devices?.map((device) => (device.owner ? `${device.name} (${device.owner})` : device.name)) ?? [];
  const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  return {
    ok: true,
    detail: devices === null ? 'Signed in to iCloud.' : devices.length ? `Signed in to iCloud: ${listed} ${devices.length === 1 ? 'is' : 'are'} in its Find My.` : 'Signed in to iCloud, but nothing is in its Find My yet.',
    suggestedConfig: session,
  };
}

export const signIn: SetupAction = {
  id: 'signIn',
  label: 'Sign in',
  description: 'Signs in to iCloud, as icloud.com does: Apple asks for a code from one of your devices, once.',
  // The step's own button: the Apple ID and password typed above it are what it signs in with.
  primary: true,
  async run(ctx, input: ConfigValues): Promise<SetupActionResult> {
    // What is typed now, or what was kept before: signing in again needs only what is missing.
    const typed = typeof input.appleId === 'string' ? input.appleId.trim() : '';
    const appleId = typed || (typeof ctx.connection.appleId === 'string' ? ctx.connection.appleId.trim() : '');
    const password = (typeof input.password === 'string' && input.password ? input.password : null) ?? ctx.secrets.get('password');
    const fetcher: IcloudFetch = (url, init) => ctx.http(url, init);
    const auth = new IcloudAuth(fetcher, stateOf(typeof input.state === 'string' ? input.state : null), undefined, (line) => ctx.log.info(`iCloud: ${line}`));
    const talk = talkIn(input.talk);
    try {
      // A later turn: the code — or another way to have one.
      if (typeof input.state === 'string') {
        if (!talk) return { ok: false, detail: 'That sign-in has ended: sign in again' };
        if (input.again === 'devices') {
          await auth.requestCode();
          return question(auth, { ...talk, sentTo: null, sends: talk.sends + 1, at: Date.now() }, 'Apple shows a new code on your devices');
        }
        const sendTo = phoneIn(input.sendTo);
        if (sendTo) {
          await auth.sendTextCode(sendTo);
          return question(auth, { ...talk, sentTo: sendTo, sends: talk.sends + 1, at: Date.now() }, sendTo.mode === 'voice' ? `Apple is calling ${sendTo.number}` : `A code is on its way to ${sendTo.number}`);
        }
        const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/g, '') : '';
        if (code.length !== talk.length || !/^\d+$/.test(code)) return question(auth, talk, `Type the ${talk.length} digits Apple shows`, false);
        return await signedIn(ctx, auth, await auth.verify(code, talk.sentTo ?? undefined, password));
      }

      // The first turn: the password, then a second factor if Apple asks for one.
      if (!appleId || !password) return { ok: false, detail: 'Type your Apple ID and its password' };
      // Kept in the setup as soon as they are typed: a code asked for next is given with them in hand.
      const given = { appleId, password };
      if ((await auth.signIn(appleId, password)) === 'signed-in') {
        const result = await signedIn(ctx, auth, await auth.accountLogin());
        return { ...result, suggestedConfig: { ...given, ...result.suggestedConfig } };
      }
      const options = await auth.authOptions();
      ctx.log.info(`iCloud: ${optionsLine(options)}`);
      const first: Talk = { length: options.length, devices: options.devices, phones: options.phones, sentTo: null, sends: 1, at: Date.now() };
      if (options.devices) {
        try {
          await auth.requestCode();
          return { ...question(auth, first, 'Apple asks for a code'), suggestedConfig: given };
        } catch (error) {
          if (!(error instanceof AppleRefused) || !options.phones.length) throw error;
          ctx.log.warn(`iCloud: no code shown on the devices (${error.message}); texting one instead`);
        }
      }
      const phone = options.phones[0];
      if (!phone) {
        if (options.securityKeys.length) return { ok: false, detail: 'This Apple ID signs in with a security key, which kraftverk cannot use yet' };
        return { ok: false, detail: 'Apple asks for a code, and this Apple ID has no trusted device or number to send one to: add one at account.apple.com' };
      }
      await auth.sendTextCode(phone);
      return { ...question(auth, { ...first, devices: false, sentTo: phone }, phone.mode === 'voice' ? `Apple is calling ${phone.number}` : `Apple sent a code to ${phone.number}`), suggestedConfig: given };
    } catch (error) {
      ctx.log.warn(`iCloud: ${(error as Error).message}`);
      // Apple refusing for a while: said with when, and the button held until then.
      if (error instanceof AppleBusy) return { ok: false, detail: error.message, retryAt: new Date(error.until).toISOString() };
      // A code not taken: the question stays, to be answered again or another way.
      if (error instanceof AppleRefused && talk && [400, 401, 409].includes(error.status)) return question(auth, talk, error.message, false);
      return { ok: false, detail: (error as Error).message };
    }
  },
};
