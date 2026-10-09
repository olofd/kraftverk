import { ApiError, type ApiPath, type Caller, type CallerKind, type KraftverkApi, type MemberRole } from '@kraftverk/api-contract';

/*
  One gate every call of a home passes (docs/PLAN-SCRIPTS.md §7.2): for
  each method of `KraftverkApi`, whether it reads, acts or streams, the
  least role of the person who asks, and which kinds of caller may ask at
  all. A method the interface gains does not compile until it is decided
  here. What depends on a call's arguments — oneself or someone else, a
  draft that is one's own — is still the method's to say.

  And a yes is a person's: a caller that is not one never sends a
  confirmation, and a refusal that would hand it the token a yes is sent
  back with is a plain refusal instead.
*/

/** What a call does: leaves everything as it was, changes something, or keeps answering. */
type GateKind = 'read' | 'act' | 'stream';

export type Gate = {
  readonly kind: GateKind;
  /** The least role in the family of the person who asks; null: anyone the home answers. */
  readonly least: MemberRole | null;
  /** Who may ask at all. */
  readonly callers: readonly CallerKind[];
  /** What is refused, in words, to a caller who may not: "change the family’s zones". */
  readonly what?: string;
};

const ANYONE: readonly CallerKind[] = ['person', 'agent', 'automation'];
const PEOPLE: readonly CallerKind[] = ['person'];
/** A person's or an assistant's, never a script's (docs/PLAN-SCRIPTS.md §7.3). */
const NOT_SCRIPTS: readonly CallerKind[] = ['person', 'agent'];

const read: Gate = { kind: 'read', least: null, callers: ANYONE };
const act: Gate = { kind: 'act', least: null, callers: ANYONE };
/** A person's to do, never an assistant's. */
const people = (kind: GateKind, what: string): Gate => ({ kind, least: null, callers: PEOPLE, what });
/** An admin's to do. */
const admins = (kind: GateKind, what: string): Gate => ({ kind, least: 'admin', callers: PEOPLE, what });
/** Never a script's to do: credentials, secrets, a whole file, what cannot be undone, writing scripts. */
const noScript = (kind: GateKind, what: string): Gate => ({ kind, least: null, callers: NOT_SCRIPTS, what });

const WHO_FAMILY = 'change who is in the family';

/** Every call of a home, decided. */
export const GATES = {
  deviceTypes: read,
  'devices.list': read,
  'devices.removed': read,
  'devices.get': read,
  'devices.update': act,
  'devices.setPicture': act,
  'devices.setPaused': act,
  'devices.setTrack': act,
  'devices.setPeople': people('act', 'say who a device is with'),
  'devices.place': act,
  'devices.placements': read,
  'devices.track': read,
  'devices.remove': noScript('act', 'remove a device'),
  'devices.deleteHistory': noScript('act', 'delete what a device recorded'),
  'devices.history': read,
  'devices.changes': read,
  'devices.events': read,
  'devices.command': act,
  'devices.write': act,
  'devices.query': read,
  'devices.tool': act,
  'devices.join': act,
  problems: read,
  needsYou: read,
  'setup.start': noScript('act', 'add a device'),
  'setup.startHeld': noScript('act', 'add a device'),
  'setup.again': noScript('act', 'add a device'),
  'setup.get': noScript('read', 'add a device'),
  'setup.discard': noScript('act', 'add a device'),
  'setup.sightings': noScript('read', 'add a device'),
  'setup.choose': noScript('act', 'add a device'),
  'setup.update': noScript('act', 'add a device'),
  'setup.action': noScript('act', 'add a device'),
  'setup.discover': noScript('act', 'add a device'),
  'setup.check': noScript('act', 'add a device'),
  'setup.save': noScript('act', 'add a device'),
  nearby: read,
  ignoreFound: act,
  unignoreFound: act,
  'integrations.kept': noScript('read', 'read what an integration keeps'),
  'integrations.forget': noScript('act', 'forget what an integration keeps'),
  'transports.list': read,
  'transports.diagnostic': read,
  'connections.prefer': act,
  'connections.remove': act,
  'connections.setSecrets': noScript('act', 'change a secret'),
  'connections.setExportable': noScript('act', 'let secrets leave'),
  'links.add': act,
  'links.remove': act,
  'automations.kit': read,
  'automations.draft': read,
  'automations.list': read,
  'automations.get': read,
  'automations.create': act,
  'automations.update': act,
  'automations.delete': act,
  'automations.start': noScript('act', 'start an automation, but with its own steps'),
  'automations.stop': noScript('act', 'stop an automation'),
  'automations.check': read,
  'automations.runs': read,
  'automations.runLog': read,
  'automations.rehearse': read,
  'automations.fromRecipe': read,
  'scripts.list': read,
  'scripts.get': read,
  'scripts.create': noScript('act', 'write a script'),
  'scripts.update': noScript('act', 'write a script'),
  'scripts.remove': noScript('act', 'remove a script'),
  'scripts.check': read,
  'scripts.types': read,
  'configuration.vocabulary': read,
  'configuration.schema': read,
  'configuration.export': noScript('read', 'export the family'),
  'configuration.plan': noScript('read', 'import a file'),
  'configuration.apply': noScript('act', 'import a file'),
  'configuration.elsewhere': noScript('read', 'import a file'),
  'policy.list': read,
  'policy.set': act,
  timeline: read,
  world: read,
  vocabulary: read,
  family: read,
  'homes.list': read,
  'homes.add': act,
  'homes.update': act,
  'homes.remove': act,
  'notifications.list': read,
  'notifications.read': act,
  'notifications.pushKey': noScript('read', 'wake a person’s apps'),
  'notifications.keepPushEndpoint': noScript('act', 'wake a person’s apps'),
  'notifications.forgetPushEndpoint': noScript('act', 'wake a person’s apps'),
  'notifications.test': act,
  'presence.list': read,
  'modes.list': read,
  'modes.add': act,
  'modes.update': act,
  'modes.remove': act,
  'modes.of': read,
  'modes.set': act,
  'modes.cancel': act,
  'occupancy.now': read,
  'occupancy.history': read,
  'zones.list': read,
  'zones.add': people('act', 'change the family’s zones'),
  'zones.update': people('act', 'change the family’s zones'),
  'zones.remove': people('act', 'change the family’s zones'),
  'spaces.list': read,
  'spaces.add': act,
  'spaces.update': act,
  'spaces.remove': act,
  'spaces.history': read,
  'openings.list': read,
  'openings.add': act,
  'openings.update': act,
  'openings.remove': act,
  'people.list': read,
  'people.me': read,
  'people.myChain': noScript('read', 'read a person’s keys'),
  'people.found': people('act', 'found a family'),
  'people.present': people('act', WHO_FAMILY),
  'people.update': admins('act', WHO_FAMILY),
  'people.invite': admins('act', WHO_FAMILY),
  'people.invitations': admins('read', WHO_FAMILY),
  'people.approve': admins('act', WHO_FAMILY),
  'people.revokeInvitation': admins('act', WHO_FAMILY),
  'people.erase': people('act', WHO_FAMILY),
  'people.setSharing': people('act', 'change what anyone shares'),
  'labels.list': read,
  'labels.labelled': read,
  'labels.add': act,
  'labels.update': act,
  'labels.remove': act,
  'labels.set': act,
  'media.add': act,
  'media.get': read,
  'nodes.list': read,
  'nodes.join': noScript('act', 'join a node'),
  'nodes.forget': noScript('act', 'forget a node'),
  'held.readings': noScript('act', 'speak for a node'),
  'held.store': noScript('read', 'speak for a node'),
  'held.keep': noScript('act', 'speak for a node'),
  'held.audit': noScript('act', 'speak for a node'),
  live: { kind: 'stream', least: null, callers: NOT_SCRIPTS, what: 'follow the home as it changes' },
} as const satisfies { readonly [P in ApiPath<KraftverkApi>]: Gate };

