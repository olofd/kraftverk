import { describe, expect, test } from 'bun:test';

import {
  addKey,
  answer,
  areRecoveryWords,
  base64url,
  canonical,
  checkChain,
  checkSignIn,
  createPerson,
  holds,
  keyId,
  newChallenge,
  newRecoveryWords,
  newSecret,
  newWebCryptoPair,
  readIdToken,
  recoveryKey,
  recoveryWordsOf,
  say,
  softwareKey,
  utf8Of,
  verify,
  verifyIdToken,
  webCryptoKey,
  type Profile,
  type Statement,
} from './exports.ts';

/*
  A person's identity: a chain that checks, and every way one is refused —
  a forged statement, a revoked key's later signature, a chain reordered;
  the keys of every platform agreeing; recovery words; a node's challenge;
  and a sign-in provider's token.
*/

const ID = 'p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB';
const ANNA: Profile = { name: 'Anna Example', shortName: 'Anna', locale: null, pictureId: null };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 8, 12) + minutes * 60_000).toISOString();

async function anna() {
  const phone = await webCryptoKey(await newWebCryptoPair());
  const words = newRecoveryWords();
  const recovery = recoveryKey(words);
  let chain = await createPerson({ id: ID, key: phone, deviceName: 'Anna’s phone', profile: ANNA, at: at(0) });
  chain = await addKey(chain, { signer: phone, key: recovery, keyKind: 'recovery', deviceName: null, at: at(0) });
  return { phone, recovery, words, chain };
}

describe('a person’s chain', () => {
  test('checks: made by their first key, their recovery key and a second device signed in, their profile changed', async () => {
    const { phone, recovery, chain: start } = await anna();
    const laptop = softwareKey(newSecret());
    let chain = await addKey(start, { signer: phone, key: laptop, keyKind: 'device', deviceName: 'Laptop', at: at(1) });
    chain = await say(chain, { signer: laptop, at: at(2), said: { kind: 'profile', profile: { ...ANNA, shortName: 'Mum' } } });
    chain = await say(chain, { signer: phone, at: at(3), said: { kind: 'linked', linked: { provider: 'example-id', subject: '001234.abc', email: null } } });
    const checked = checkChain(chain);
    if (!checked.ok) throw new Error(checked.problem);
    expect(checked.person.id).toBe(ID);
    expect(checked.person.profile.shortName).toBe('Mum');
    expect(checked.person.keys.map((key) => [key.kind, key.deviceName])).toEqual([
      ['device', 'Anna’s phone'],
      ['recovery', null],
      ['device', 'Laptop'],
    ]);
    expect(checked.person.keys[2]!.addedWith).toBe(keyId(phone.publicJwk));
    expect(holds(checked.person, keyId(recovery.publicJwk))?.kind).toBe('recovery');
    expect(checked.person.linked).toEqual([{ provider: 'example-id', subject: '001234.abc', email: null }]);
    // The same chain, read back from JSON: the same person.
    expect(checkChain(JSON.parse(JSON.stringify(chain)) as Statement[])).toEqual(checked);
  });

  test('a forged statement is refused: a changed word, a signature that is not the signer’s, a key that is not theirs', async () => {
    const { phone, chain } = await anna();
    const renamed = await say(chain, { signer: phone, at: at(1), said: { kind: 'profile', profile: { ...ANNA, name: 'Anna' } } });
    const tampered = renamed.map((each, index) => (index === 2 ? { ...each, said: { kind: 'profile', profile: { ...ANNA, name: 'Mallory' } } } : each)) as Statement[];
    expect(checkChain(tampered)).toMatchObject({ ok: false, problem: 'A signature that is not the signer’s', at: 2 });

    const stranger = softwareKey(newSecret());
    const strangers = await say(chain, { signer: stranger, at: at(1), said: { kind: 'profile', profile: { ...ANNA, name: 'Mallory' } } });
    expect(checkChain(strangers)).toMatchObject({ ok: false, problem: 'Signed by a key that is not the person’s', at: 2 });

    // Someone else's first statement, with Anna's id: signed by a key it does not name.
    const [first] = await createPerson({ id: ID, key: stranger, deviceName: null, profile: ANNA, at: at(0) });
    expect(checkChain([{ ...first!, said: { ...first!.said, key: phone.publicJwk } as Statement['said'] }])).toMatchObject({ ok: false, at: 0 });

    // A key added without its own proof.
    const laptop = softwareKey(newSecret());
    const added = await addKey(chain, { signer: phone, key: laptop, keyKind: 'device', deviceName: 'Laptop', at: at(1) });
    const unproven = added.map((each, index) => (index === 2 ? { ...each, said: { ...each.said, proof: base64url(new Uint8Array(64)) } } : each)) as Statement[];
    expect(checkChain(unproven)).toMatchObject({ ok: false, at: 2 });
  });

  test('a revoked key signs nothing after; a person keeps at least one key', async () => {
    const { phone, recovery, chain } = await anna();
    const revoked = await say(chain, { signer: recovery, at: at(1), said: { kind: 'key-revoked', keyId: keyId(phone.publicJwk) } });
    expect(checkChain(revoked).ok).toBe(true);
    const after = await say(revoked, { signer: phone, at: at(2), said: { kind: 'profile', profile: ANNA } });
    expect(checkChain(after)).toMatchObject({ ok: false, problem: 'Signed by a key revoked before it', at: 3 });
    const last = await say(revoked, { signer: recovery, at: at(2), said: { kind: 'key-revoked', keyId: keyId(recovery.publicJwk) } });
    expect(checkChain(last)).toMatchObject({ ok: false, problem: 'A person keeps at least one key' });
  });

  test('a reordered, shortened at the front, or back-dated chain is refused', async () => {
    const { phone, chain: start } = await anna();
    const chain = await say(start, { signer: phone, at: at(5), said: { kind: 'profile', profile: ANNA } });
    expect(checkChain([chain[0]!, chain[2]!, chain[1]!])).toMatchObject({ ok: false, at: 1 });
    expect(checkChain(chain.slice(1))).toMatchObject({ ok: false, at: 0 });
    const backDated = await say(chain, { signer: phone, at: at(1), said: { kind: 'profile', profile: ANNA } });
    expect(checkChain(backDated)).toMatchObject({ ok: false, problem: 'A statement dated before the one it follows', at: 3 });
  });
});

