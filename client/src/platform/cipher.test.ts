import { expect, test } from 'bun:test';

import { appSealing, sealedWithKey } from './cipher';

/** Sealed by a server's own cipher (server/src/platform/sealing.ts), kept: an export from a server opens in the app. */
const FROM_A_SERVER = 'sealed:v1:rtQd3iN7fcdS9-hxAI9e7g:-v9yfHTCmnVRbIEp:2Hw0uuNgIzV9DkHP0tzz1Ed3CGGUMgZ88tK3sq4s2k6QUb8';
const PASSPHRASE = 'correct horse battery staple';

test("a server's sealed export opens with its passphrase, and with no other", async () => {
  expect(await appSealing.open(PASSPHRASE, FROM_A_SERVER)).toBe('a made-up local key');
  expect(appSealing.open('another passphrase entirely', FROM_A_SERVER)).rejects.toThrow('does not open it');
});

test('what the app seals is the same format, and opens again', async () => {
  const sealed = await appSealing.seal(PASSPHRASE, 'another made-up key');
  expect(sealed).toMatch(/^sealed:v1:[\w-]+:[\w-]+:[\w-]+$/);
  expect(await appSealing.open(PASSPHRASE, sealed)).toBe('another made-up key');
  expect(appSealing.seal('too short', 'x')).rejects.toThrow('at least 12');
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
