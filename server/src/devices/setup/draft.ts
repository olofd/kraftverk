import type { CheckOutcome, DraftView, SaveInput } from '@kraftverk/api-contract';
import type { ClientId, ConfigSchema, ConnectionMethod, DeviceType, Identified, Protocol, SetupStepView, Sighting } from '@kraftverk/device-sdk';

import type { Reach } from './reach.ts';

/**
 * A draft: one person part-way through setting up one device (docs/DATA-MODEL.md
 * §1). It lives in memory for fifteen minutes, and nothing is stored until it
 * is saved.
 */

export const DRAFT_TTL_MS = 15 * 60_000;

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

export type Draft = {
  id: string;
  by: string;
  /** Who will hold the connection: null for this server, or the app that ran the steps itself. */
  heldBy: ClientId | null;
  type: DeviceType<any>;
  method: ConnectionMethod | null;
  /** How it reaches what it sets up: hardware over a protocol and a transport, or nothing — its simulator. */
  reach: Reach;
  plan: SetupStepView[];
  address: string | null;
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

/** The schema of everything a connection stores for a method: its own config and its protocol's credentials. */
export function connectionSchema(method: ConnectionMethod | null, protocol: Protocol | null): ConfigSchema {
  return { fields: { ...(protocol?.credentials?.schema.fields ?? {}), ...(method?.config?.fields ?? {}) } };
}

/** A draft as the app sees it: never a secret, only which fields have one. */
export function viewOf(draft: Draft): DraftView {
  const checked = draft.checked ? (({ identified: _identified, ...rest }) => rest as CheckOutcome)(draft.checked) : null;
  return {
    id: draft.id,
    heldBy: draft.heldBy,
    typeId: draft.type.id,
    methodId: draft.method?.id ?? null,
    plan: draft.plan,
    address: draft.address,
    device: draft.device,
    connection: draft.connection,
    secrets: [...draft.secrets.keys()],
    checked,
    expiresAt: new Date(draft.expiresAt).toISOString(),
  };
}
