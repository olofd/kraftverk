import { useEffect, useState } from 'react';

import { WriteGate, type WriteSnapshot } from './writeGate';

/**
 * A write gate for one provider, and a re-render whenever its writes change.
 *
 * The gate itself is stable for the life of the component, so callbacks can
 * close over it without listing it; the snapshot is what a render reads.
 *
 * Deliberately an ordinary state update rather than `useSyncExternalStore`. A
 * write stores the device's confirmed answer and *then* lets go of its pending
 * value, and the two must land in the same render: the store hook renders its
 * change at a higher priority than the state update before it, and for one
 * frame the switch showed the state it had just been switched away from.
 */
export function useWriteGate<Key extends string>(): [WriteGate<Key>, WriteSnapshot<Key>] {
  const [gate] = useState(() => new WriteGate<Key>());
  const [snapshot, setSnapshot] = useState(gate.snapshot);

  useEffect(() => {
    // Anything that changed between the first render and this effect.
    setSnapshot(gate.snapshot());
    return gate.subscribe(() => setSnapshot(gate.snapshot()));
  }, [gate]);

  return [gate, snapshot];
}
