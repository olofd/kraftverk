import type { Value } from '@kraftverk/device-sdk';

/**
 * What the plug did, in sentences a person reads once and understands — never
 * the maker's terms ("Smart Power Off (A)", "outage_a", "LVP"). Pure, so every
 * sentence is tested.
 */

type Read = (key: string) => Value;

const num = (value: Value): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** 257.7 → "257.7", 140 → "140". */
export const trim = (value: number, digits = 1): string => String(Number(value.toFixed(digits)));

export const watts = (value: number): string => (value >= 1000 ? `${trim(value / 1000, 2)} kW` : `${trim(value, value < 10 ? 1 : 0)} W`);

/** 105 → "1:45"; minutes and seconds, for a countdown. */
export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 3 → "3 minutes", 1 → "a minute", 0 → "at once". */
export const minutes = (value: number): string => (value <= 0 ? 'at once' : value === 1 ? 'a minute' : `${trim(value, 0)} minutes`);

export type Cut = {
  title: string;
  /** Why, in one or two sentences. */
  body: string;
  /** Seconds until it switches itself back on, when it will. */
  backIn: number | null;
  /** The plug's own rule cut it: offer to hand the switching back to kraftverk. */
  byRule: boolean;
};

/** Why the plug switched itself off, or null while it has not. */
export function cutOf(read: Read): Cut | null {
  const by = read('cutBy');
  if (typeof by !== 'string' || by === 'none') return null;
  const backOnIn = num(read('backOnIn'));
  const after = num(read('backOnAfter'));
  const recovery =
    after === null
      ? 'It switches itself back on once the fault has cleared.'
      : `It switches itself back on ${after <= 0 ? 'as soon as' : `${minutes(after)} after`} the fault has cleared.`;
  const safety = (why: string): Cut => ({
    title: 'Switched itself off to stay safe',
    body: `${why} ${recovery}`,
    backIn: backOnIn !== null && backOnIn > 0 ? backOnIn : null,
    byRule: false,
  });
  const limit = (key: string, unit: string) => {
    const value = num(read(key));
    return value === null ? '' : ` ${trim(value)} ${unit}`;
  };

  switch (by) {
    case 'underVoltage':
      return safety(`The mains voltage fell below${limit('minVoltage', 'V')}.`);
    case 'overVoltage':
      return safety(`The mains voltage rose above${limit('maxVoltage', 'V')}.`);
    case 'overCurrent':
      return safety(`What is plugged in drew more than${limit('maxCurrent', 'A')}.`);
    case 'overPower': {
      const max = num(read('maxPower'));
      return safety(`What is plugged in drew more than ${max === null ? 'the limit' : watts(max)}.`);
    }
    case 'lowPower': {
      const under = num(read('lowPowerWatts'));
      const forMinutes = num(read('lowPowerMinutes'));
      const rule = under === null ? 'when the draw stays low' : `when the draw stays under ${watts(under)}${forMinutes === null ? '' : ` for ${minutes(forMinutes)}`}`;
      return {
        title: 'Switched off by a rule inside the plug',
        body: `A rule set in the maker’s app turns it off ${rule}. It stays off until it is switched on — and the rule will switch it off again.`,
        backIn: null,
        byRule: true,
      };
    }
    case 'highPower': {
      const over = num(read('highPowerWatts'));
      const forHours = num(read('highPowerHours'));
      const rule = over === null ? 'when the draw stays high' : `when the draw stays over ${watts(over)}${forHours === null ? '' : ` for ${trim(forHours, 0)} ${forHours === 1 ? 'hour' : 'hours'}`}`;
      return {
        title: 'Switched off by a rule inside the plug',
        body: `A rule set in the maker’s app turns it off ${rule}. It stays off until it is switched on — and the rule will switch it off again.`,
        backIn: null,
        byRule: true,
      };
    }
    default:
      return {
        title: 'Switched off by a timer inside the plug',
        body: 'A timer set in the maker’s app switched it. kraftverk’s automations can do the same, and say why when they do.',
        backIn: null,
        byRule: true,
      };
  }
}

/** The safety cut-off in one line: "Cuts outside 140–258 V, above 16 A or 4.5 kW". */
export function safetySummary(read: Read): string {
  if (read('safetyCutOff') === false) return 'The safety cut-off is off: nothing protects what is plugged in.';
  const low = num(read('minVoltage'));
  const high = num(read('maxVoltage'));
  const amps = num(read('maxCurrent'));
  const power = num(read('maxPower'));
  const parts = [
    low !== null && high !== null ? `outside ${trim(low)}–${trim(high)} V` : null,
    amps !== null ? `above ${trim(amps, 2)} A` : null,
    power !== null ? `above ${watts(power)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? `Cuts the power ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' or ' : ''}${parts.at(-1)}.` : 'Cuts the power when something is wrong.';
}

/**
 * What is wrong with a voltage window against the mains as it is now: a limit
 * the supply is already outside cuts the moment it is written.
 */
export function voltageWarning(low: number, high: number, mains: number | null): string | null {
  if (mains === null) return null;
  if (low >= mains) return `The mains is ${trim(mains)} V now: a limit of ${trim(low)} V would switch it off at once.`;
  if (high <= mains) return `The mains is ${trim(mains)} V now: a limit of ${trim(high)} V would switch it off at once.`;
  if (mains - low < 10 || high - mains < 10) return `Within 10 V of the mains (${trim(mains)} V now): an ordinary dip or rise would switch it off.`;
  return null;
}

/** A current or power limit against what is drawn now. */
export function loadWarning(limit: number, drawn: number | null, unit: 'A' | 'W'): string | null {
  if (drawn === null || drawn <= 0) return null;
  const now = unit === 'W' ? watts(drawn) : `${trim(drawn, 2)} A`;
  if (limit <= drawn) return `It draws ${now} now: this would switch it off at once.`;
  if (limit < drawn * 1.2) return `It draws ${now} now: close enough that a surge would switch it off.`;
  return null;
}
