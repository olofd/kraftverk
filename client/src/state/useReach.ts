import { useMemo } from 'react';

import type { ConnectionView, HeldBy } from '@kraftverk/api-client';
import type { IconName } from '@kraftverk/ui';

import { HERE, HERE_PLATFORM } from '../platform/here';
import { useFamily } from './FamilyProvider';

/** Where a device is reached from, as a person reads it: "through your server", "from this phone" — and its icon. */
export type Reach = { words: string; icon: IconName };

/**
 * How the app says where a device is reached from, said one way on every
 * screen: the master's ways — through your server when this app follows one,
 * from here when it keeps its own home — this app's own, and another node's
 * by its name. Words only: what a screen does never depends on it.
 */
export function useReach() {
  const { role } = useFamily();
  return useMemo(() => {
    const here: Reach = { words: `from ${HERE}`, icon: HERE_PLATFORM === 'web' ? 'monitor' : 'smartphone' };
    const master: Reach = role === 'follower' ? { words: 'through your server', icon: 'server' } : here;
    return {
      master,
      here,
      /** A way being added, by who will hold it. */
      holder: (holder: HeldBy): Reach => (holder === 'master' ? master : here),
      /** A connection, by who holds it. */
      of: (heldBy: ConnectionView['heldBy']): string => (heldBy.kind === 'master' ? master.words : heldBy.kind === 'this-node' ? here.words : `from ${heldBy.name}`),
      /** What to say while it is being reached. */
      waiting: (holder: 'master' | 'this-node'): string => (holder === 'master' && role === 'follower' ? 'Waiting for your server…' : `Connecting ${here.words}…`),
    };
  }, [role]);
}
