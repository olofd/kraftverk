import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerLog } from './log.ts';

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'kraftverk-log-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('ServerLog', () => {
  test('keeps each line in a file per day, with its time and level', () => {
    const dir = fresh();
    let now = new Date('2026-09-27T23:59:59Z');
    const log = new ServerLog(dir, { now: () => now });
    log.record('info', 'before midnight');
    now = new Date('2026-09-28T00:00:01Z');
    log.record('warn', 'after midnight');

    expect(readdirSync(dir).sort()).toEqual(['server-2026-09-27.log', 'server-2026-09-28.log']);
    expect(readFileSync(join(dir, 'server-2026-09-28.log'), 'utf8')).toBe('2026-09-28T00:00:01.000Z WARN  after midnight\n');
  });

  test('forgets files older than it keeps', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'server-2026-09-01.log'), 'old\n');
    writeFileSync(join(dir, 'server-2026-09-20.log'), 'recent\n');
    writeFileSync(join(dir, 'something-else.log'), 'not ours\n');
    new ServerLog(dir, { retainDays: 14, now: () => new Date('2026-09-27T12:00:00Z') });
    expect(readdirSync(dir).sort()).toEqual(['server-2026-09-20.log', 'something-else.log']);
  });

  test('serves the recent lines, filtered by level, from a bounded ring', () => {
    const log = new ServerLog(null, { ring: 3 });
    for (const [level, text] of [['info', 'a'], ['error', 'b'], ['debug', 'c'], ['warn', 'd']] as const) log.record(level, text);
    expect(log.recent().map((line) => line.text)).toEqual(['b', 'c', 'd']);
    expect(log.recent(10, 'warn').map((line) => line.text)).toEqual(['b', 'd']);
    expect(log.recent(1).map((line) => line.text)).toEqual(['d']);
  });

  test('keeps the text, not the terminal colours', () => {
    const log = new ServerLog(null);
    log.record('info', 'GET /api/devices \x1b[32m200\x1b[0m 3ms');
    expect(log.recent()[0]!.text).toBe('GET /api/devices 200 3ms');
  });

  test('a directory it cannot use leaves it working from memory', () => {
    const dir = fresh();
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, '');
    const log = new ServerLog(join(blocker, 'logs'));
    expect(log.dir).toBeNull();
    log.record('info', 'still here');
    expect(log.recent()).toHaveLength(1);
  });
});
