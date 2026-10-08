import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';
import { isTimeZone } from '@kraftverk/device-sdk';
import { checkChain } from '@kraftverk/identity';

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
        const person = refusing(() => hub.people.present(chain));
        record('person.changed', 'person', person.id, `${person.name}'s profile changed`);
        return person;
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
