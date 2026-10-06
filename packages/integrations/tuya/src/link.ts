import type { MemberLink } from '@kraftverk/device-sdk';

import type { Dps } from './protocol/index.ts';

/*
  What a Zigbee device reads and asks through its Tuya gateway
  (docs/PLAN-INTEGRATIONS.md §1.1): plain calls on the gateway's one
  conversation, with the gateway's key, naming the device by its Zigbee
  address. A device package for a Zigbee product reads its device through
  this, and never holds a key or a connection of its own.
*/

/** One Zigbee device, through the gateway it is paired with. */
export interface ZigbeeLink extends MemberLink {
  /** Every datapoint the gateway last heard of it: its memory, answered at once, asking the device nothing. */
  status(): Promise<Dps>;
  /** Has the device measure these datapoints again: what changed comes as a push. */
  refresh(dps: readonly number[]): Promise<void>;
  /** Writes datapoints, and answers what the gateway said back. */
  set(dps: Dps): Promise<Dps>;
  /**
   * What the device pushed since this was last asked, oldest first — taken:
   * each push is read once. The link calls back when there are new ones.
   */
  takePushes(): Dps[];
  /** Whether the gateway last said it can reach the device; null until it has said. */
  online(): boolean | null;
  /** Whether the conversation with the gateway works now. */
  connected(): boolean;
  /** The protocol version the gateway speaks. */
  version(): string;
}
