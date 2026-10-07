import type { MemberLink, Value } from '@kraftverk/device-sdk';

import type { Shape } from './protocol/index.ts';

/*
  What a Zigbee device — or a group — reads and asks through its
  coordinator (docs/PLAN-INTEGRATIONS.md §1.1): plain calls on the
  coordinator's one conversation with Zigbee2MQTT. A device package for a
  Zigbee product reads its device through this, and never speaks MQTT.
*/

/** What is known of a member, from Zigbee2MQTT's device list. */
export type MemberAbout = {
  model: string | null;
  vendor: string | null;
  /** What converters calls it: "Smart plug with power monitoring". */
  description: string | null;
  manufacturer: string | null;
  software: string | null;
  powerSource: string | null;
  /** Known by converters — not guessed from what it said. */
  known: boolean;
  /** Zigbee2MQTT can update its firmware (docs/PLAN-ZIGBEE.md §5.7). */
  ota: boolean;
};

/** Something that happened to the device, as an event of its description, with when: a press, a firmware updated. */
export type MemberEvent = { id: string; data: Record<string, Value>; at: string };

/**
 * Its firmware, updated as Zigbee2MQTT does it (docs/PLAN-ZIGBEE.md §5.7):
 * each call answers in a sentence what it did. What an update does after is
 * read from its state, and said as its events.
 */
export type FirmwareCalls = {
  /** Updates it from Zigbee2MQTT's own index — or, while another is updating, puts it in line; one on batteries is scheduled for when it next wakes. */
  update(): Promise<string>;
  /** Stops an update under way, takes one out of line, or unschedules one. */
  stop(): Promise<string>;
  /** Asks Zigbee2MQTT's index now whether a newer firmware is offered. */
  check(): Promise<string>;
};

/** One Zigbee device, or one group, through its coordinator. */
export interface ZigbeeLink extends MemberLink {
  /** What it is now: its shape from what it exposes — or null while it is joining and Zigbee2MQTT does not know yet. */
  shape(): Shape | null;
  about(): MemberAbout | null;
  /** All it last said of itself, and when. */
  state(): { values: Readonly<Record<string, unknown>>; at: string | null };
  /** What happened since this was last asked, oldest first — taken: each read once. */
  takeEvents(): MemberEvent[];
  /** Whether Zigbee2MQTT says it can reach it: null when it does not say (its availability is off). */
  available(): boolean | null;
  /** Whether Zigbee2MQTT is there now: connected to the broker, and saying it is online. */
  connected(): boolean;
  /** Its own permanent id: `zigbee:<IEEE>` for a device, the group's for a group. */
  identity(): string | null;
  /** Sets values: a `/set` with Zigbee2MQTT's properties. */
  set(payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** Asks for values again: a `/get`; what it says comes as its state. */
  get(payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** Its firmware: a device's, never a group's. */
  readonly firmware: FirmwareCalls;
}
