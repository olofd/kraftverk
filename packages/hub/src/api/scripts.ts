import { ApiError, type KraftverkApi } from '@kraftverk/api-contract';
import { readScript } from '@kraftverk/script';

import type { Hub } from '../node/hub.ts';

/*
  Scripts in TypeScript, as a family answers them (docs/PLAN-SCRIPTS.md):
  for now, one read as this place's engine reads it — what it declares, or
  what is wrong with it, by line — nothing kept, nothing run.
*/

export function scriptsApi(hub: Hub): Pick<KraftverkApi, 'scripts'> {
  return {
    scripts: {
      async check(source) {
        if (!hub.scripts) throw new ApiError('unavailable', 'Scripts cannot run here: this place has no engine for them');
        const { shape, problems } = readScript(source, hub.scripts);
        return { shape, problems };
      },
    },
  };
}
