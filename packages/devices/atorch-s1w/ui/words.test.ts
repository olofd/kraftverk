import { describe, expect, test } from 'bun:test';

import type { Value } from '@kraftverk/device-sdk';

import { clock, cutOf, loadWarning, safetySummary, voltageWarning, watts } from './words.ts';

const reading = (values: Record<string, Value>) => (key: string): Value => values[key] ?? null;

describe('what the plug did, in words', () => {
  test('nothing to say while it has not cut itself off', () => {
    expect(cutOf(reading({ cutBy: 'none' }))).toBeNull();
    expect(cutOf(reading({}))).toBeNull();
  });

  test('a safety cut names the limit, the wait, and when it comes back', () => {
    const cut = cutOf(reading({ cutBy: 'underVoltage', minVoltage: 239.9, backOnAfter: 2, backOnIn: 105 }))!;
    expect(cut.title).toBe('Switched itself off to stay safe');
    expect(cut.body).toBe('The mains voltage fell below 239.9 V. It switches itself back on 2 minutes after the fault has cleared.');
    expect(cut.backIn).toBe(105);
    expect(cut.byRule).toBe(false);
  });

  test('a rule set in the maker’s app is called that, never by its name there', () => {
    const cut = cutOf(reading({ cutBy: 'lowPower', lowPowerWatts: 76, lowPowerMinutes: 1 }))!;
    expect(cut.body).toContain('turns it off when the draw stays under 76 W for a minute');
    expect(cut.body).not.toMatch(/Smart|outage|\(A\)/);
    expect(cut.byRule).toBe(true);
  });

  test('the safety cut-off in one line', () => {
    expect(safetySummary(reading({ safetyCutOff: true, minVoltage: 140.5, maxVoltage: 257.7, maxCurrent: 16.01, maxPower: 4499 }))).toBe(
      'Cuts the power outside 140.5–257.7 V, above 16.01 A or above 4.5 kW.'
    );
    expect(safetySummary(reading({ safetyCutOff: false }))).toContain('nothing protects');
  });
});

describe('limits checked against what is measured now', () => {
  test('a voltage window the mains is already outside is said before it is written', () => {
    expect(voltageWarning(239.9, 265, 232)).toContain('would switch it off at once');
    expect(voltageWarning(140, 225, 232)).toContain('would switch it off at once');
    expect(voltageWarning(225, 265, 232)).toContain('an ordinary dip');
    expect(voltageWarning(140, 265, 232)).toBeNull();
    expect(voltageWarning(140, 265, null)).toBeNull();
  });

  test('a load limit under what is drawn now', () => {
    expect(loadWarning(500, 900, 'W')).toBe('It draws 900 W now: this would switch it off at once.');
    expect(loadWarning(1000, 900, 'W')).toContain('a surge');
    expect(loadWarning(4500, 900, 'W')).toBeNull();
    expect(loadWarning(10, 0, 'A')).toBeNull();
  });

  test('numbers as people say them', () => {
    expect(watts(4499)).toBe('4.5 kW');
    expect(watts(0.37)).toBe('0.4 W');
    expect(clock(105)).toBe('1:45');
  });
});
