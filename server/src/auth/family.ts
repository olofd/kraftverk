import { newId } from '@kraftverk/device-sdk';
import type { Hub } from '@kraftverk/hub';

import type { Accounts } from './accounts.ts';
import type { createAuth } from './routes.ts';

/*
  Signing in at this server, as the family it serves knows people
  (docs/PLAN-WORLD-MODEL.md §10.5): a login names a person in the family;
  a device signs in by a key a member holds; a login's person is claimed
  by their own chain. The family's database may be set aside and started
  again from its kept file while this node's logins stay — so every login's
  person is made again, keyless, an admin, when the family no longer has
  them.
*/

/** Every server account is an administrator, as it always was: a person a login is made for is one. */
const ROLE = 'admin';

/** The family, as signing in at this server asks it. */
export function familyForAuth(hub: Hub): Parameters<typeof createAuth>[0]['family'] {
  const now = () => new Date().toISOString();
  return {
    nodeId: () => hub.self.id,
    newPerson: (name) => {
      const id = newId('p');
      hub.people.ensureKeyless(id, name, now());
      hub.people.addMember(id, { role: ROLE, invitedBy: null, at: now() });
      return id;
    },
    nameOf: (personId) => hub.people.get(personId)?.shownAs ?? null,
    keyHolder: (keyId) => {
      const holder = hub.people.keyHolder(keyId);
      return holder && hub.people.roleOf(holder.personId) ? holder : null;
    },
    claim: (personId, chain) => hub.people.claim(personId, chain),
    leave: (personId) => {
      if (hub.people.roleOf(personId)) hub.people.leave(personId, now());
    },
  };
}

/** Every login's person in the family again: one its database no longer has — set aside, started from its kept file — made again, keyless, an admin. */
export function keepLoginsPeople(hub: Hub, accounts: Accounts): void {
  for (const login of accounts.listUsers()) {
    hub.people.ensureKeyless(login.personId, login.username, login.createdAt);
    if (!hub.people.roleOf(login.personId)) hub.people.addMember(login.personId, { role: ROLE, invitedBy: null, at: new Date().toISOString() });
  }
}
