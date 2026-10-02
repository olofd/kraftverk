import { expect, test } from 'bun:test';

import { sealedWithKey } from '@kraftverk/store';

import { passphraseSealing } from '../src/index.ts';

/** Sealed by a server with its runtime's own cipher, before every place shared one, and kept: what it sealed opens everywhere. */
const FROM_A_SERVER = 'sealed:v1:rtQd3iN7fcdS9-hxAI9e7g:-v9yfHTCmnVRbIEp:2Hw0uuNgIzV9DkHP0tzz1Ed3CGGUMgZ88tK3sq4s2k6QUb8';
const PASSPHRASE = 'correct horse battery staple';

test("a server's sealed export opens with its passphrase, and with no other", async () => {
  expect(await passphraseSealing.open(PASSPHRASE, FROM_A_SERVER)).toBe('a made-up local key');
  expect(passphraseSealing.open('another passphrase entirely', FROM_A_SERVER)).rejects.toThrow('does not open it');
});

test('what is sealed now is the same format, and opens again', async () => {
  const sealed = await passphraseSealing.seal(PASSPHRASE, 'another made-up key');
  expect(sealed).toMatch(/^sealed:v1:[\w-]+:[\w-]+:[\w-]+$/);
  expect(await passphraseSealing.open(PASSPHRASE, sealed)).toBe('another made-up key');
  expect(passphraseSealing.seal('too short', 'x')).rejects.toThrow('at least 12');
});

test('secrets at rest: sealed with the key, opened with it, and with no other', () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const kept = sealedWithKey(key);
  const sealed = kept.seal('a made-up local key');
  expect(sealed.encrypted).toBe(true);
  expect(sealed.value).not.toContain('local key');
  expect(kept.open(sealed.value, true)).toBe('a made-up local key');
  expect(sealedWithKey(crypto.getRandomValues(new Uint8Array(32))).open(sealed.value, true)).toBeNull();
  expect(kept.open('kept as given', false)).toBe('kept as given');
});
