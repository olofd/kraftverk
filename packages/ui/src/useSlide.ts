import { useCallback, useEffect, useRef, useState } from 'react';

/** How long after the last key press a value is taken as meant. */
const KEYS_SETTLE_MS = 600;

type Slide<T> = {
  /** The value as the person has it: the device's while untouched. */
  local: T;
  /** Every change, from a drag or from a key. */
  change: (next: (was: T) => T) => void;
  onSlideStart: () => void;
  onSlideEnd: () => void;
};

/**
 * A slider's value between the device's and the person's. It follows the
 * device while untouched and commits once: on release of a drag, or — since
 * the arrow, Home and End keys change the value with no slide around them —
 * once the keys have been still for a moment.
 *
 * `token` says when two values are the same; `commit` gets the value meant and
 * the device's value it replaces.
 */
export function useSlide<T>(value: T, token: (v: T) => string, commit: (next: T, from: T) => void): Slide<T> {
  const [local, setLocal] = useState(value);
  const [adjusting, setAdjusting] = useState(false);
  const latest = useRef(value);
  const device = useRef(value);
  const sliding = useRef(false);
  const keys = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  device.current = value;

  const settle = useCallback(() => {
    if (keys.current) clearTimeout(keys.current);
    keys.current = null;
    sliding.current = false;
    setAdjusting(false);
    if (token(latest.current) !== token(device.current)) commitRef.current(latest.current, device.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the device while untouched, but never yank the thumb mid-change.
  const current = token(value);
  useEffect(() => {
    if (adjusting) return;
    latest.current = device.current;
    setLocal(device.current);
  }, [current, adjusting]);

  useEffect(
    () => () => {
      if (keys.current) clearTimeout(keys.current);
    },
    []
  );

  const change = useCallback(
    (next: (was: T) => T) => {
      latest.current = next(latest.current);
      setLocal(latest.current);
      setAdjusting(true);
      if (sliding.current) return;
      // No slide around it: a key. (A tap on the track changes the value just
      // before its slide starts, which then takes over.)
      if (keys.current) clearTimeout(keys.current);
      keys.current = setTimeout(settle, KEYS_SETTLE_MS);
    },
    [settle]
  );

  const onSlideStart = useCallback(() => {
    sliding.current = true;
    if (keys.current) clearTimeout(keys.current);
    keys.current = null;
  }, []);

  return { local, change, onSlideStart, onSlideEnd: settle };
}
