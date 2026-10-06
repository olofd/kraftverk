import { isBridgedMethod, isSimulated, platformsOf, type NodeTraits } from '@kraftverk/device-sdk';

import type { Installed } from './from.ts';
import { unfitFor } from './needs.ts';

/** Whether a way can be held by this node where it runs: its transport has an entry here, its protocol is installed, and the node is what the way needs. A simulated one is the master's; one through a bridge is held wherever its bridge is. */
export function holdableHere(installed: Installed, node: NodeTraits, method: Parameters<typeof platformsOf>[0]): boolean {
  if (isSimulated(method) || isBridgedMethod(method) || unfitFor(method, node)) return false;
  const { transports, protocols } = installed;
  return platformsOf(method, transports.definition(method.transport)).includes(transports.platform) && Boolean(protocols.get(method.protocol)?.bindings[method.transport]);
}
