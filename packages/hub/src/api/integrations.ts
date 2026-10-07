import type { KraftverkApi } from '@kraftverk/api-contract';
import { forgetKept, keptItems } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';

/*
  What each integration keeps between setups (`SetupContext.kept`), as its
  page lists it — said, never shown — and forgotten on asking.
*/

export function integrationsApi(hub: Hub): Pick<KraftverkApi, 'integrations'> {
  return {
    integrations: {
      kept: async (integration) => keptItems(hub.db, integration),
      forget: async (integration, key) => forgetKept(hub.db, integration, key),
    },
  };
}
