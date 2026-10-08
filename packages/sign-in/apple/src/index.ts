import type { IdentityProvider } from '@kraftverk/identity';

/**
 * Sign in with Apple, as a node checks it (docs/PLAN-WORLD-MODEL.md §10.6):
 * who issues its tokens, and where its signing keys are published. What
 * asks for a token is `./client`, which the app alone imports.
 */
export const APPLE: IdentityProvider = {
  id: 'apple',
  name: 'Apple',
  issuer: 'https://appleid.apple.com',
  keysUrl: 'https://appleid.apple.com/auth/keys',
};
