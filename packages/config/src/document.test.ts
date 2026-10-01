import { describe, expect, test } from 'bun:test';

import { KEY, keyFrom } from './document.ts';

/* The key a file knows something by, made from the name it was given. */

describe('a key from a name', () => {
  test('lowercase, letters folded, dashes between words — and a number after it when taken', () => {
    expect(keyFrom('Garage P280', () => false)).toBe('garage-p280');
    expect(keyFrom('Laddare för skotern', () => false)).toBe('laddare-for-skotern');
    expect(keyFrom('  --Smart   plug!! ', () => false)).toBe('smart-plug');
    const taken = new Set(['smart-plug', 'smart-plug-2']);
    expect(keyFrom('Smart plug', (key) => taken.has(key))).toBe('smart-plug-3');
    expect(keyFrom('ÅÄÖ', () => false)).toBe('aao');
    expect(keyFrom('⚡', () => false, 'device')).toBe('device');
    for (const key of ['garage-p280', 'laddare-for-skotern', keyFrom('x'.repeat(200), () => false)]) expect(KEY.test(key)).toBe(true);
  });
});
