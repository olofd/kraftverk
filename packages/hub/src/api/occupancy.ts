import { ApiError, type KraftverkApi, type OccupancyView } from '@kraftverk/api-contract';
import type { OccupancyRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { OCCUPANCY_DAYS } from '../occupancy/occupancy.ts';

/*
  Which spaces have someone in them (docs/PLAN-WORLD-MODEL.md §8.9), as a
  family answers it: whoever they are, so every member is told the same.
  Never on the timeline.
*/

const viewOf = (record: OccupancyRecord): OccupancyView => ({ spaceId: record.spaceId, since: record.since, until: record.until, peak: record.peak, devices: record.devices });

export function occupancyApi(hub: Hub): Pick<KraftverkApi, 'occupancy'> {
  return {
    occupancy: {
      async now(homeId) {
        if (!hub.places.home(homeId)) throw new ApiError('not-found', 'No such home');
        return hub.occupancies.open(homeId).map(viewOf);
      },

      async history(spaceId, options = {}) {
        if (!hub.spaces.space(spaceId)) throw new ApiError('not-found', 'No such space');
        const hours = Math.min(Math.max(options.hours ?? 24, 0.25), OCCUPANCY_DAYS * 24);
        return hub.occupancies.since(spaceId, new Date(Date.now() - hours * 3_600_000).toISOString()).map(viewOf);
      },
    },
  };
}
