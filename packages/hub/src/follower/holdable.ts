import { isSimulated, platformsOf, type NodeTraits } from '@kraftverk/device-sdk';

import type { Installed } from '../hub.ts';
import { unfitFor } from '../installed/needs.ts';

/** Whether a way can be held by this node where it runs: its transport has an entry here, its protocol is installed, and the node is what the way needs. A simulated one is the master's. */
export function holdableHere(installed: Installed, node: NodeTraits, method: Parameters<typeof platformsOf>[0]): boolean {
  if (isSimulated(method) || unfitFor(method, node)) return false;
  const { transports, protocols } = installed;
  return platformsOf(method, transports.definition(method.transport)).includes(transports.platform) && Boolean(protocols.get(method.protocol)?.bindings[method.transport]);
}
