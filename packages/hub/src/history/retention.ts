/*
  How long a home keeps what it records, and the clock it trusts: one place
  for every number the sampler, the change log, a follower's readings, a
  rehearsal and a chart's span are held to.
*/

const DAY_MS = 86_400_000;

/** Minute samples: two weeks is a few hundred thousand rows — plenty, and small. */
export const SAMPLE_DAYS = 14;
/** Hourly roll-ups and every change of an on/off: two years, for charts that reach back and for calibrating forecasts. */
export const HOURLY_DAYS = 730;
/** The timeline, and what a device said happened: a year of who did what. */
export const TIMELINE_DAYS = 365;

/** A time this far ahead of now is a clock that is wrong, not a reading or a change. */
export const SKEW_MS = 60_000;

/** The time `days` before `now`, as kept. */
export const daysBefore = (now: number, days: number): string => new Date(now - days * DAY_MS).toISOString();

/** The widest span a chart may ask for: what the roll-ups keep. */
export const MAX_SPAN_MS = HOURLY_DAYS * DAY_MS;
/** The oldest a queued reading may be and still become history: what minute samples keep. */
export const MAX_QUEUED_MS = SAMPLE_DAYS * DAY_MS;
