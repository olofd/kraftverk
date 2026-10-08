import { base64url, canonical, fromBase64url, utf8 } from './bytes.ts';
import { keyId, verify, type PublicJwk, type SigningKey } from './keys.ts';

/*
  Signing in at a node by a key (docs/PLAN-WORLD-MODEL.md §10.5): the node
  hands out a challenge — itself, a nonce, when — and the person's device
  signs it. The node checks the key is one the person holds, the nonce one
  it gave and has not taken back, and the time recent. No secret crosses.
*/

export type Challenge = { node: string; nonce: string; issuedAt: string };

/** A challenge answered: who, with which key, and their signature over it. */
export type SignIn = { person: string; keyId: string; challenge: Challenge; signature: string };

const bytesOf = (person: string, challenge: Challenge) => utf8(canonical({ kind: 'sign-in', person, challenge }));

/** A new challenge for a node to hand out: 32 random bytes. */
export const newChallenge = (node: string, issuedAt: string): Challenge => ({ node, nonce: base64url(crypto.getRandomValues(new Uint8Array(32))), issuedAt });

export async function answer(challenge: Challenge, person: string, key: SigningKey): Promise<SignIn> {
  return { person, keyId: keyId(key.publicJwk), challenge, signature: base64url(await key.sign(bytesOf(person, challenge))) };
}

/**
 * Whether an answer signs a person in: to this node, the challenge one it
 * gave, younger than `maxAgeMs`, signed by the key it names — which the
 * caller says is one the person holds now.
 */
export function checkSignIn(signIn: SignIn, expect: { node: string; nonce: string; now: number; maxAgeMs: number; key: PublicJwk | null }): string | null {
  if (signIn.challenge.node !== expect.node || signIn.challenge.nonce !== expect.nonce) return 'That is not the challenge this node gave';
  const issued = Date.parse(signIn.challenge.issuedAt);
  if (!(expect.now - issued <= expect.maxAgeMs && issued <= expect.now + 5_000)) return 'That challenge is too old: ask for another';
  if (!expect.key || keyId(expect.key) !== signIn.keyId) return 'That key is not one this person holds';
  const signature = fromBase64url(signIn.signature);
  return signature && verify(expect.key, bytesOf(signIn.person, signIn.challenge), signature) ? null : 'That signature is not the key’s';
}
