import type { NiuBatteryHealth, NiuState, NiuTotals, NiuVehicle } from './api.ts';

/*
  How a NIU account and the scooters behind it speak, over the channel the
  account opens for each (docs/PLAN-INTEGRATIONS.md §4.3). The account signs
  in once and asks NIU for every scooter on it; each scooter is told what is
  its own. Pure: JSON messages on two topics, whichever side runs where.
*/

/** What the account tells a scooter, on this topic. */
export const SAID = 'said';
/** What a scooter asks of its account, on this topic. */
export const ASK = 'ask';

/** What an account tells one scooter behind it. */
export type MemberSaid =
  /** Which scooter it is, as the account's list names it. */
  | { kind: 'vehicle'; vehicle: NiuVehicle }
  /** What it last reported, and when NIU last gave it to the account. */
  | { kind: 'state'; state: NiuState; answeredAt: string }
  /** What changes slowly: its batteries' health, its totals. */
  | { kind: 'slow'; batteries: NiuBatteryHealth[]; totals: NiuTotals | null; at: string }
  /** Everything NIU says about it, raw, as the raw tool shows it: asked for. */
  | { kind: 'raw'; from: string; state: unknown; batteries: unknown; totals: unknown }
  /** Why the account could not ask NIU, in a person's words. */
  | { kind: 'error'; error: string };

/** What a scooter asks of its account: everything raw, for its tool. */
export type MemberAsk = { kind: 'raw' };

export const encodeMessage = (message: MemberSaid | MemberAsk): Uint8Array => new TextEncoder().encode(JSON.stringify(message));

export const decodeMessage = <T extends MemberSaid | MemberAsk>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;
