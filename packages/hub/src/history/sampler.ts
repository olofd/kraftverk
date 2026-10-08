import type { SeriesPoint } from '@kraftverk/api-contract';
import { isCurrent, isPosition, keepsHistory, partOf, type AttributeSpec, type DeviceDescription, type Value } from '@kraftverk/device-sdk';

import type { AuditLog, EventStore, HistoryStore, NotificationStore, Sample, TrackStore } from '@kraftverk/store';

import type { DeviceViews } from '../devices/views.ts';
import { unref } from '../timers.ts';
import { daysBefore, HOURLY_DAYS, SAMPLE_DAYS, TIMELINE_DAYS } from './retention.ts';

/**
 * Writes one sample per device attribute, once a minute.
 *
 * Generic by construction: it records whatever a device's description says to
 * keep, so a plug added next year gets charts without a line of code here.
 * That is the same trade the narrow `sample` table makes — no schema knows
 * what a "watt" is, which is why no schema change is needed when something new
 * starts measuring one.
 *
 * Numbers and on/off go in `value` (on/off as 1/0, so one column charts every
 * quantity); an operating mode or any text goes in `text`. Nulls — a device
 * that has not reported — are skipped rather than written as zero: a gap in a
 * chart is honest, a zero is a lie about what was happening.
 *
 * A reading is sampled only while it is current for its attribute
 * (`AttributeSpec.currentFor`): a device that stops answering keeps its last
 * reading, and sampling that every minute drew a flat line through the outage
 * — as confident as the real data either side of it. How long is the
 * attribute's to say: a power reading two minutes, a forecast an hour.
 *
 * Where a device is is never a sample: it goes to its track, and only for a
 * device whose owner keeps where it has been (`DeviceView.trackDays`), at
 * the time it was located — never the minute it was sampled.
 */

/** Where a value is kept in a sample, or null when it is not a value to keep. */
export function sampleOf(value: Value | undefined): { value: number | null; text: string | null } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { value: value ? 1 : 0, text: null };
  if (typeof value === 'number') return Number.isFinite(value) ? { value, text: null } : null;
  if (typeof value === 'string') return { value: null, text: value };
  return null; // a list or an object: one sample is one value
}

/** Which of a device's attributes history keeps, by key. */
export const keptAttributes = (description: DeviceDescription): Map<string, AttributeSpec> =>
  new Map(description.attributes.filter((attribute) => keepsHistory(attribute)).map((attribute) => [attribute.key, attribute]));

const INTERVAL_MS = 60_000;

/** A timer for one of the sampler's jobs: what goes wrong is said, never thrown where nothing catches it; it keeps no process alive. */
const every = (ms: number, what: string, job: () => void): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    try {
      job();
    } catch (error) {
      console.error(`[history] ${what} failed:`, error);
    }
  }, ms);
  unref(timer);
  return timer;
};
/** How far back each roll-up looks: late readings from a node that was away land in hours already rolled up. */
const ROLLUP_WINDOW_MS = 48 * 3_600_000;
/** How long what a person was told is kept. */
const NOTIFICATION_DAYS = 90;
/** Spans longer than this are drawn from the hourly roll-ups. */
const HOURLY_ABOVE_HOURS = 48;

