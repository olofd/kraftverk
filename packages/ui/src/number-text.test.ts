import { describe, expect, test } from 'bun:test';

import { parseNumberText } from './number-text.ts';

describe('a number as it is typed', () => {
  test('is a number once it is one, with a point or a comma; on its way, what it is so far', () => {
    expect(['12', '12.', '12.5', '1,5', '-0', '-0.5', ' 7 '].map(parseNumberText)).toEqual([12, 12, 12.5, 1.5, -0, -0.5, 7]);
  });

  test('none yet, or not a number, is none', () => {
    expect(['', '  ', '-', 'abc', '1.2.3'].map(parseNumberText)).toEqual([null, null, null, null, null]);
  });
});
