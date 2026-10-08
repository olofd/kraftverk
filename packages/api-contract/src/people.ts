import type { Statement } from '@kraftverk/identity';

/*
  People, as a family answers them (docs/PLAN-WORLD-MODEL.md §8.2, §8.3,
  §10): who they are — as their own signed chain says — and what this
  family calls them, their colour on its map, and their role in it.
*/

export type MemberRole = 'admin' | 'member' | 'child';

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
  member: { role: MemberRole; nickname: string | null; color: string; joinedAt: string } | null;
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
};

/** What an admin changes of a member: their role, what the family calls them, their colour. */
export type MemberChanges = { role?: MemberRole; nickname?: string | null; color?: string };
