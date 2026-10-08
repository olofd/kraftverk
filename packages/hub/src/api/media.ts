import { ApiError, type Caller, type KraftverkApi, type MediaType } from '@kraftverk/api-contract';
import { looksLike, MEDIA_MAX_BYTES, MEDIA_TYPES, mediaIdOf } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';

/*
  Pictures, as a family answers them (docs/PLAN-WORLD-MODEL.md §8.12): kept by
  their content, once each, and checked for what they say they are — never
  decoded. A home or a device names one by its id afterwards; one nothing
  names is let go a day later.
*/

/** The most a picture may be across: the app makes them 2048 pixels at most. */
const MOST_PIXELS = 8192;

export function mediaApi(hub: Hub, _caller: Caller): Pick<KraftverkApi, 'media'> {
  return {
    media: {
      async add(picture) {
        if (!(MEDIA_TYPES as readonly string[]).includes(picture.type)) throw new ApiError('invalid', 'A picture is WebP, JPEG or PNG');
        const data = picture.data;
        if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new ApiError('invalid', 'A picture has bytes');
        if (data.byteLength > MEDIA_MAX_BYTES) throw new ApiError('invalid', 'A picture is 2 MB at most: the app makes it smaller first');
        if (!looksLike(picture.type as MediaType, data)) throw new ApiError('invalid', `Those bytes are not ${picture.type}`);
        const fits = (side: number) => Number.isInteger(side) && side > 0 && side <= MOST_PIXELS;
        if (!fits(picture.width) || !fits(picture.height)) throw new ApiError('invalid', `A picture is 1 to ${MOST_PIXELS} pixels a side`);
        const kept = hub.media.put(mediaIdOf(data), { type: picture.type as MediaType, width: picture.width, height: picture.height, data });
        return { id: kept.id, type: kept.type, bytes: kept.bytes, width: kept.width, height: kept.height };
      },

      async get(id) {
        const kept = hub.media.get(id);
        const data = kept ? hub.media.data(id) : null;
        return kept && data ? { type: kept.type, data } : null;
      },
    },
  };
}
