import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asideName } from './aside.ts';

/*
  A file kept aside is never written over by the next one kept aside within
  the same moment: a database set aside twice in one second lost the first.
*/

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-aside-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = new Date('2026-10-08T11:10:41.123Z');

describe('a name for a file kept aside', () => {
  test('is the time to the millisecond, and sorts as the files were made', () => {
    const dir = scratch();
    expect(asideName(join(dir, 'kraftverk.before-'), '.yaml', [], AT)).toBe(join(dir, 'kraftverk.before-2026-10-08T11-10-41.123Z.yaml'));
    const later = asideName(join(dir, 'x.'), '', [], new Date('2026-10-08T11:10:41.124Z'));
    expect([later, asideName(join(dir, 'x.'), '', [], AT)].sort()[1]).toBe(later);
  });

  test('is one no file has: taken, it is counted on', () => {
    const dir = scratch();
    const first = asideName(join(dir, 'kraftverk.db.set-aside.'), '', [], AT);
    writeFileSync(first, 'set aside');
    const second = asideName(join(dir, 'kraftverk.db.set-aside.'), '', [], AT);
    expect(second).toBe(`${first}-2`);
    writeFileSync(second, 'set aside too');
    expect(asideName(join(dir, 'kraftverk.db.set-aside.'), '', [], AT)).toBe(`${first}-3`);
  });

  test('and none of the files it stands for is taken either', () => {
    const dir = scratch();
    const first = asideName(join(dir, 'kraftverk.db.set-aside.'), '', ['-wal', '-shm'], AT);
    // Only its write-ahead log was left there: the name is still taken.
    writeFileSync(`${first}-wal`, 'log');
    expect(asideName(join(dir, 'kraftverk.db.set-aside.'), '', ['-wal', '-shm'], AT)).toBe(`${first}-2`);
  });
});
