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
};

/** A press the device made, as an event of its description, with when. */
export type Press = { id: string; data: Record<string, Value>; at: string };

/** One Zigbee device, or one group, through its coordinator. */
export interface ZigbeeLink extends MemberLink {
  /** What it is now: its shape from what it exposes — or null while it is joining and Zigbee2MQTT does not know yet. */
  shape(): Shape | null;
  about(): MemberAbout | null;
  /** All it last said of itself, and when. */
  state(): { values: Readonly<Record<string, unknown>>; at: string | null };
  /** The presses since this was last asked, oldest first — taken: each read once. */
  takePresses(): Press[];
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
}
