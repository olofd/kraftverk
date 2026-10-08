import { ApiError, type AccountView, type PersonalApi } from '@kraftverk/api-contract';
import { newId } from '@kraftverk/device-sdk';
import {
  addKey,
  addProvenKey,
  answer,
  base64url,
  checkChain,
  createPerson,
  fromBase64url,
  holds,
  isPublicJwk,
  keyId,
  keyProof,
  newRecoveryWords,
  recoveryKey,
  say,
  type PublicJwk,
  type SigningKey,
  type Statement,
} from '@kraftverk/identity';
import type { MyAccount, MyFamily, PersonalStore } from '@kraftverk/store';

/*
  The accounts on a device (docs/PLAN-WORLD-MODEL.md §10.6), as the app asks
  them — before any family, and beside every one. An account works with no
  server, made with a sign-in provider or as a local account: either way a
  person id, a key the platform keeps on this device, a recovery key made
  from twelve words shown once, and the chain's first statements, signed.
  A second device of one's own makes its key, and the first signs it in;
  a device that lost everything comes back with the twelve words. The same
  everywhere the app runs; each platform brings its keys.
*/

/** Where a platform keeps this device's keys, each by its own id: their private halves never leave it. */
export type DeviceKeys = {
  /** A new key: a browser's, not extractable; a phone's, in its secure store. */
  make(): Promise<{ id: string; key: SigningKey }>;
  get(id: string): Promise<SigningKey | null>;
  forget(id: string): Promise<void>;
};

export type PersonalDeps = { store: PersonalStore; keys: DeviceKeys; now?: () => string };

/** A code one device shows another, as text: base64url of its JSON. */
const encode = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));
const decode = <T>(code: string): T | null => {
  const bytes = fromBase64url(code.trim());
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
};

