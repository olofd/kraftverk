import type { Caller, KraftverkApi } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { automationsApi } from './automations.ts';
import { configurationApi } from './configuration.ts';
import { connectionsApi } from './connections.ts';
import { devicesApi } from './devices.ts';
import { homeWideApi } from './home.ts';
import { liveApi } from './live.ts';
import { nodesApi } from './nodes.ts';
import { setupApi } from './setup.ts';
import { transportsApi } from './transports.ts';

/**
 * `KraftverkApi`, answered in the process for one caller: what the server's
 * routes adapt from HTTP, and what an app with no server asks directly.
 * Made per caller, and cheap to make: what must outlive one — the tokens a
 * person's yes is sent back with — is the hub's.
 */
export function homeApi(hub: Hub, caller: Caller): KraftverkApi {
  return {
    ...devicesApi(hub, caller),
    ...connectionsApi(hub, caller),
    ...setupApi(hub, caller),
    ...transportsApi(hub),
    ...automationsApi(hub, caller),
    ...homeWideApi(hub, caller),
    ...configurationApi(hub, caller),
    ...nodesApi(hub, caller),
    ...liveApi(hub, caller),
  };
}

export { actorOf, intentOf } from './caller.ts';
