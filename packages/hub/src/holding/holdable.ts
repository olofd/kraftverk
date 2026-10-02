import { isSimulated, placesOf } from '@kraftverk/device-sdk';

import type { Installed } from '../hub.ts';

/** Whether a way can be held by this app where it runs: its transport has an entry here, its protocol is installed, and it is not kept to a server. */
export function holdableHere(installed: Installed, method: Parameters<typeof placesOf>[0]): boolean {
  if (isSimulated(method) || method.serverOnly) return false;
  const { transports, protocols } = installed;
  return placesOf(method, transports.definition(method.transport)).includes(transports.platform) && Boolean(protocols.get(method.protocol)?.bindings[method.transport]);
}
