/*
  What Zigbee2MQTT says and is told over MQTT: the slice of its API this
  integration uses, typed from its documentation
  (zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html, exposes.html)
  and checked against what a Zigbee2MQTT 2.x publishes. Written here, not
  imported: its own types are GPL-3.0 and would bring its radio stack along
  (NOTICE). Everything is optional that a release may leave out.
*/

/** Zigbee2MQTT's access bits on an expose: in the published state, settable with `/set`, gettable with `/get`. */
export const ACCESS = { STATE: 1, SET: 2, GET: 4 } as const;

/** One thing a device exposes (zigbee-herdsman-converters' `exposes`), as JSON. */
export type Expose = {
  type: string;
  name?: string;
  label?: string;
  property?: string;
  description?: string;
  access?: number;
  endpoint?: string;
  category?: 'config' | 'diagnostic';
  unit?: string;
  value_min?: number;
  value_max?: number;
  value_step?: number;
  value_on?: unknown;
  value_off?: unknown;
  value_toggle?: unknown;
  values?: readonly unknown[];
  presets?: readonly { name: string; value: unknown; description?: string }[];
  /** A specific expose's own (switch, light, cover, …), and a composite's fields. */
  features?: readonly Expose[];
  /** A list's item. */
  item_type?: Expose;
};

/** What converters knows of a device: its model, its vendor, what it exposes. */
export type Definition = {
  model: string;
  vendor: string;
  description: string;
  exposes: readonly Expose[];
  /** `native` — known by converters; `generated` — guessed from what the device said; `external` — a converter of the owner's. */
  source?: 'native' | 'generated' | 'external';
  supports_ota?: boolean;
  options?: readonly Expose[];
};

/** How far its interview is: what the device is, asked of it when it joins. */
export type InterviewState = 'PENDING' | 'IN_PROGRESS' | 'SUCCESSFUL' | 'FAILED';

/** One device in `bridge/devices`. */
export type BridgeDevice = {
  ieee_address: string;
  type: 'Coordinator' | 'Router' | 'EndDevice' | 'Unknown' | string;
  friendly_name: string;
  network_address?: number;
  supported?: boolean;
  disabled?: boolean;
  description?: string;
  definition?: Definition | null;
  power_source?: string;
  model_id?: string | null;
  manufacturer?: string | null;
  software_build_id?: string | null;
  date_code?: string | null;
  interview_state?: InterviewState;
};

/** One group in `bridge/groups`. */
export type BridgeGroup = {
  id: number;
  friendly_name: string;
  description?: string | null;
  members: readonly { ieee_address: string; endpoint: number }[];
  scenes?: readonly { id: number; name: string }[];
};

/** `bridge/info`, the parts of it this reads. */
export type BridgeInfo = {
  version?: string;
  commit?: string;
  coordinator?: { ieee_address?: string; type?: string; meta?: Record<string, unknown> };
  network?: { channel?: number; pan_id?: number; extended_pan_id?: unknown };
  permit_join?: boolean;
  /** When joining ends, ms since the epoch. */
  permit_join_end?: number;
  restart_required?: boolean;
  /** Its settings as it runs with them — the network key among them, so the topic is secret. Only what the integration relies on is read. */
  config?: {
    device_options?: { retain?: boolean };
    availability?: boolean | { enabled?: boolean };
    advanced?: { last_seen?: string };
  };
};

/** `bridge/response/<request>`: what a request was answered with, its `transaction` echoed. */
export type BridgeResponse = {
  data?: unknown;
  status: 'ok' | 'error';
  error?: string;
  transaction?: string;
};

/** `bridge/event`: something that happened on the network. */
export type BridgeEvent = {
  type: 'device_joined' | 'device_interview' | 'device_announce' | 'device_leave' | string;
  data?: { friendly_name?: string; ieee_address?: string; status?: 'started' | 'successful' | 'failed'; supported?: boolean };
};

/** A device's `update` property: what Zigbee2MQTT knows of its firmware. */
export type UpdateState = {
  state?: 'available' | 'idle' | 'updating' | 'scheduled';
  installed_version?: number;
  latest_version?: number;
  progress?: number;
  remaining?: number;
};

/** A message's payload as JSON, or null when it is not. */
export function parseJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    return null;
  }
}

/** A JSON value as an object, or null when it is not one. */
export const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** An IEEE address as kraftverk keeps it — 16 hex digits, lower case, no `0x` — or null for anything else. */
export function ieeeKey(text: unknown): string | null {
  const hex = String(text ?? '').trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{16}$/.test(hex) ? hex : null;
}

/** An IEEE address as Zigbee2MQTT writes it, and resolves in a topic: `0x` and 16 hex digits. */
export const ieeeOf = (key: string): string => `0x${key}`;
