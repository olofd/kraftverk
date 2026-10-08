import type { Challenge, Linked, Said, SignIn, Statement } from '@kraftverk/identity';

/*
  The accounts on a device (docs/PLAN-WORLD-MODEL.md §10.6), as it answers
  them: before any family and beside every one. An account works with no
  server: made with a sign-in provider or as a local account, both the same
  — a person, a key on this device, and recovery words shown once.
*/

/** A family an account is in, and where its master is. */
export type MyFamilyView = { familyId: string; name: string; master: 'here' | 'server'; serverUrl: string | null; joinedAt: string };

/** An account on this device. */
export type AccountView = {
  personId: string;
  name: string;
  shortName: string | null;
  pictureId: string | null;
  /** What this device is called in their keys: "Anna's iPhone". */
  deviceName: string;
  /** The sign-in providers they linked: a way back in. */
  linked: { provider: string; email: string | null }[];
  /** Whether they showed they wrote their recovery words down. */
  recoveryConfirmed: boolean;
  /** The account this device opens as now. */
  active: boolean;
  addedAt: string;
  families: MyFamilyView[];
};

/** An account made: who, what this device is called, and — with a provider — the identity there that is theirs. */
export type NewAccount = { name: string; shortName?: string | null; deviceName: string; linked?: Linked | null };

/** An account just made, and its recovery words: shown this once, and kept nowhere. */
export type AccountMade = { account: AccountView; recoveryWords: string[] };

/** What one device answers of the accounts on it: the personal store, and the keys the platform keeps for them. */
export interface PersonalApi {
  accounts(): Promise<AccountView[]>;
  /** A person made, on this device: their key, their recovery key, and the chain's first statements, signed. Opened as, from now. */
  create(input: NewAccount): Promise<AccountMade>;
  /** They showed they wrote their recovery words down. */
  confirmRecovery(personId: string): Promise<AccountView>;
  /** The account this device opens as: one of its own — signed in — or none: signed out, its key kept. */
  activate(personId: string | null): Promise<void>;
  /** An account forgotten by this device: its key too. Coming back takes the recovery words, or a provider a family takes. */
  remove(personId: string): Promise<void>;
  /** Who they are, as they prove it: to show a family. */
  chain(personId: string): Promise<Statement[]>;
  /** Something they say, signed by this device's key: their profile, a provider linked or unlinked, a key revoked. */
  say(personId: string, said: Exclude<Said, { kind: 'created' | 'key-added' }>): Promise<AccountView>;
  /** A family they are in, as it is now. */
  keepFamily(personId: string, family: MyFamilyView): Promise<AccountView>;
  /** A node's challenge, answered with this device's key: signing in. */
  answer(personId: string, challenge: Challenge): Promise<SignIn>;
}
