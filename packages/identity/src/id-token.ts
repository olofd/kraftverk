import { fromBase64url, utf8 } from './bytes.ts';
import { subtle } from './web-crypto.ts';

/*
  Signing in with a provider (docs/PLAN-WORLD-MODEL.md §10.6): its ID token
  is a JWT it signs — OpenID Connect — naming the person by a subject that
  is the same for this app every time. Which providers there are is their
  packages' to declare (packages/sign-in/*); this knows none of them. A
  phone gets a token from its own system, straight from the provider. A
  node that is handed one checks the provider's signature with its
  published keys, that it is for this app, that it is recent, and that it
  carries the nonce the node asked for — so a token seen once cannot be
  used again.
*/

/** A provider a person may sign in with, as its package declares it. */
export type IdentityProvider = {
  /** Its id, as a person's linked identity names it: lowercase. */
  id: string;
  /** What a person calls it. */
  name: string;
  /** Its tokens' `iss`. */
  issuer: string;
  /** Where its signing keys are published: a JWK set. */
  keysUrl: string;
};

/** What a person's sign-in with a provider gives the app: the provider's token, and what it says of them. */
export type ProviderAnswer = {
  token: string;
  /** Who they are there, for this app: the same every time. */
  subject: string;
  email: string | null;
  /** Their name, when the provider gives it — some only the first time. */
  name: string | null;
};

/** A provider as its package offers it to the app: whether this place can sign in with it, and asking. */
export type ProviderSignIn = {
  provider: IdentityProvider;
  /** Its button's words: "Continue with …". */
  label: string;
  /** Whether this place can: the platform's own sheet, or the provider's page where this app is registered with it. */
  available(): Promise<boolean>;
  /** Asks the person, with a nonce the token carries back; null when they cancelled. */
  signIn(nonce: string): Promise<ProviderAnswer | null>;
};

/** What a token says of the person. */
export type IdClaims = {
  subject: string;
  /** Their email, when they let it be given: lower case. */
  email: string | null;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  /** The nonce it was asked with, as the provider carries it. */
  nonce: string | null;
};

/** One of a provider's signing keys, as its key set publishes it. */
export type ProviderKey = { kty: 'RSA'; kid: string; alg?: string; n: string; e: string };

const json = (part: string | undefined): Record<string, unknown> | null => {
  const bytes = part ? fromBase64url(part) : null;
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** What a token from this issuer says, read but not checked: a phone's own system handed it over, from the provider. Null for anything that is not one. */
export function readIdToken(token: string, issuer: string): IdClaims | null {
  const claims = json(token.split('.')[1]);
  if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.iss !== issuer) return null;
  const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  if (typeof audience !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
  return {
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    audience,
    issuedAt: claims.iat * 1000,
    expiresAt: claims.exp * 1000,
    nonce: typeof claims.nonce === 'string' ? claims.nonce : null,
  };
}

/**
 * A token checked as a node checks one it is handed: from the issuer,
 * signed by one of its keys, for one of this app's ids, not expired, and
 * carrying the nonce asked for. The claims; or why not, in words. Needs
 * Web Crypto: a server and a browser have it.
 */
export async function verifyIdToken(token: string, expect: { issuer: string; keys: readonly ProviderKey[]; audiences: readonly string[]; now: number; nonce: string | null }): Promise<IdClaims | string> {
  const [headerPart, claimsPart, signaturePart] = token.split('.');
  const header = json(headerPart);
  const claims = readIdToken(token, expect.issuer);
  const signature = signaturePart ? fromBase64url(signaturePart) : null;
  if (!header || !claims || !signature || header.alg !== 'RS256') return 'That is not a sign-in token from there';
  const key = expect.keys.find((each) => each.kid === header.kid);
  if (!key) return 'It was not signed with a key its provider publishes';
  const publicKey = await subtle().importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await subtle().verify('RSASSA-PKCS1-v1_5', publicKey, signature as Uint8Array<ArrayBuffer>, utf8(`${headerPart}.${claimsPart}`) as Uint8Array<ArrayBuffer>))) return 'Its provider did not sign it';
  if (!expect.audiences.includes(claims.audience)) return 'That token is for another app';
  if (claims.expiresAt <= expect.now) return 'That token has expired: sign in again';
  if (expect.nonce !== null && claims.nonce !== expect.nonce) return 'That token was not asked for here';
  return claims;
}
