import { ApiError, type Caller, type KraftverkApi, type SharingLevel } from '@kraftverk/api-contract';
import { isTimeZone } from '@kraftverk/device-sdk';
import { checkChain } from '@kraftverk/identity';
import { SOMEONE_WHO_LEFT } from '@kraftverk/store';

import { forgetCarriedTrails } from '../presence/levels.ts';

import type { Hub } from '../node/hub.ts';
import { scopeOf } from './scope.ts';

/*
  A family's people (docs/PLAN-WORLD-MODEL.md §8.2, §8.3), as it answers
  them: who is in it, as each one's own chain says; the first person in an
  empty family founding it as its admin, with its name and first home; a
  newer copy of oneself taken; and an admin changing what the family calls
  a member, their colour and their role. On the timeline as the family's.
*/

const COLOR = /^#[0-9a-f]{6}$/;
const SHARING_LEVELS: readonly SharingLevel[] = ['precise', 'places', 'home-away', 'off'];
/** What a person shares, said on the timeline: never where they are. */
const SHARING_WORDS: Record<SharingLevel, string> = {
  precise: 'shares where they are on the map',
  places: 'shares which place they are at',
  'home-away': 'shares only whether they are home',
  off: 'shares nothing of where they are',
};
const HOME_TYPES = ['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other'];

