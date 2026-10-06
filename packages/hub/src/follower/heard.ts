/**
 * What a follower keeps of what its master said (`last_heard`), by what was
 * asked: one name for each, so what is kept and what is read for it are
 * always the same key.
 */
export const HEARD = {
  devices: 'devices',
  removed: 'removed',
  deviceTypes: 'device-types',
  transports: 'transports',
  policy: 'policy',
  home: 'home',
  nodes: 'nodes',
  /** The home as one file: what this node keeps if its master is gone (`handover/keep.ts`). */
  configuration: 'configuration',
  problems: (limit?: number) => `problems:${limit ?? ''}`,
  needsYou: 'needs-you',
  /** The automations, or one device's. */
  automations: (device?: string) => `automations:${device ?? ''}`,
} as const;