/** What a new device shows the first: its key's public half, what it is called, and its proof it holds the key. */
type LinkCode = { k: PublicJwk; n: string; p: string };
/** What the first device answers with: who the person is now — their chain, with the new key — and the families on servers they are in. */
type WelcomeCode = { c: Statement[]; f: MyFamily[] };

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
      linked: linked.map((each) => ({ provider: each.provider, subject: each.subject, email: each.email })),
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
    const key = await keys.get(account.keyId);
    if (!key || keyId(key.publicJwk) !== account.keyId) throw new ApiError('invalid', 'This device no longer holds this account’s key: come back with your recovery words');
    return key;
  };
  const text = (value: string | null | undefined, most: number, what: string): string => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length < 1 || trimmed.length > most) throw new ApiError('invalid', `${what} is 1 to ${most} characters`);
    return trimmed;
  };
  /** An account kept on this device from a chain it holds a key of: a second device, or one come back with its words. */
  const keep = (chain: Statement[], deviceKey: string, deviceName: string, families: readonly MyFamily[]): AccountView => {
    const checked = checkChain(chain);
    if (!checked.ok) throw new ApiError('invalid', `That is not who you are: ${checked.problem}`);
    if (!holds(checked.person, deviceKey)) throw new ApiError('invalid', 'That account does not hold this device’s key');
    if (store.account(checked.person.id)) throw new ApiError('conflict', 'That account is on this device already');
    const at = now();
    store.add({ personId: checked.person.id, chain, keyId: deviceKey, deviceName, addedAt: at });
    // Its recovery words were written down when it was made: this device is no reason to show them again.
    store.confirmRecovery(checked.person.id, at);
    for (const family of families) if (family.master === 'server') store.keepFamily(checked.person.id, family);
    return viewOf(accountOf(checked.person.id));
  };

  return {
    // One whose copy does not check — written by a kraftverk whose statements were made otherwise — is left out and said, never the app lost for it.
    accounts: async () =>
      store.accounts().flatMap((account) => {
        try {
          return [viewOf(account)];
        } catch (error) {
          console.warn(`[accounts] ${account.personId} is left out: ${(error as Error).message}`);
          return [];
        }
      }),

    async create(input) {
      const name = text(input.name, 100, 'A name');
      const shortName = input.shortName ? text(input.shortName, 30, 'A short name') : null;
      const deviceName = text(input.deviceName, 60, 'What this device is called');
      const at = now();
      const personId = newId('p');
      const { id, key } = await keys.make();
      try {
        // The recovery key: twelve words, made into a key, signed in by this device's, and proven by its own.
        const recoveryWords = newRecoveryWords();
        let chain: Statement[] = await createPerson({ id: personId, key, deviceName, profile: { name, shortName, locale: null, pictureId: null }, at });
        chain = await addKey(chain, { signer: key, key: recoveryKey(recoveryWords), keyKind: 'recovery', deviceName: null, at });
        if (input.linked) chain = await say(chain, { signer: key, at, said: { kind: 'linked', linked: input.linked } });
        const account = store.add({ personId, chain, keyId: id, deviceName, addedAt: at });
        return { account: viewOf(account), recoveryWords };
      } catch (error) {
        // Nothing half made: the key goes with the account it was for.
        await keys.forget(id);
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
      const account = accountOf(personId);
      store.remove(personId);
      await keys.forget(account.keyId);
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

    async leaveFamily(personId, familyId) {
      accountOf(personId);
      store.leaveFamily(personId, familyId);
      return viewOf(accountOf(personId));
    },

    async answer(personId, challenge) {
      const account = accountOf(personId);
      return answer(challenge, personId, await keyOf(account));
    },

    async linkCode(deviceName) {
      const name = text(deviceName, 60, 'What this device is called');
      const { id, key } = await keys.make();
      return { keyId: id, code: encode({ k: key.publicJwk, n: name, p: await keyProof(key) } satisfies LinkCode) };
    },

    async addDevice(personId, code) {
      const account = accountOf(personId);
      const link = decode<LinkCode>(code);
      if (!link || !isPublicJwk(link.k) || typeof link.n !== 'string' || typeof link.p !== 'string') throw new ApiError('invalid', 'That is not the code the other device shows');
      let chain: Statement[];
      try {
        chain = await addProvenKey(account.chain, { signer: await keyOf(account), key: link.k, proof: link.p, keyKind: 'device', deviceName: text(link.n, 60, 'What that device is called'), at: now() });
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
      }
      store.keepChain(personId, chain);
      return { account: viewOf(accountOf(personId)), chain, welcome: encode({ c: chain, f: store.families(personId).filter((family) => family.master === 'server') } satisfies WelcomeCode) };
    },

    async adopt(deviceKey, welcome) {
      const code = decode<WelcomeCode>(welcome);
      if (!code || !Array.isArray(code.c)) throw new ApiError('invalid', 'That is not the code your other device shows');
      const key = await keys.get(deviceKey);
      if (!key) throw new ApiError('invalid', 'This device’s key for it has gone: start again');
      const added = code.c.find((statement) => statement.said.kind === 'key-added' && keyId(statement.said.key) === deviceKey);
      const name = added?.said.kind === 'key-added' ? (added.said.deviceName ?? 'This device') : 'This device';
      return keep(code.c, deviceKey, name, Array.isArray(code.f) ? code.f : []);
    },

    forgetKey: async (deviceKey) => {
      if (!store.accounts().some((account) => account.keyId === deviceKey)) await keys.forget(deviceKey);
    },

    async recoveryAnswer(words, challenge, personId) {
      return answer(challenge, personId, recoveryKey(words));
    },

    async recover(input) {
      const deviceName = text(input.deviceName, 60, 'What this device is called');
      const recovery = recoveryKey(input.words);
      const { id, key } = await keys.make();
      try {
        const chain = await addKey(input.chain, { signer: recovery, key, keyKind: 'device', deviceName, at: now() });
        return { account: keep(chain, id, deviceName, input.families), chain };
      } catch (error) {
        await keys.forget(id);
        throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
      }
    },
  };
}
