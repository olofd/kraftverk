import { useCallback, useEffect, useState } from 'react';

import type { DeviceScreenProps } from '@kraftverk/api-client';
import type { Value } from '@kraftverk/device-sdk';
import { useWriteGate } from '@kraftverk/ui';

/**
 * What the ATORCH's screens draw from: its values with any write in flight
 * drawn over them, and the ways to change it — all through the holder's
 * gateway, which asks a person to confirm what needs it.
 */
export type Plug = {
  props: DeviceScreenProps;
  /** A value as it is now: what is being written, else the write's own answer, else the last reading. */
  value: (key: string) => Value;
  number: (key: string) => number | null;
  pending: (key: string) => boolean;
  /** Commands and writes reach it, and are not all refused. */
  canChange: boolean;
  /** Why the last change did not happen, until the next is asked for. */
  error: string | null;
  write: (patch: Record<string, Value>) => Promise<void>;
  switchTo: (on: boolean) => Promise<void>;
};

export function usePlug(props: DeviceScreenProps): Plug {
  const { device, actions, reach, readOnly } = props;
  const [gate, snapshot] = useWriteGate<string>();
  // A write's answer, shown until a reading newer than it arrives.
  const [answered, setAnswered] = useState<Record<string, { value: Value; at: number }>>({});
  const [error, setError] = useState<string | null>(null);

  const reading = (key: string) => device.readings.find((r) => r.key === key);
  const value = (key: string): Value => {
    if (snapshot.pending.has(key)) return snapshot.pending.get(key) as Value;
    const read = reading(key);
    const answer = answered[key];
    if (answer && (!read || Date.parse(read.at) < answer.at)) return answer.value;
    return read?.value ?? null;
  };
  const number = (key: string) => {
    const v = value(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const write = useCallback(
    async (patch: Record<string, Value>) => {
      setError(null);
      try {
        const result = await gate.run(patch, () => actions.write(patch));
        if (result.values) {
          const at = Date.now();
          setAnswered((was) => ({ ...was, ...Object.fromEntries(Object.entries(result.values!).map(([key, v]) => [key, { value: v, at }])) }));
        }
        if (result.outcome === 'refused' || result.outcome === 'failed') setError(result.detail);
      } catch (thrown) {
        setError((thrown as Error).message);
      }
    },
    [actions, gate]
  );

  const switchTo = useCallback(
    async (on: boolean) => {
      setError(null);
      try {
        const result = await gate.run({ relay: on }, () => actions.command({ part: 'main', capability: 'switch', command: 'set', args: { on } }));
        if (result.outcome === 'refused' || result.outcome === 'failed') setError(result.detail);
        else setAnswered((was) => ({ ...was, relay: { value: on, at: Date.now() } }));
      } catch (thrown) {
        setError((thrown as Error).message);
      }
    },
    [actions, gate]
  );

  return {
    props,
    value,
    number,
    pending: (key) => snapshot.pending.has(key),
    canChange: reach.now && !readOnly,
    error,
    write,
    switchTo,
  };
}

/*
  Live readings.

  The plug sends a reading every second while its fast refresh is on, and turns
  it off itself after five minutes. A person who asks for live readings wants
  them while they are looking, so the wish is kept here, per device, and every
  screen that shows it renews the refresh when the plug lets it lapse. Leave
  the screens and nothing renews it: it stops within five minutes by itself.
*/

const LAPSES_AFTER_S = 300;
const wishes = new Map<string, boolean>();
const listeners = new Set<() => void>();
const wish = (id: string, wanted: boolean) => {
  wishes.set(id, wanted);
  for (const listener of listeners) listener();
};

export type Live = {
  on: boolean;
  /** Asked for, and kept on while a screen is open. */
  kept: boolean;
  /** Seconds until the plug stops by itself, when it is on and not kept. */
  left: number | null;
  pending: boolean;
  set: (on: boolean) => void;
};

/**
 * Whether readings are live, and a way to ask. `keep` asks as the screen
 * opens — the settings, where a change is watched as it lands.
 */
export function useLive(plug: Plug, options: { keep?: boolean } = {}): Live {
  const id = plug.props.device.id;
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);

  const on = plug.value('live') === true;
  const pending = plug.pending('live');
  const kept = wishes.get(id) ?? false;
  const { canChange, write } = plug;

  useEffect(() => {
    if (options.keep) wish(id, true);
  }, [id, options.keep]);

  // Renew when the plug lets it lapse, while wanted and a screen is open.
  useEffect(() => {
    if (!kept || on || pending || !canChange) return;
    const timer = setTimeout(() => void write({ live: true }), 400);
    return () => clearTimeout(timer);
  }, [kept, on, pending, canChange, write]);

  // Counts down from when it came on.
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setSince(on ? Date.now() : null);
  }, [on]);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);

  return {
    on,
    kept,
    left: on && !kept && since !== null ? Math.max(0, LAPSES_AFTER_S - (now - since) / 1000) : null,
    pending,
    set: (next) => {
      wish(id, next);
      void write({ live: next });
    },
  };
}
