import { ApiError, type Joined } from '@kraftverk/api-contract';
import { actor } from '@kraftverk/device-sdk';
import { checkChain, type Statement } from '@kraftverk/identity';

import type { Hub } from '../node/hub.ts';

/**
 * An invitation taken (docs/PLAN-WORLD-MODEL.md §8.3): someone with its
 * secret shows who they are — their chain, checked — and is a member in its
 * role from now, or waits for an admin to let them in. Asked before they
 * have any session here: the secret is what lets them ask. Wrong, used,
 * expired or taken back are one refusal, so a guess learns nothing.
 */
export function acceptInvitation(hub: Hub, input: { invitation: string; secret: string; chain: Statement[] }): Joined {
  const checked = checkChain(input.chain);
  if (!checked.ok) throw new ApiError('invalid', `That is not who you say: ${checked.problem}`);
  const person = checked.person;
  const at = new Date().toISOString();
  const family = hub.family.get()!;
  const joined = hub.db.transaction((): Joined['status'] => {
    // Who they are, kept — or a newer copy of someone the family knows — and undone with the rest if the invitation is not theirs to take.
    if (hub.people.chainOf(person.id).length <= input.chain.length) hub.people.present(input.chain);
    const invitation = hub.invitations.take(input.invitation, input.secret, person.id, at);
    if (!invitation) throw new ApiError('not-found', 'That invitation is not open: ask whoever sent it for another');
    if (hub.people.roleOf(person.id)) return 'joined';
    if (invitation.needsApproval) return 'waiting';
    hub.people.addMember(person.id, { role: invitation.role, invitedBy: invitation.madeBy, at });
    return 'joined';
  })();
  const name = person.profile.name;
  hub.audit.record({
    at,
    kind: joined === 'joined' ? 'member.joined' : 'member.waiting',
    actor: actor('person', name, person.id),
    resourceKind: 'person',
    resource: person.id,
    summary: joined === 'joined' ? `${name} joined ${family.name}` : `${name} took an invitation, and waits for an admin to let them in`,
  });
  return { family: { id: family.id, name: family.name }, status: joined };
}