export class Sampler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pruneTimer: ReturnType<typeof setInterval> | null = null;
  #rollupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly kept: { history: HistoryStore; audit: AuditLog; events: EventStore; tracks: TrackStore; notifications?: NotificationStore },
    private readonly views: DeviceViews,
    private readonly positionHidden: (deviceId: string) => boolean = () => false
  ) {}

  start(): void {
    this.#timer ??= every(INTERVAL_MS, 'sampling', () => this.sample());
    this.#pruneTimer ??= every(60 * 60_000, 'pruning', () => this.prune());
    this.#rollupTimer ??= every(10 * 60_000, 'rolling up', () => this.rollUp());
    this.sample();
    this.rollUp();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    if (this.#rollupTimer) clearInterval(this.#rollupTimer);
    this.#timer = null;
    this.#pruneTimer = null;
    this.#rollupTimer = null;
  }

  /** One sample of every kept attribute that is current now, of every device; one deleted since it was read is skipped. */
  sample(now = Date.now()): void {
    const at = new Date(now).toISOString();
    const samples: Sample[] = [];
    for (const device of this.views.all()) {
      // Where a carried device has been, only as far as its carrier shares: their view of it says so.
      if (device.trackDays && !this.positionHidden(device.id)) {
        const position = device.readings.find((reading) => isPosition(reading.value));
        if (position?.at && isPosition(position.value)) {
          const { latitude, longitude, accuracy } = position.value;
          this.kept.tracks.add(device.id, { at: position.at, latitude, longitude, accuracy: accuracy ?? null });
        }
      }
      const kept = keptAttributes(device.description);
      for (const reading of device.readings) {
        const attribute = kept.get(reading.key);
        if (!attribute || !isCurrent(attribute, reading, now)) continue;
        const sample = sampleOf(reading.value);
        if (sample) samples.push({ deviceId: device.id, part: partOf(attribute), key: reading.key, at, ...sample });
      }
    }
    this.kept.history.addSamples(samples);
  }

  /** The last two days rolled up into hours again: late readings from a node that was away land in hours already rolled up. */
  rollUp(now = Date.now()): void {
    this.kept.history.rollUp(new Date(now - ROLLUP_WINDOW_MS).toISOString(), new Date(now).toISOString());
  }

  /** Minute samples go after two weeks — rolled up first — hourly ones and changes after two years, the timeline and device events after one; where a device has been, after its owner's days. */
  prune(now = Date.now()): void {
    this.kept.tracks.prune(now);
    this.kept.history.rollUp(daysBefore(now, SAMPLE_DAYS + 2), daysBefore(now, SAMPLE_DAYS - 1));
    this.kept.history.prune({ samples: daysBefore(now, SAMPLE_DAYS), hours: daysBefore(now, HOURLY_DAYS), changes: daysBefore(now, HOURLY_DAYS) });
    this.kept.audit.prune(daysBefore(now, TIMELINE_DAYS));
    // What a device said happened is kept as long as what was done to it.
    this.kept.events.prune(daysBefore(now, TIMELINE_DAYS));
    // What people were told, after 90 days.
    this.kept.notifications?.prune(daysBefore(now, NOTIFICATION_DAYS));
  }
}

/** Minute samples for a short span; hourly roll-ups for a long one, and for anything older than the minutes kept. */
export function resolutionOf(fromIso: string, toIso: string): 'minute' | 'hour' {
  const span = (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
  return span > HOURLY_ABOVE_HOURS || Date.parse(fromIso) < Date.parse(daysBefore(Date.now(), SAMPLE_DAYS)) ? 'hour' : 'minute';
}

/**
 * One measurement over a window, thinned to at most `points`: a fortnight
 * of minute samples is 20 000 points for a chart 300 pixels wide, and
 * sending them all would make a phone do arithmetic it cannot show.
 */
export function series(history: HistoryStore, deviceId: string, key: string, fromIso: string, toIso: string, points = 240, resolution = resolutionOf(fromIso, toIso)): SeriesPoint[] {
  const rows = history.series(deviceId, key, fromIso, toIso, resolution);
  if (rows.length <= points) return rows;
  const stride = rows.length / points;
  const thinned: SeriesPoint[] = [];
  for (let index = 0; index < points; index++) {
    const slice = rows.slice(Math.floor(index * stride), Math.floor((index + 1) * stride));
    if (slice.length === 0) continue;
    // The mean, not a sample: a spike that vanishes when you zoom out is worse
    // than one that shows as a smaller bump.
    const mean = slice.reduce((sum, row) => sum + row.value, 0) / slice.length;
    thinned.push({ at: slice[Math.floor(slice.length / 2)]!.at, value: mean });
  }
  return thinned;
}
