/*
  The timeline: what an entry says happened, who did it, and what it is about.
*/

/**
 * What an entry on the timeline is about: a device, a node, an automation, an
 * account, or something a transport saw that is no device yet (an address).
 */
export type ResourceKind = 'device' | 'node' | 'automation' | 'account' | 'transport';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['device', 'node', 'automation', 'account', 'transport'];
/** What an entry is about: a kind and an id together, or nothing — an id with no kind could not be filtered by. */
export type AuditSubject = { resourceKind?: undefined; resource?: undefined } | { resourceKind: ResourceKind; resource: string };
/** One line for the audit timeline, wherever the holder keeps it: who did what, to what, and what came of it. */
export type AuditRecord = {
  at: string;
  kind: string;
  actor: string;
  summary: string;
  detail?: unknown;
} & AuditSubject;
