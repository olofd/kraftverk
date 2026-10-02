import { describe, expect, test } from 'bun:test';

import { automationChangeOf, isRunEntry, summaryOn } from './timeline.ts';

describe('an automation’s timeline', () => {
  test('a run is told from a change by the run it notes, not by its words', () => {
    expect(isRunEntry({ kind: 'automation.acted', detail: { run: 'r-1', why: 'At 07:00' } })).toBe(true);
    // A run whose record is gone still noted which it was.
    expect(isRunEntry({ kind: 'automation.failed', detail: { run: null } })).toBe(true);
    expect(isRunEntry({ kind: 'automation.changed', detail: { before: {}, after: {} } })).toBe(false);
    expect(isRunEntry({ kind: 'device.renamed', detail: { run: 'r-1' } })).toBe(false);
  });

  test('a change says what it changed: each setting from and to, and whether what it does or uses changed', () => {
    const rule = { when: [], then: [] };
    expect(
      automationChangeOf({
        detail: { before: { mode: 'watch', recheckMinutes: null, rule, roles: { a: 1 }, homePlace: null }, after: { mode: 'act', recheckMinutes: 5, rule: { ...rule, when: [{}] }, roles: { a: 1 }, homePlace: 2 } },
      })
    ).toEqual({ mode: { from: 'watch', to: 'act' }, recheckMinutes: { from: null, to: 5 }, rule: true, uses: false, homePlace: 'put' });
    expect(automationChangeOf({ detail: { before: { homePlace: 1, starts: {} }, after: { homePlace: null, starts: { b: 'x' } } } })).toEqual({ rule: false, uses: true, homePlace: 'taken' });
    expect(automationChangeOf({ detail: null })).toBeNull();
  });

  test('on its own page, an entry does not name the automation again', () => {
    expect(summaryOn('Charge window: turned the plug on', 'Charge window')).toBe('turned the plug on');
    expect(summaryOn('Changed "Charge window"', 'Charge window')).toBe('Changed');
    expect(summaryOn('Let it act: "Charge window"', 'Charge window')).toBe('Let it act');
    expect(summaryOn('Something else', 'Charge window')).toBe('Something else');
  });
});