/** The store's refusal, said as the family's. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
  }
};

export function peopleApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'people'> {
  const { record } = scopeOf(hub, caller);
  /** Who asks, by their person id: none for an assistant, or a server's account not yet anyone's (W3.7). */
  const me = caller.kind === 'person' ? (caller.id ?? null) : null;
  /** An admin's to do. A server's account that names no person is every server account is: an administrator. */
  const asAdmin = () => {
    if (caller.kind === 'agent') throw new ApiError('forbidden', 'An assistant cannot change who is in the family');
    if (me !== null && hub.people.roleOf(me) !== 'admin') throw new ApiError('forbidden', 'Only an admin of the family can do that');
  };
  const personOf = (id: string) => {
    const person = hub.people.get(id);
    if (!person) throw new ApiError('not-found', 'No such person');
    return person;
  };

  return {
    people: {
      list: async () => hub.people.members(),

      me: async () => (me ? hub.people.get(me) : null),

      myChain: async () => (me ? hub.people.chainOf(me) : []),

      async found(input) {
        if (hub.people.members().length) throw new ApiError('conflict', 'This family has people in it already: ask one of its admins to invite you');
        const checked = checkChain(input.chain);
        if (!checked.ok) throw new ApiError('invalid', `That is not who you say: ${checked.problem}`);
        if (caller.kind !== 'person' || (me !== null && me !== checked.person.id)) throw new ApiError('forbidden', 'A family is founded by the person it is for');
        const name = input.name.trim();
        if (!(name.length >= 1 && name.length <= 60)) throw new ApiError('invalid', 'A family’s name is 1 to 60 characters');
        if (!['family', 'household', 'friends', 'other'].includes(input.kind)) throw new ApiError('invalid', 'A family is a family, a household, friends, or something else');
        const homeName = input.home.name.trim();
        if (!(homeName.length >= 1 && homeName.length <= 60)) throw new ApiError('invalid', 'A home’s name is 1 to 60 characters');
        if (!HOME_TYPES.includes(input.home.type)) throw new ApiError('invalid', `A home is one of: ${HOME_TYPES.join(', ')}`);
        if (!isTimeZone(input.home.timeZone)) throw new ApiError('invalid', `"${input.home.timeZone}" is not a time zone`);
        const at = new Date().toISOString();
        const founder = refusing(() =>
          hub.db.transaction(() => {
            const person = hub.people.present(input.chain);
            hub.people.addMember(person.id, { role: 'admin', invitedBy: null, at });
            if (input.sharing && SHARING_LEVELS.includes(input.sharing)) hub.people.setSharing(person.id, { level: input.sharing }, person.id, at);
            hub.family.update({ name, kind: input.kind });
            hub.family.foundedBy(person.id);
            const first = hub.places.first()!;
            hub.places.updateHome(first.id, { name: homeName, type: input.home.type, timeZone: input.home.timeZone });
            return hub.people.get(person.id)!;
          })()
        );
        record('family.founded', 'family', hub.family.get()!.id, `${founder.name} founded ${name}`, { person: founder.id });
        return founder;
      },

      async present(chain) {
        const checked = checkChain(chain);
        if (!checked.ok) throw new ApiError('invalid', `That is not who you say: ${checked.problem}`);
        // Oneself, newer; an admin may bring anyone's.
        if (me !== checked.person.id) asAdmin();
        const was = hub.people.get(checked.person.id);
        const person = refusing(() => hub.people.present(chain));
        // Said as what changed: a device signed in or let go, their profile, or what they linked.
        const keys = new Set(was?.keys.map((key) => key.id) ?? []);
        const added = person.keys.filter((key) => !keys.has(key.id));
        const gone = (was?.keys ?? []).filter((key) => !person.keys.some((now) => now.id === key.id));
        const said = [
          ...added.map((key) => (key.kind === 'recovery' ? 'new recovery words' : `signed in ${key.deviceName ?? 'a device'}`)),
          ...gone.map((key) => (key.kind === 'recovery' ? 'gave up old recovery words' : `let go of ${key.deviceName ?? 'a device'}`)),
          ...(was && (was.name !== person.name || was.shortName !== person.shortName || was.pictureId !== person.pictureId) ? ['changed their profile'] : []),
        ];
        record('person.changed', 'person', person.id, `${person.name} ${said.length ? said.join(', ') : 'showed who they are'}`);
        return person;
      },

      async invite(input) {
        asAdmin();
        if (!['admin', 'member', 'child'].includes(input.role)) throw new ApiError('invalid', 'A member is an admin, a member, or a child');
        const forName = input.forName?.trim() || null;
        if (forName && forName.length > 60) throw new ApiError('invalid', 'Who it is for is at most 60 characters');
        const days = input.days ?? 7;
        if (!(Number.isInteger(days) && days >= 1 && days <= 30)) throw new ApiError('invalid', 'An invitation lasts 1 to 30 days');
        const by = me ?? hub.people.members().find((each) => each.member?.role === 'admin')?.id;
        if (!by) throw new ApiError('forbidden', 'Only a person in the family can invite someone');
        const at = new Date();
        const made = hub.invitations.make({ role: input.role, forName, needsApproval: input.needsApproval, madeBy: by, at: at.toISOString(), expiresAt: new Date(at.getTime() + days * 86_400_000).toISOString() });
        record('invitation.made', 'family', hub.family.get()!.id, `Invited ${forName ?? 'someone'} to join as ${input.role === 'admin' ? 'an admin' : input.role === 'child' ? 'a child' : 'a member'}${input.needsApproval ? ', an admin letting them in' : ''}`, { invitation: made.invitation.id });
        return made;
      },

      async invitations() {
        asAdmin();
        return hub.invitations.list();
      },

      async approve(invitationId) {
        asAdmin();
        const invitation = hub.invitations.get(invitationId);
        if (!invitation || invitation.status !== 'waiting' || !invitation.usedBy) throw new ApiError('not-found', 'No one waits on that invitation');
        const at = new Date().toISOString();
        const person = refusing(() =>
          hub.db.transaction(() => {
            hub.invitations.approve(invitationId, me ?? invitation.madeBy, at);
            return hub.people.addMember(invitation.usedBy!, { role: invitation.role, invitedBy: invitation.madeBy, at });
          })()
        );
        record('member.joined', 'person', person.id, `${person.name} was let in`);
        return person;
      },

      async revokeInvitation(invitationId) {
        asAdmin();
        if (!hub.invitations.get(invitationId)) throw new ApiError('not-found', 'No such invitation');
        const invitation = hub.invitations.revoke(invitationId, new Date().toISOString())!;
        record('invitation.revoked', 'family', hub.family.get()!.id, `Took back an invitation${invitation.forName ? ` for ${invitation.forName}` : ''}`);
        return invitation;
      },

      async erase(id) {
        const person = personOf(id);
        if (me !== id) asAdmin();
        if (!person.member) throw new ApiError('not-found', 'They are not in the family');
        const names = [person.name, person.shortName, person.member.nickname, person.shownAs].filter((name): name is string => Boolean(name));
        refusing(() => hub.people.erase(id, new Date().toISOString()));
        record('person.erased', 'person', id, me === id ? `${SOMEONE_WHO_LEFT} the family, and asked to be forgotten` : `${SOMEONE_WHO_LEFT} the family, forgotten by an admin`);
        // After the line that says so: one who forgot themselves is no one there too.
        hub.audit.forget(id, names, SOMEONE_WHO_LEFT);
      },

      async setSharing(id, changes) {
        if (caller.kind === 'agent') throw new ApiError('forbidden', 'An assistant cannot change what anyone shares');
        const person = personOf(id);
        if (!person.member) throw new ApiError('not-found', 'They are not in the family');
        // Each adult their own; an admin a child's — and a child never their own.
        const child = person.member.role === 'child';
        const mine = me === id;
        if (child ? !(me === null || hub.people.roleOf(me) === 'admin') : !mine && me !== null) throw new ApiError('forbidden', child ? 'An admin sets what a child shares' : 'What a person shares is their own to say');
        if (changes.level !== undefined && !SHARING_LEVELS.includes(changes.level)) throw new ApiError('invalid', `What is shared is one of: ${SHARING_LEVELS.join(', ')}`);
        if (changes.keepDays !== undefined && !(Number.isInteger(changes.keepDays) && changes.keepDays >= 1 && changes.keepDays <= 366)) throw new ApiError('invalid', 'Stays are kept for 1 day to a year');
        if (changes.pausedUntil != null && !(Number.isFinite(Date.parse(changes.pausedUntil)) && Date.parse(changes.pausedUntil) > Date.now())) throw new ApiError('invalid', 'A pause ends later than now');
        const by = me ?? hub.people.members().find((each) => each.member?.role === 'admin')?.id ?? id;
        const sharing = hub.people.setSharing(id, changes, by, new Date().toISOString());
        // Less than where they are: the trails of what they carry are let go.
        forgetCarriedTrails(hub, id);
        const said = [
          ...(changes.level !== undefined ? [SHARING_WORDS[changes.level]] : []),
          ...(changes.keepDays !== undefined ? [`keeps where they have been ${changes.keepDays === 1 ? '1 day' : `${changes.keepDays} days`}`] : []),
          ...(changes.pausedUntil !== undefined ? [changes.pausedUntil ? 'paused sharing for a while' : 'shares again'] : []),
        ];
        record('person.sharing', 'person', id, `${person.shownAs} ${said.join(', ') || 'kept what they share'}`, { level: sharing.level, keepDays: sharing.keepDays, paused: sharing.pausedUntil !== null });
        return hub.people.get(id)!;
      },

      async update(id, changes) {
        asAdmin();
        const was = personOf(id);
        if (!was.member) throw new ApiError('not-found', 'They are not in the family');
        if (changes.color !== undefined && !COLOR.test(changes.color)) throw new ApiError('invalid', 'A colour is "#rrggbb", in lowercase');
        if (changes.nickname !== undefined && changes.nickname !== null && !(changes.nickname.trim().length >= 1 && changes.nickname.trim().length <= 30)) throw new ApiError('invalid', 'A nickname is 1 to 30 characters');
        if (changes.role !== undefined && !['admin', 'member', 'child'].includes(changes.role)) throw new ApiError('invalid', 'A member is an admin, a member, or a child');
        const person = refusing(() => hub.people.updateMember(id, { ...changes, ...(typeof changes.nickname === 'string' ? { nickname: changes.nickname.trim() } : {}) }));
        if (changes.role !== undefined && changes.role !== was.member.role) record('member.role', 'person', id, `${person.name} is ${changes.role === 'admin' ? 'an admin' : changes.role === 'child' ? 'a child' : 'a member'} now`, { before: was.member.role, after: changes.role });
        else record('member.changed', 'person', id, `Changed what the family calls ${person.name}`);
        return person;
      },
    },
  };
}
