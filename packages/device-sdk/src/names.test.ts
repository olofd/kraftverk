import { describe, expect, test } from 'bun:test';

import { KEY, keyFrom } from './names.ts';

/* The key a device or an automation is known by, made from the name it was given. */

describe('a key from a name', () => {
  test('lowercase, letters folded, dashes between words — and a number after it when taken', () => {
    expect(keyFrom('Garage Station 2', () => false)).toBe('garage-station-2');
    expect(keyFrom('Laddare för skotern', () => false)).toBe('laddare-for-skotern');
    expect(keyFrom('  --Smart   plug!! ', () => false)).toBe('smart-plug');
    const taken = new Set(['smart-plug', 'smart-plug-2']);
    expect(keyFrom('Smart plug', (key) => taken.has(key))).toBe('smart-plug-3');
    expect(keyFrom('ÅÄÖ', () => false)).toBe('aao');
    expect(keyFrom('⚡', () => false, 'device')).toBe('device');
    for (const key of ['garage-station-2', 'laddare-for-skotern', keyFrom('x'.repeat(200), () => false)]) expect(KEY.test(key)).toBe(true);
  });
});
