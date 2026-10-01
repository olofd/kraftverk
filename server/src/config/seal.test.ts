import { describe, expect, test } from 'bun:test';

import { isSealed, openWith, sealWith } from './seal.ts';

/* A secret sealed with a passphrase: opened by it, by nothing else, and not once changed. */

describe('a secret sealed with a passphrase', () => {
  const passphrase = 'correct horse battery staple';

  test('opens with its passphrase, and is sealed differently each time', () => {
    const one = sealWith(passphrase, 'local-key-of-a-test');
    const two = sealWith(passphrase, 'local-key-of-a-test');
    expect(isSealed(one)).toBe(true);
    expect(one).not.toBe(two);
    expect(openWith(passphrase, one)).toBe('local-key-of-a-test');
  });

  test('does not open with another passphrase, nor once changed', () => {
    const sealed = sealWith(passphrase, 'local-key-of-a-test');
    expect(() => openWith('another passphrase entirely', sealed)).toThrow('The passphrase does not open it');
    const changed = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => openWith(passphrase, changed)).toThrow('The passphrase does not open it');
    expect(() => openWith(passphrase, 'not sealed at all')).toThrow('That is not a sealed secret');
  });

  test('a passphrase too short to travel is refused', () => {
    expect(() => sealWith('short', 'x')).toThrow('at least 12 characters');
  });
});
