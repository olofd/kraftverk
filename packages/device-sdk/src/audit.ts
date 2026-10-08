/*
  The timeline: what an entry says happened, who did it, and what it is about.
*/

/**
 * What an entry on the timeline is about: a device, a node, an automation, an
 * account, or something a transport saw that is no device yet (an address).
 */
export type ResourceKind = 'device' | 'node' | 'automation' | 'account' | 'transport' | 'family' | 'home' | 'person';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['device', 'node', 'automation', 'account', 'transport', 'family', 'home', 'person'];
/** What an entry is about: a kind and an id together, or nothing — an id with no kind could not be filtered by. */
export type AuditSubject = { resourceKind?: undefined; resource?: undefined } | { resourceKind: ResourceKind; resource: string };
/**
 * What kind of thing did something (docs/PLAN-WORLD-MODEL.md §6): a person;
 * an assistant acting for one; an automation; a node of the home on its own
 * account (a follower keeping what it was given); an integration (a session
 * keeping its sign-in); kraftverk itself (a restore, a pruning).
 */
export const ACTOR_KINDS = ['person', 'agent', 'automation', 'node', 'integration', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Who did something, the same everywhere it is said — the timeline, the
 * gateway's memory of each switch, a run's start: what kind, which one, and
 * its name as it was then. Its kind is set by the code that made it, never
 * read out of a name: a name must never be able to change which rules apply.
 * `id` is null where there is no id to give yet — a person before people
 * have ids (docs/PLAN-WORLD-MODEL-WORK.md, W3).
 */
export type Actor = { readonly kind: ActorKind; readonly id: string | null; readonly name: string };

/** One actor, said: of the kind given, which its type keeps. */
export const actor = <K extends ActorKind>(kind: K, name: string, id: string | null = null): Actor & { readonly kind: K } => ({ kind, id, name });

/** kraftverk itself: what restores a file, prunes history, keeps what a node was given. */
export const SYSTEM: Actor = actor('system', 'kraftverk');

/** Whether two actors are the same one: by id where there is one, by name where not. */
export const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && (a.id !== null || b.id !== null ? a.id === b.id : a.name === b.name);

/** One line for the audit timeline, wherever the holder keeps it: who did what, to what, and what came of it. */
export type AuditRecord = {
  at: string;
  kind: string;
  actor: Actor;
  summary: string;
  detail?: unknown;
} & AuditSubject;
