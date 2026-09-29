import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb } from './db.ts';
import { transportStore } from './transport-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-transport-store-'));

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test('a transport keeps its own, and cannot reach another’s', () => {
  const ble = transportStore('ble');
  const matter = transportStore('matter');
  ble.set('bond', 'one');
  matter.set('bond', 'two');
  ble.set('bond', 'three');
  expect(ble.get('bond')).toBe('three');
  expect(matter.get('bond')).toBe('two');
  // Kept between runs: a new handle reads what the last one wrote.
  expect(transportStore('ble').get('bond')).toBe('three');
  ble.delete('bond');
  expect(ble.get('bond')).toBeNull();
  expect(matter.get('bond')).toBe('two');
});
