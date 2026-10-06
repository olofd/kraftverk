import type { MemberLink } from '@kraftverk/device-sdk';

import type { NiuBatteryHealth, NiuState, NiuTotals, NiuVehicle } from './protocol/index.ts';

/*
  What a scooter reads through its NIU account (docs/PLAN-INTEGRATIONS.md
  §1.1): plain calls on the account's session, which signs in once and asks
  NIU for every scooter on it. A device package for a NIU model reads its
  scooter through this, never through NIU's cloud itself: it holds no
  password, no token and no request.
*/

/** What NIU last gave the account of one scooter: its report, and when NIU answered. */
export type ScooterReport = { state: NiuState; answeredAt: string };

/** What changes slowly: its batteries' health and its totals, and when they were asked. */
export type ScooterSlow = { batteries: NiuBatteryHealth[]; totals: NiuTotals | null; at: string };

/** Everything NIU says of it, raw, as the raw tool shows it: where it came from, and each answer. */
export type ScooterRaw = { from: string; state: unknown; batteries: unknown; totals: unknown };

/** One scooter, through the account it is on. */
export interface ScooterLink extends MemberLink {
  /** Which scooter it is, as the account's list names it. */
  vehicle(): NiuVehicle;
  /** What it last reported; null until the account has asked. */
  report(): ScooterReport | null;
  /** Its batteries' health and totals; null until the account has asked. */
  slow(): ScooterSlow | null;
  /** Why the account could not ask NIU just now — signed out, NIU not answering — or null. */
  error(): string | null;
  /** Asks NIU now, not at its next turn, and answers its report: what the check step reads. */
  ask(): Promise<ScooterReport>;
  /** Everything NIU says of it, raw. */
  raw(): Promise<ScooterRaw>;
}
