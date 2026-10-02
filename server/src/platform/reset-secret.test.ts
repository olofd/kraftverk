import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RESET_SECRET_MIN, resetSecret, secretMatches } from './reset-secret.ts';

describe('the reset passphrase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-reset-'));
  const file = join(dir, 'reset-secret');
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('no file, or a short one, means erasing is switched off', async () => {
    expect(await resetSecret(file)).toBeNull();
    writeFileSync(file, 'x'.repeat(RESET_SECRET_MIN - 1));
    expect(await resetSecret(file)).toBeNull();
    writeFileSync(file, '   \n');
    expect(await resetSecret(file)).toBeNull();
  });

  test('a long enough passphrase is read, without the whitespace around it', async () => {
    writeFileSync(file, '  correct horse battery staple\n');
    expect(await resetSecret(file)).toBe('correct horse battery staple');
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
