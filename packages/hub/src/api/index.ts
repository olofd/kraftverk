import type { Caller, KraftverkApi } from '@kraftverk/api-contract';

import type { Hub } from '../node/hub.ts';
import { automationsApi } from './automations.ts';
import { configurationApi } from './configuration.ts';
import { connectionsApi } from './connections.ts';
import { devicesApi } from './devices.ts';
import { familyWideApi } from './family.ts';
import { gated } from './gate.ts';
import { homesApi } from './homes.ts';
import { zonesApi } from './zones.ts';
import { presenceApi } from './presence.ts';
import { occupancyApi } from './occupancy.ts';
import { modesApi } from './modes.ts';
import { variablesApi } from './variables.ts';
import { notificationsApi } from './notifications.ts';
import { mediaApi } from './media.ts';
import { labelsApi } from './labels.ts';
import { peopleApi } from './people.ts';
import { scriptsApi } from './scripts.ts';
import { spacesApi } from './spaces.ts';
import { integrationsApi } from './integrations.ts';
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
export function familyApi(hub: Hub, caller: Caller): KraftverkApi {
  const api: KraftverkApi = {
    ...devicesApi(hub, caller),
    ...connectionsApi(hub, caller),
    ...setupApi(hub, caller),
    ...transportsApi(hub),
    ...integrationsApi(hub),
    ...automationsApi(hub, caller),
    ...scriptsApi(hub, caller),
    ...familyWideApi(hub, caller),
    ...homesApi(hub, caller),
    ...zonesApi(hub, caller),
    ...presenceApi(hub, caller),
    ...occupancyApi(hub),
    ...modesApi(hub, caller),
    ...variablesApi(hub, caller),
    ...notificationsApi(hub, caller),
    ...mediaApi(hub, caller),
    ...spacesApi(hub, caller),
    ...labelsApi(hub, caller),
    ...peopleApi(hub, caller),
    ...configurationApi(hub, caller),
    ...nodesApi(hub, caller),
    ...liveApi(hub, caller),
  };
  // Every call behind its gate (gate.ts): who may ask at all, and a yes only from a person.
  return gated(api, caller, (id) => hub.people.roleOf(id));
}

export { actorOf, intentOf } from './caller.ts';
