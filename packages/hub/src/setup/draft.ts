import type { CheckOutcome, DraftView, SaveInput } from '@kraftverk/api-contract';
import type { Actor, NodeId, ConfigValues, ConnectionMethod, DeviceType, Identified, memoryHeld, SavedDeviceId, SetupStepView, Sighting } from '@kraftverk/device-sdk';

import type { Reach } from './reach.ts';

/**
 * A draft: one person part-way through setting up one device (docs/DATA-MODEL.md
 * §1). It lives in memory for fifteen minutes, and nothing is stored until it
 * is saved.
 */

export const DRAFT_TTL_MS = 15 * 60_000;


export type Draft = {
  id: string;
  by: Actor;
  /** The node that will hold the connection: this one, or the node that ran the steps itself, following this one. */
  heldBy: NodeId;
  type: DeviceType<any>;
  method: ConnectionMethod | null;
  /** How it reaches what it sets up: hardware over a protocol and a transport, or nothing — its simulator. */
  reach: Reach;
  plan: SetupStepView[];
  address: string | null;
  /** The bridge it is reached through, for a member of one: its address is then its key there. Null otherwise, or until chosen. */
  through: SavedDeviceId | null;
  /** A way you have, set up again: its device and connection. Null while adding. */
  again: { deviceId: SavedDeviceId; connectionId: string; name: string; identity: string | null } | null;
  /** What an action's next turn needs that the app never sees (`ask.carry`), by action — with the fields it asked, which a turn answering it gives. */
  carried: Map<string, { carry: ConfigValues; asked: string[] }>;
  /** What each action holds live between its turns (`SetupHeld`), closed with the draft. */
  held: Map<string, ReturnType<typeof memoryHeld>>;
  /** The secrets a way set up again already had: what was given anew is what differs. */
  given: Map<string, string>;
  identityHint: string | null;
  device: Record<string, unknown>;
  connection: Record<string, unknown>;
  secrets: Map<string, string>;
  /** Placeholders the app was handed, by the secret each stands for. */
  placeholders: Map<string, string>;
  checked: (CheckOutcome & { identified?: Identified }) | null;
  sightings: readonly Sighting[];
  stopWatching: (() => void) | null;
  expiresAt: number;
};

/** A save as the route has parsed it (`SaveInput` with its defaults applied). */
export type SaveRequest = SaveInput & Required<Pick<SaveInput, 'name' | 'mode'>>;

/** A draft as the app sees it: never a secret, only which fields have one. */
export function viewOf(draft: Draft): DraftView {
  const checked = draft.checked ? (({ identified: _identified, ...rest }) => rest as CheckOutcome)(draft.checked) : null;
  return {
    id: draft.id,
    again: draft.again ? { deviceId: draft.again.deviceId, connectionId: draft.again.connectionId, name: draft.again.name } : null,
    heldBy: draft.heldBy,
    typeId: draft.type.id,
    methodId: draft.method?.id ?? null,
    plan: draft.plan,
    address: draft.address,
    through: draft.through,
    device: draft.device,
    connection: draft.connection,
    secrets: [...draft.secrets.keys()],
    checked,
    expiresAt: new Date(draft.expiresAt).toISOString(),
  };
}
