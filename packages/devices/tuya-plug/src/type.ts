import { GENERIC_SOCKET } from '@kraftverk/protocol-tuya-local';

import { defineTuyaSocket } from './socket-type.ts';

/**
 * Any Tuya energy socket on the home network, spoken to directly with no cloud.
 *
 * The generic layout fits most sockets. A model that differs gets a profile —
 * data — and, when it is common enough to deserve its own name and picture, a
 * type of its own built the same way (see `@kraftverk/device-atorch-s1w`).
 */
export default defineTuyaSocket({
  id: 'tuya.plug',
  meta: {
    name: 'Tuya smart plug',
    brand: 'Tuya',
    models: ['Tuya energy socket', 'Smart Life plug'],
    description: 'Any Tuya or Smart Life plug that measures power, over your home network with no cloud.',
    support: 'community',
    supportNote: 'The layout most Tuya energy sockets use; the check step confirms it on yours.',
  },
  profiles: [GENERIC_SOCKET],
});
