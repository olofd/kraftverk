import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RESET_SECRET_MIN, resetSecret, secretMatches } from './reset.ts';

describe('the reset passphrase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-reset-'));
  const file = join(dir, 'reset-secret');
  let before: string | undefined;

  beforeAll(() => {
    before = process.env.KRAFTVERK_RESET_SECRET_FILE;
    process.env.KRAFTVERK_RESET_SECRET_FILE = file;
  });

  afterAll(() => {
    if (before === undefined) delete process.env.KRAFTVERK_RESET_SECRET_FILE;
    else process.env.KRAFTVERK_RESET_SECRET_FILE = before;
    rmSync(dir, { recursive: true, force: true });
  });

  test('no file, or a short one, means erasing is switched off', async () => {
    expect(await resetSecret()).toBeNull();
    writeFileSync(file, 'x'.repeat(RESET_SECRET_MIN - 1));
    expect(await resetSecret()).toBeNull();
    writeFileSync(file, '   \n');
    expect(await resetSecret()).toBeNull();
  });

  test('a long enough passphrase is read, without the whitespace around it', async () => {
    writeFileSync(file, '  correct horse battery staple\n');
    expect(await resetSecret()).toBe('correct horse battery staple');
  });

  test('matches exactly, whatever the lengths', () => {
    const secret = 'correct horse battery staple';
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(`${secret} `, secret)).toBe(false);
    expect(secretMatches('correct', secret)).toBe(false);
    expect(secretMatches('', secret)).toBe(false);
    expect(secretMatches('x'.repeat(10_000), secret)).toBe(false);
  });
});
