import { useCallback, useState } from 'react';

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
  /** Presses one of the plug's buttons — its tools: the app asks first where one cannot be undone. True when it ran. */
  press: (button: string) => Promise<boolean>;
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
        // "Not confirmed" included: it says why the control went back.
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

  const press = useCallback(
    async (button: string) => {
      setError(null);
      try {
        await actions.tool(button);
        return true;
      } catch (thrown) {
        setError((thrown as Error).message);
        return false;
      }
    },
    [actions]
  );

  return {
    props,
    press,
    value,
    number,
    pending: (key) => snapshot.pending.has(key),
    canChange: reach.now && !readOnly,
    error,
    write,
    switchTo,
  };
}

