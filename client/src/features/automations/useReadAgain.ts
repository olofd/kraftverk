import { useCallback, useEffect, useRef } from 'react';

import { useDevices } from '../../state/DevicesProvider';

/** How soon a run that moved is read: a burst of steps, read once. */
const RUN_MOVED_MS = 250;
/** How often, at most, what automations read now is read again as readings move — and how often it is polled while the stream is down. */
const READINGS_EVERY_MS = 15_000;

/**
 * Reads a screen's automations again when they may have changed, and only
 * then:
 * - a run moved on the live stream (started, a step, ended): soon, once for a
 *   burst;
 * - `followReadings`, and a device's readings moved: at most every 15 s, for
 *   what each automation reads now;
 * - the live stream is down, so nothing is heard: every 15 s.
 * Nothing is read while the stream is up and nothing moves. The first read is
 * the screen's own.
 */
export function useReadAgain(read: () => void, { followReadings }: { followReadings: boolean }): void {
  const { live, devices, onAutomation } = useDevices();
  const due = useRef<{ at: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const reading = useRef(read);
  reading.current = read;

  /** Reads within `ms`: sooner than a read already due replaces it, later waits for it. */
  const readWithin = useCallback((ms: number) => {
    const at = Date.now() + ms;
    if (due.current && due.current.at <= at) return;
    if (due.current) clearTimeout(due.current.timer);
    due.current = {
      at,
      timer: setTimeout(() => {
        due.current = null;
        reading.current();
      }, ms),
    };
  }, []);

  useEffect(
    () => () => {
      if (due.current) clearTimeout(due.current.timer);
      due.current = null;
    },
    []
  );

  useEffect(() => onAutomation(() => readWithin(RUN_MOVED_MS)), [onAutomation, readWithin]);

  // Readings arrive on the stream as the device list changes; the list changing is the signal.
  const following = live === 'live' && followReadings;
  const seen = useRef(devices);
  useEffect(() => {
    if (seen.current === devices) return;
    seen.current = devices;
    if (following) readWithin(READINGS_EVERY_MS);
  }, [devices, following, readWithin]);

  useEffect(() => {
    if (live === 'live') return;
    const timer = setInterval(() => reading.current(), READINGS_EVERY_MS);
    return () => clearInterval(timer);
  }, [live]);
}