const RANK: Readonly<Record<MemberRole, number>> = { child: 0, member: 1, admin: 2 };
const AN: Readonly<Record<MemberRole, string>> = { child: 'a member', member: 'a member', admin: 'an admin' };
const WHO: Readonly<Record<CallerKind, string>> = { person: 'A person', agent: 'An assistant', automation: 'A script' };

/** Whether a call's argument carries a yes: a token sent back as `confirmation`. */
const saysYes = (arg: unknown): boolean => typeof arg === 'object' && arg !== null && (arg as { confirmation?: unknown }).confirmation !== undefined;

/**
 * `api` behind its gates, for `caller`: every method refused before it runs
 * to whoever may not call it; for a caller that is not a person, every yes.
 * `roleOf`: a person's role in the family, or null for one not in it.
 */
export function gated(api: KraftverkApi, caller: Caller, roleOf: (personId: string) => MemberRole | null): KraftverkApi {
  /** Whether who asks is at least `least` in the family. A role is a person's; a server's account that names no person yet is its administrator, as it always was. */
  const atLeast = (least: MemberRole): boolean => {
    // A script is held to the role of the person it acts for: nobody's, and it has none.
    const person = caller.kind === 'person' ? caller.id : caller.kind === 'automation' ? caller.for : null;
    if (caller.kind === 'agent' || (caller.kind === 'automation' && !person)) return false;
    if (!person) return true;
    const role = roleOf(person);
    return role !== null && RANK[role] >= RANK[least];
  };

  const refusal = (gate: Gate, args: readonly unknown[]): ApiError | null => {
    if (!gate.callers.includes(caller.kind)) return new ApiError('forbidden', `${WHO[caller.kind]} cannot ${gate.what ?? 'do that'}`);
    if (gate.least && !atLeast(gate.least)) return new ApiError('forbidden', `Only ${AN[gate.least]} of the family can do that`);
    if (caller.kind !== 'person' && args.some(saysYes)) return new ApiError('forbidden', 'Only a person can say yes to this, in the app');
    return null;
  };

  /** A refusal that asks for a yes, to a caller who cannot give one: a refusal, with no token to send back. */
  const noYes = (error: unknown): never => {
    if (error instanceof ApiError && error.kind === 'needs-yes') throw new ApiError('forbidden', `${error.message} Only a person can say yes to this, in the app.`);
    throw error;
  };

  const guard = (path: ApiPath<KraftverkApi>, fn: (...args: unknown[]) => unknown, owner: object) => {
    const gate: Gate = GATES[path];
    if (gate.kind === 'stream')
      return (...args: unknown[]) => {
        const refused = refusal(gate, args);
        if (refused) throw refused;
        return fn.apply(owner, args);
      };
    return async (...args: unknown[]) => {
      const refused = refusal(gate, args);
      if (refused) throw refused;
      if (caller.kind === 'person') return fn.apply(owner, args);
      try {
        return await fn.apply(owner, args);
      } catch (error) {
        return noYes(error);
      }
    };
  };

  const wrap = (node: object, prefix: string): object =>
    Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        const path = `${prefix}${key}`;
        if (typeof value === 'function') {
          if (!Object.hasOwn(GATES, path)) throw new Error(`No gate for "${path}": every call of a home is decided in gate.ts`);
          return [key, guard(path as ApiPath<KraftverkApi>, value as (...args: unknown[]) => unknown, node)];
        }
        return [key, wrap(value as object, `${path}.`)];
      })
    );

  return wrap(api, '') as KraftverkApi;
}
