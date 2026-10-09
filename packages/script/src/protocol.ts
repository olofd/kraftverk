/*
  What a running step asks the home at once, through its one host function
  `__read`, and what each is answered with (docs/PLAN-SCRIPTS.md §6.2): one
  typed vocabulary, for the guest SDK that asks (guest/sdk.ts) and the hub
  that answers (hub/src/scripts/runner.ts). Text crosses — each a query as
  JSON, each answer as JSON — and nothing else.
*/

/** A part of a device, as a script sees it: what it is called, and what it can be told. */
export type ScriptPart = { id: string; label: string; capabilities: string[] };

/** A device as a script sees it: its key, name and type, and its parts. Never where it is. */
export type ScriptDevice = { id: string; key: string; name: string; type: string; parts: ScriptPart[] };

/** A place of the family's, as a script sees it: a home, or one of its rooms. */
export type ScriptPlace = { id: string; key: string; name: string };

/** A home, with its rooms: every space but its ground. */
export type ScriptHomeView = ScriptPlace & { rooms: ScriptPlace[] };

/** A person of the family, by their id and what the family calls them. */
export type ScriptPerson = { id: string; name: string };

/** Who of the family is at a place, as far as each shares — and who might be. Null: the place is not there. */
export type ScriptWhoAt = { at: string[]; unknown: string[] } | null;

/** Each question a step may ask, and the type of its answer. */
export type ScriptReads = {
  /** Every device the home has now. */
  devices: { query: { devices: true }; answer: ScriptDevice[] };
  /** One reading of one device now, by its key; null when it has not said. */
  reading: { query: { reading: [deviceId: string, key: string] }; answer: unknown };
  /** Every reading of one device now, by key. */
  readings: { query: { readings: string }; answer: Record<string, unknown> };
  /** The family's people. */
  people: { query: { people: true }; answer: ScriptPerson[] };
  /** The family's homes, each with its rooms. */
  homes: { query: { homes: true }; answer: ScriptHomeView[] };
  /** This run's home: its automation's, or the family's first. */
  home: { query: { home: true }; answer: string | null };
  /** Who is at a home or a room. */
  at: { query: { at: [kind: 'home' | 'space', id: string] }; answer: ScriptWhoAt };
  /** Whether anyone is in a home or a room; null when it cannot be told. */
  occupied: { query: { occupied: [kind: 'home' | 'space', id: string] }; answer: boolean | null };
  /** A home's mode on an axis now, by key; null when none is set. */
  mode: { query: { mode: [homeId: string, axis: 'presence' | 'day'] }; answer: string | null };
  /** A home's variables now, by key: as set, or what each starts as. */
  variables: { query: { variables: string }; answer: Record<string, unknown> };
};

/** A question a step may ask. */
export type ScriptRead = ScriptReads[keyof ScriptReads]['query'];

/** The answer a question gets. */
export type ScriptAnswer<Q extends ScriptRead> = { [K in keyof ScriptReads]: Q extends ScriptReads[K]['query'] ? ScriptReads[K]['answer'] : never }[keyof ScriptReads];
