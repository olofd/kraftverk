import type { Statement } from '@kraftverk/identity';

/*
  People, as a family answers them (docs/PLAN-WORLD-MODEL.md §8.2, §8.3,
  §10): who they are — as their own signed chain says — and what this
  family calls them, their colour on its map, and their role in it.
*/

export type MemberRole = 'admin' | 'member' | 'child';

/**
 * What a person shares with the family of where they are
 * (docs/PLAN-WORLD-MODEL.md §11.1): `precise`, where they are on the map;
 * `places`, which home, zone or room, never coordinates; `home-away`, only
 * whether they are at one of its homes; `off`, nothing — automations cannot
 * see them either.
 */
export type SharingLevel = 'precise' | 'places' | 'home-away' | 'off';

/**
 * What a person shares, and for how long their stays are kept: their own to
 * set — an admin's for a child. Paused, it is `off` until then, and its
 * level after.
 */
export type Sharing = {
  level: SharingLevel;
  /** Days their stays are kept: 1 to 366. */
  keepDays: number;
  /** Shared again from then; null: not paused. */
  pausedUntil: string | null;
  /** What it is now: `off` while paused. */
  now: SharingLevel;
  /** Who set it last, and when; null: never set — the family's default. */
  setBy: string | null;
  changedAt: string | null;
};

/** What a person changes of their sharing; an admin a child's. */
export type SharingChanges = { level?: SharingLevel; keepDays?: number; pausedUntil?: string | null };

/** A person in a family. */
export type PersonView = {
  id: string;
  name: string;
  /** What screens call them: this family's nickname, their own short name, or their name. */
  shownAs: string;
  shortName: string | null;
  pictureId: string | null;
  /** Kept by an admin, with no device of their own yet: a small child. */
  managedBy: string | null;
  /** The sign-in providers they linked, by id. */
  linked: string[];
  /** Their keys now, by the device each is on; a recovery key's name is null. */
  keys: { id: string; kind: 'device' | 'recovery'; deviceName: string | null; addedAt: string; vouched: string | null }[];
  /** In the family now; null for one who left, or was never in it. */
  member: { role: MemberRole; nickname: string | null; color: string; joinedAt: string; sharing: Sharing } | null;
  updatedAt: string;
};

/** A family founded by the first person in it, with its first home: what a new account does on its own device. */
export type FoundFamily = {
  /** The founder, as their chain says: checked, and kept. */
  chain: Statement[];
  name: string;
  kind: 'family' | 'household' | 'friends' | 'other';
  /** Its first home: what it is called, and its clock. */
  home: { name: string; type: 'house' | 'apartment' | 'cabin' | 'boat' | 'caravan' | 'office' | 'other'; timeZone: string };
  /** What the founder shares of where they are; the family's default when not said. */
  sharing?: SharingLevel;
};

/** An invitation into the family, as its admins see it: never its secret, which is answered once, when it is made. */
export type InvitationView = {
  id: string;
  role: MemberRole;
  /** Who it is meant for, as the inviter said; null: anyone with it. */
  forName: string | null;
  needsApproval: boolean;
  madeBy: string;
  madeAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
  /** Open to take; taken and in; taken and waiting for an admin; expired; taken back. */
  status: 'open' | 'used' | 'waiting' | 'expired' | 'revoked';
};

/** An invitation made: what it is, and its secret — this once. With the address it is taken at, it is the code a person is given. */
export type InvitationMade = { invitation: InvitationView; secret: string };

/** An invitation asked for. */
export type InvitationInput = { role: MemberRole; forName?: string | null; needsApproval: boolean; days?: number };

/** An invitation taken: the family it is into, and whether its person is in or waits for an admin. */
export type Joined = { family: { id: string; name: string }; status: 'joined' | 'waiting' };

/** What an admin changes of a member: their role, what the family calls them, their colour. */
export type MemberChanges = { role?: MemberRole; nickname?: string | null; color?: string };
