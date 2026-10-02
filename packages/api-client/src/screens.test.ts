import { describe, expect, test } from 'bun:test';

import { linkId, MAIN_PART, savedDeviceId } from '@kraftverk/device-sdk';

import { fedBy, feedsTo } from './screens.ts';
import type { LinkView } from '@kraftverk/api-contract';

/* What a device's screen says of the house: what feeds each of its parts, and what each feeds. */

describe('what feeds what, for a screen', () => {
  test('what feeds each part, from the links it is the target of', () => {
    const links: LinkView[] = [
      { id: linkId('l-1'), kind: 'feeds', role: 'target', part: 'input.ac', other: { id: savedDeviceId('d-plug'), name: 'Charger plug', part: MAIN_PART, partLabel: '' } },
      { id: linkId('l-2'), kind: 'feeds', role: 'source', part: 'outlet.ac', other: { id: savedDeviceId('d-cabin'), name: 'Cabin station', part: 'input.ac', partLabel: 'Mains' } },
    ];
    expect(fedBy(links)).toEqual({ 'input.ac': 'Charger plug' });
    expect(feedsTo(links)).toEqual({ 'outlet.ac': 'Cabin station — Mains' });
  });
});