describe('keys', () => {
  test('a browser’s key and a phone’s agree: each verifies the other’s way, however s falls', async () => {
    const browser = await webCryptoKey(await newWebCryptoPair());
    const phone = softwareKey(newSecret());
    for (let round = 0; round < 20; round++) {
      const data = utf8Of(`statement ${round}`);
      expect(verify(browser.publicJwk, data, await browser.sign(data))).toBe(true);
      const signature = await phone.sign(data);
      expect(verify(phone.publicJwk, data, signature)).toBe(true);
      const key = await crypto.subtle.importKey('jwk', phone.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>)).toBe(true);
    }
    expect(verify(phone.publicJwk, utf8Of('one'), await phone.sign(utf8Of('another')))).toBe(false);
  });

  test('a key’s id is its RFC 7638 thumbprint', () => {
    // RFC 7638 §3.1's example is RSA; an EC key's members are crv, kty, x, y, in that order.
    const jwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' } as const;
    expect(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).toBe('{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}');
    expect(keyId(jwk)).toMatch(/^k-[A-Za-z0-9_-]{43}$/);
  });
});

describe('recovery words', () => {
  test('twelve words make the same key every time; one mistyped is caught', () => {
    const words = recoveryWordsOf(new Uint8Array(16).fill(7));
    expect(words).toHaveLength(12);
    expect(recoveryKey(words).publicJwk).toEqual(recoveryKey(` ${words.join('  ').toUpperCase()} `).publicJwk);
    const wrong = [...words.slice(0, 11), words[11] === 'zoo' ? 'zone' : 'zoo'];
    expect(areRecoveryWords(wrong)).toBe(false);
    expect(() => recoveryKey(wrong)).toThrow('check each one');
    expect(recoveryKey(newRecoveryWords()).publicJwk).not.toEqual(recoveryKey(words).publicJwk);
  });
});

