import type { SocketProfile } from '@kraftverk/protocol-tuya-local';
import { defineTuyaSocket } from '@kraftverk/device-tuya-plug';

/**
 * The ATORCH S1W / S1WP / S1BW: a Tuya energy socket with an LCD meter, and the
 * plug kraftverk's reserve feature was designed around — upstream of a power
 * station's AC input (docs/ATORCH-S1W.md).
 */

/**
 * Its datapoints, from the published Home Assistant work on this exact family
 * (make-all/tuya-local issues #3253 and #1103; docs/ATORCH-S1W.md §2).
 *
 * The relay datapoint is the one thing the sources disagree about: the Tuya
 * product specification says 1, the OpenBeken community says 131 on this
 * ATORCH. So the check step reads every datapoint on the actual unit and takes
 * the relay from what is there, and it stays overridable in the plug's settings.
 */
export const ATORCH_S1: SocketProfile = {
  id: 'atorch-s1',
  label: 'ATORCH S1W / S1WP / S1BW',
  productKeys: ['sqrf2g1amfutn4co', 'pl28o0wkaopyft8u'],
  relay: { dp: 1 },
  metrics: {
    amps: { dp: 18, scale: 3 },
    watts: { dp: 19, scale: 2 },
    volts: { dp: 20, scale: 2 },
    kwh: { dp: 123, scale: 2 },
    hz: { dp: 133, scale: 2 },
    powerFactor: { dp: 134, scale: 2 },
  },
  notes: 'Relay may be DP 1 or DP 131 depending on firmware — the check step settles it on the unit.',
};

export default defineTuyaSocket({
  id: 'atorch.s1w',
  meta: {
    name: 'ATORCH S1W',
    brand: 'ATORCH',
    models: ['S1W', 'S1WP', 'S1BW'],
    description: 'A Wi-Fi socket with a power meter and display, switched and read over your home network with no cloud.',
    support: 'experimental',
    supportNote: 'Datapoints from published work on this family; not yet confirmed on a unit here.',
    docsUrl: 'docs/ATORCH-S1W.md',
  },
  profiles: [ATORCH_S1],
});
