import { describe, expect, test } from 'bun:test';

import { newId, ULID, ulid } from './ids.ts';
import { isNodeId, newNodeId } from './node.ts';

/*
  An id is a prefix and a ULID (docs/PLAN-WORLD-MODEL.md §6): made anywhere
  with no one to ask, wide enough that two never meet, and sorting as they
  were made.
*/

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The time inside one, read back: only a test asks it, since nothing else may read an id's inside. */
const timeOf = (id: string) => [...id.slice(0, 10)].reduce((sum, char) => sum * 32 + BASE32.indexOf(char), 0);

describe('an id', () => {
  test('is its prefix and 26 characters of Crockford base 32', () => {
    expect(newId('d')).toMatch(new RegExp(`^d-${ULID}$`));
    expect(ulid()).toHaveLength(26);
    // No letter that is misread: I, L, O, U.
    expect(ulid()).not.toMatch(/[ILOU]/);
  });

  test('carries the time it was made, to the millisecond, and so sorts as made', () => {
    const at = Date.UTC(2026, 9, 8, 11, 10, 41, 123);
    expect(timeOf(ulid(at))).toBe(at);
    const earlier = newId('d', at);
    const later = newId('d', at + 1);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  test('never meets another', () => {
    const made = new Set<string>();
    for (let index = 0; index < 100_000; index++) made.add(ulid(0));
    expect(made.size).toBe(100_000);
  });

  test('a node knows its own: one made now is one, the old hex form is not', () => {
    expect(isNodeId(newNodeId())).toBe(true);
    expect(isNodeId('n-1b6f399a3ff1c2d0')).toBe(false);
  });
});