describe('signing in at a node', () => {
  test('by a key the person holds, to the challenge given, while it is young', async () => {
    const { phone, chain } = await anna();
    const checked = checkChain(chain);
    if (!checked.ok) throw new Error(checked.problem);
    const challenge = newChallenge('n-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB', at(10));
    const signIn = await answer(challenge, ID, phone);
    const now = Date.parse(at(10)) + 30_000;
    const key = holds(checked.person, signIn.keyId)?.publicJwk ?? null;
    expect(checkSignIn(signIn, { node: challenge.node, nonce: challenge.nonce, now, maxAgeMs: 120_000, key })).toBeNull();
    expect(checkSignIn(signIn, { node: 'n-elsewhere', nonce: challenge.nonce, now, maxAgeMs: 120_000, key })).toBe('That is not the challenge this node gave');
    expect(checkSignIn(signIn, { node: challenge.node, nonce: challenge.nonce, now: now + 600_000, maxAgeMs: 120_000, key })).toBe('That challenge is too old: ask for another');
    expect(checkSignIn({ ...signIn, person: 'p-01JA8ZM0D2E4F6G8H0J2K4M6N8' }, { node: challenge.node, nonce: challenge.nonce, now, maxAgeMs: 120_000, key })).toBe('That signature is not the key’s');
    expect(checkSignIn(signIn, { node: challenge.node, nonce: challenge.nonce, now, maxAgeMs: 120_000, key: null })).toBe('That key is not one this person holds');
  });
});

describe('a sign-in provider’s token', () => {
  test('checked: its signature, this app, not expired, the nonce asked for', async () => {
    // A provider's key: a token signed with it, and its public half as a key set gives one.
    const provider = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const published = (await crypto.subtle.exportKey('jwk', provider.publicKey)) as { n: string; e: string };
    const keys = [{ kty: 'RSA' as const, kid: 'key-1', alg: 'RS256', n: published.n, e: published.e }];
    const issuer = 'https://id.example.com';
    const now = Date.parse(at(0));
    const token = async (claims: Record<string, unknown>) => {
      const part = (value: unknown) => base64url(utf8Of(JSON.stringify(value)));
      const head = `${part({ alg: 'RS256', kid: 'key-1' })}.${part({ iss: issuer, aud: 'app.kraftverk', sub: '001234.abc', email: 'Anna@Example.com', iat: now / 1000, exp: now / 1000 + 600, nonce: 'n1', ...claims })}`;
      return `${head}.${base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', provider.privateKey, utf8Of(head) as Uint8Array<ArrayBuffer>)))}`;
    };
    const expect_ = { issuer, keys, audiences: ['app.kraftverk'], now, nonce: 'n1' };
    expect(await verifyIdToken(await token({}), expect_)).toEqual({ subject: '001234.abc', email: 'anna@example.com', audience: 'app.kraftverk', issuedAt: now, expiresAt: now + 600_000, nonce: 'n1' });
    expect(readIdToken(await token({}), issuer)?.subject).toBe('001234.abc');
    expect(readIdToken(await token({}), 'https://elsewhere.example.com')).toBeNull();
    expect(await verifyIdToken(await token({ aud: 'app.elsewhere' }), expect_)).toBe('That token is for another app');
    expect(await verifyIdToken(await token({ exp: now / 1000 - 1 }), expect_)).toBe('That token has expired: sign in again');
    expect(await verifyIdToken(await token({ nonce: 'n2' }), expect_)).toBe('That token was not asked for here');
    const forged = (await token({})).replace(/\.[^.]+\./, `.${base64url(utf8Of(JSON.stringify({ iss: issuer, aud: 'app.kraftverk', sub: 'someone-else', iat: now / 1000, exp: now / 1000 + 600, nonce: 'n1' })))}.`);
    expect(await verifyIdToken(forged, expect_)).toBe('Its provider did not sign it');
  });
});
