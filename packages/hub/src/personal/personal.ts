import { ApiError, type AccountView, type PersonalApi } from '@kraftverk/api-contract';
import { newId } from '@kraftverk/device-sdk';
import { addKey, answer, checkChain, createPerson, keyId, newRecoveryWords, recoveryKey, say, type SigningKey, type Statement } from '@kraftverk/identity';
import type { MyAccount, PersonalStore } from '@kraftverk/store';

/*
  The accounts on a device (docs/PLAN-WORLD-MODEL.md §10.6), as the app asks
  them — before any family, and beside every one. An account works with no
  server, made with a sign-in provider or as a local account: either way a
  person id, a key the platform keeps on this device, a recovery key made
  from twelve words shown once, and the chain's first statements, signed.
  The same everywhere the app runs; each platform brings its keys.
*/

/** Where a platform keeps the accounts' keys: by the person's id, their private halves never leaving it. */
export type DeviceKeys = {
  /** A new key for a person: a browser's, not extractable; a phone's, in its secure store. */
  make(personId: string): Promise<SigningKey>;
  get(personId: string): Promise<SigningKey | null>;
  forget(personId: string): Promise<void>;
};

export type PersonalDeps = { store: PersonalStore; keys: DeviceKeys; now?: () => string };

export function personalApi(deps: PersonalDeps): PersonalApi {
  const { store, keys } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const viewOf = (account: MyAccount): AccountView => {
    const checked = checkChain(account.chain);
    if (!checked.ok) throw new Error(`This device's copy of an account does not check: ${checked.problem}`);
    const { profile, linked } = checked.person;
    return {
      personId: account.personId,
      name: profile.name,
      shortName: profile.shortName,
      pictureId: profile.pictureId,
      deviceName: account.deviceName,
      linked: linked.map((each) => ({ provider: each.provider, email: each.email })),
      recoveryConfirmed: account.recoveryConfirmedAt !== null,
      active: account.active,
      addedAt: account.addedAt,
      families: store.families(account.personId),
    };
  };
  const accountOf = (personId: string): MyAccount => {
    const account = store.account(personId);
    if (!account) throw new ApiError('not-found', 'There is no such account on this device');
    return account;
  };
  /** This device's key for an account; refused when it has gone — the platform forgot it. */
  const keyOf = async (account: MyAccount): Promise<SigningKey> => {
    const key = await keys.get(account.personId);
    if (!key || keyId(key.publicJwk) !== account.keyId) throw new ApiError('invalid', 'This device no longer holds this account’s key: come back with your recovery words');
    return key;
  };
  const text = (value: string | null | undefined, most: number, what: string): string => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length < 1 || trimmed.length > most) throw new ApiError('invalid', `${what} is 1 to ${most} characters`);
    return trimmed;
  };

  return {
    accounts: async () => store.accounts().map(viewOf),

    async create(input) {
      const name = text(input.name, 100, 'A name');
      const shortName = input.shortName ? text(input.shortName, 30, 'A short name') : null;
      const deviceName = text(input.deviceName, 60, 'What this device is called');
      const at = now();
      const personId = newId('p');
      const key = await keys.make(personId);
      try {
        // The recovery key: twelve words, made into a key, signed in by this device's, and proven by its own.
        const recoveryWords = newRecoveryWords();
        let chain: Statement[] = await createPerson({ id: personId, key, deviceName, profile: { name, shortName, locale: null, pictureId: null }, at });
        chain = await addKey(chain, { signer: key, key: recoveryKey(recoveryWords), keyKind: 'recovery', deviceName: null, at });
        if (input.linked) chain = await say(chain, { signer: key, at, said: { kind: 'linked', linked: input.linked } });
        const account = store.add({ personId, chain, keyId: keyId(key.publicJwk), deviceName, addedAt: at });
        store.activate(personId);
        return { account: viewOf({ ...account, active: true }), recoveryWords };
      } catch (error) {
        // Nothing half made: the key goes with the account it was for.
        await keys.forget(personId);
        throw error;
      }
    },

    async confirmRecovery(personId) {
      accountOf(personId);
      store.confirmRecovery(personId, now());
      return viewOf(accountOf(personId));
    },

    async activate(personId) {
      if (personId !== null) await keyOf(accountOf(personId));
      store.activate(personId);
    },

    async remove(personId) {
      accountOf(personId);
      store.remove(personId);
      await keys.forget(personId);
    },

    chain: async (personId) => accountOf(personId).chain,

    async say(personId, said) {
      const account = accountOf(personId);
      const chain = await say(account.chain, { signer: await keyOf(account), at: now(), said });
      const checked = checkChain(chain);
      if (!checked.ok) throw new ApiError('invalid', checked.problem);
      store.keepChain(personId, chain);
      return viewOf(accountOf(personId));
    },

    async keepFamily(personId, family) {
      accountOf(personId);
      store.keepFamily(personId, family);
      return viewOf(accountOf(personId));
    },

    async answer(personId, challenge) {
      const account = accountOf(personId);
      return answer(challenge, personId, await keyOf(account));
    },
  };
}
