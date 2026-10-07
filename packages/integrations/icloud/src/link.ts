import type { MemberLink } from '@kraftverk/device-sdk';

import type { FoundDevice } from './protocol/index.ts';

/*
  What a device reads through its iCloud account (docs/PLAN-INTEGRATIONS.md
  §1.1): plain calls on the account's session, which signs in once and asks
  Find My for every device at once. A device holds no password, no token
  and no request of its own.
*/

/** One device in Find My, through the account it is on. */
export interface FindMyLink extends MemberLink {
  /** What Find My last said of it; null until the account has asked. */
  device(): FoundDevice | null;
  /** When the account last heard from Find My. */
  answeredAt(): string | null;
  /** Why the account could not ask just now — signed out, Apple not answering — or null. */
  error(): string | null;
  /** Asks Find My now, not at the account's next turn, and answers this device: what the check step reads. */
  ask(): Promise<FoundDevice>;
  /** Plays a sound on it, wherever it is. */
  playSound(): Promise<void>;
  /** Puts it in lost mode: locked, showing a message and a number to call. */
  lostMode(options: { text: string; phone: string; passcode?: string }): Promise<void>;
}
