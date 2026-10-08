import type { ConfigSchema, Protocol } from '@kraftverk/device-sdk';

import { signIn } from './sign-in.ts';

/**
 * How iCloud is spoken to: Apple's sign-in (SRP, srp.ts; a second factor;
 * trust), iCloud's account, and Find My — over HTTPS to Apple's hosts and no
 * others. Pure: it runs in the app as well as on a server, and the SDK is
 * all it imports. How it keeps up with Apple: docs/ICLOUD.md.
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
  help: 'Your Apple ID and its password stay on this kraftverk: they are how it signs in again when Apple ends a session. Apple asks for a code from one of your devices once.',
  fields: {
    appleId: { type: 'string', title: 'Apple ID', description: 'The email address you sign in to iCloud with.', required: true, autocomplete: 'username' },
    password: { type: 'string', presentation: 'secret', title: 'Password', required: true, autocomplete: 'current-password' },
    session: { type: 'string', presentation: 'secret', kept: 'session', title: 'Signed in' },
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
  credentials: { schema: CREDENTIALS, actions: [signIn], first: true, title: 'Your Apple Account' },
};

export default protocol;
