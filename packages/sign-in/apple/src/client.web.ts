import { readIdToken, type ProviderSignIn } from '@kraftverk/identity';

import { APPLE } from './index.ts';

/*
  Sign in with Apple in a browser: Apple's own page, in a pop-up, through
  its JS. Apple lets only a site it knows ask — a Services ID registered
  with it, for this site's address over HTTPS — so it is offered only where
  this app was built with one (EXPO_PUBLIC_APPLE_SERVICES_ID, and the
  address Apple returns to, EXPO_PUBLIC_APPLE_REDIRECT_URI, this page's
  own when not said). Nowhere else: not on a computer's own address, which
  Apple does not take.
*/

const SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const SERVICES_ID = process.env.EXPO_PUBLIC_APPLE_SERVICES_ID ?? '';
const REDIRECT_URI = process.env.EXPO_PUBLIC_APPLE_REDIRECT_URI ?? '';

type AppleJs = {
  auth: {
    init(options: { clientId: string; scope: string; redirectURI: string; usePopup: boolean; nonce: string }): void;
    signIn(): Promise<{ authorization: { id_token: string }; user?: { email?: string; name?: { firstName?: string; lastName?: string } } }>;
  };
};

/** Apple's JS, loaded once, when it is first needed. */
let loading: Promise<AppleJs> | null = null;
function appleJs(): Promise<AppleJs> {
  loading ??= new Promise<AppleJs>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve((globalThis as unknown as { AppleID: AppleJs }).AppleID);
    script.onerror = () => {
      loading = null;
      reject(new Error('Apple’s sign-in could not be reached'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export const appleSignIn: ProviderSignIn = {
  provider: APPLE,
  label: 'Continue with Apple',
  available: async () => SERVICES_ID !== '' && location.protocol === 'https:',
  async signIn(nonce) {
    const apple = await appleJs();
    apple.auth.init({ clientId: SERVICES_ID, scope: 'name email', redirectURI: REDIRECT_URI || location.origin, usePopup: true, nonce });
    try {
      const answer = await apple.auth.signIn();
      const token = answer.authorization.id_token;
      const claims = readIdToken(token, APPLE.issuer);
      if (!claims) throw new Error('Apple gave no token');
      const name = [answer.user?.name?.firstName, answer.user?.name?.lastName].filter(Boolean).join(' ').trim();
      return { token, subject: claims.subject, email: (answer.user?.email ?? claims.email)?.toLowerCase() ?? null, name: name || null };
    } catch (error) {
      // Closed by the person: nothing happened, and nothing is said.
      if ((error as { error?: string }).error === 'popup_closed_by_user' || (error as { error?: string }).error === 'user_cancelled_authorize') return null;
      throw error;
    }
  },
};
