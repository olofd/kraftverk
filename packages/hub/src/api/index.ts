import type { Caller, KraftverkApi } from '@kraftverk/api-contract';

import type { Hub } from '../hub.ts';
import { devicesApi } from './devices.ts';
import { automationsApi } from './automations.ts';
import { setupApi } from './setup.ts';

/**
 * `KraftverkApi`, answered in the process for one caller: what the server's
 * routes adapt from HTTP, and what an app with no server asks directly.
 * Made per caller, and cheap to make: what must outlive one — the tokens a
 * person's yes is sent back with — is the hub's.
 */
export function homeApi(hub: Hub, caller: Caller): KraftverkApi {
  return {
    ...devicesApi(hub, caller),
    ...setupApi(hub, caller),
    ...automationsApi(hub, caller),
  };
}

export { actorOf, intentOf } from './caller.ts';
