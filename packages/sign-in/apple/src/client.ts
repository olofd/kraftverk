import * as Sign from 'expo-apple-authentication';

import { readIdToken, type ProviderSignIn } from '@kraftverk/identity';

import { APPLE } from './index.ts';

/*
  Sign in with Apple on a phone: iOS's own sheet, straight from Apple
  (expo-apple-authentication). Android has no such sheet, and is told
  there is none. The token is the system's, handed over from Apple: what
  it says is taken as it is; a server that is handed one checks it. A
  browser's is `client.web.ts`.
*/

/** Their name as Apple gives it — the first time only — written as they would. */
const nameOf = (name: Sign.AppleAuthenticationFullName | null): string | null => {
  const whole = [name?.givenName, name?.middleName, name?.familyName].filter(Boolean).join(' ').trim();
  return whole || null;
};

export const appleSignIn: ProviderSignIn = {
  provider: APPLE,
  label: 'Continue with Apple',
  available: () => Sign.isAvailableAsync(),
  async signIn(nonce) {
    try {
      const credential = await Sign.signInAsync({ requestedScopes: [Sign.AppleAuthenticationScope.FULL_NAME, Sign.AppleAuthenticationScope.EMAIL], nonce });
      if (!credential.identityToken) throw new Error('Apple gave no token');
      const claims = readIdToken(credential.identityToken, APPLE.issuer);
      return { token: credential.identityToken, subject: claims?.subject ?? credential.user, email: (credential.email ?? claims?.email ?? null)?.toLowerCase() ?? null, name: nameOf(credential.fullName) };
    } catch (error) {
      // Closed by the person: nothing happened, and nothing is said.
      if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
      throw error;
    }
  },
};
