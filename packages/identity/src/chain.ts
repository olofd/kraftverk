import { base64url, canonical, fromBase64url, hashOf, utf8, type Json } from './bytes.ts';
import { isPublicJwk, keyId, verify, type KeyKind, type PublicJwk, type SigningKey } from './keys.ts';

/*
  A person, as kraftverk knows them (docs/PLAN-WORLD-MODEL.md §10): a stable
  id, and a chain of statements, each signed by a key the person holds at
  that point. The first is signed by the first key, and says who they are;
  every key added after is signed in by one they had, and proves it holds
  its own; a key revoked signs nothing after. Whoever is shown a chain
  checks it, so no one can say they are someone else: they cannot sign as
  them. The id is not a key's: keys come and go under it.
*/

/** What a person says of themselves. */
export type Profile = {
  /** Whole, as they write it. */
  name: string;
  /** What screens and speakers call them; null: their name. */
  shortName: string | null;
  /** The language they are told things in; null: their family's. */
  locale: string | null;
  /** A picture of them, by its content's hash; null: none. */
  pictureId: string | null;
};

/** An identity elsewhere that is theirs: at a sign-in provider, by the subject it gives this app. */
export type Linked = { provider: string; subject: string; email: string | null };

const PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;

/** What a statement says. */
export type Said =
  | { kind: 'created'; key: PublicJwk; deviceName: string | null; profile: Profile }
  /** A key added — a second device's, the recovery key — with its own signature over itself (`keyProof`): proof it is held. */
  | { kind: 'key-added'; key: PublicJwk; keyKind: KeyKind; deviceName: string | null; proof: string }
  | { kind: 'key-revoked'; keyId: string }
  | { kind: 'profile'; profile: Profile }
  | { kind: 'linked'; linked: Linked }
  | { kind: 'unlinked'; provider: Linked['provider'] };

/** One link of the chain: what was said, when, by which key, after which statement. */
export type Statement = {
  person: string;
  /** Its place in the chain, from 0. */
  seq: number;
  /** The hash of the statement before it; null for the first. */
  prev: string | null;
  at: string;
  /** The id of the key that signed it. */
  signer: string;
  said: Said;
  /** The signer's, over the statement without it, as base64url. */
  signature: string;
};

export type PersonKey = { id: string; kind: KeyKind; publicJwk: PublicJwk; deviceName: string | null; addedAt: string; addedWith: string | null; revokedAt: string | null };

/** A person as a checked chain says they are now. */
export type Person = {
  id: string;
  profile: Profile;
  keys: PersonKey[];
  linked: Linked[];
  createdAt: string;
  /** When their profile last changed: a newer copy replaces an older. */
  updatedAt: string;
  /** The last statement's hash: two copies of a person agree when this does. */
  head: string;
};

export const PERSON_ID = /^p-[0-9A-HJKMNP-TV-Z]{26}$/;

const unsigned = (statement: Omit<Statement, 'signature'>): Uint8Array => utf8(canonical(statement as unknown as Json));

/**
 * What a new key signs to prove it is held: itself. Made by the device that
 * holds it, before any statement adds it — a second device shows it to the
 * first, which signs it in.
 */
export const keyProofBytes = (key: PublicJwk): Uint8Array => utf8(canonical({ kind: 'kraftverk key', key: { crv: key.crv, kty: key.kty, x: key.x, y: key.y } }));

/** A key's proof that it is held, as base64url. */
export const keyProof = async (key: SigningKey): Promise<string> => base64url(await key.sign(keyProofBytes(key.publicJwk)));

async function signed(chain: readonly Statement[], signer: SigningKey, at: string, said: Said, person?: string): Promise<Statement> {
  const last = chain.at(-1);
  const base = { person: person ?? last!.person, seq: chain.length, prev: last ? hashOf(last as unknown as Json) : null, at, signer: keyId(signer.publicJwk), said };
  return { ...base, signature: base64url(await signer.sign(unsigned(base))) };
}

/** A person made: their id, their first key, who they say they are — the chain's first statement, signed by that key. */
export async function createPerson(input: { id: string; key: SigningKey; deviceName: string | null; profile: Profile; at: string }): Promise<Statement[]> {
  if (!PERSON_ID.test(input.id)) throw new Error('A person’s id is p- and a ULID');
  return [await signed([], input.key, input.at, { kind: 'created', key: input.key.publicJwk, deviceName: input.deviceName, profile: input.profile }, input.id)];
}

/** A key added — another device, the recovery key — signed in by one the person has, and proven by its own. */
export async function addKey(chain: readonly Statement[], input: { signer: SigningKey; key: SigningKey; keyKind: KeyKind; deviceName: string | null; at: string }): Promise<Statement[]> {
  return addProvenKey(chain, { ...input, key: input.key.publicJwk, proof: await keyProof(input.key) });
}

/** A key another device holds added, by its public half and the proof it showed: what the first device does for a second. */
export async function addProvenKey(chain: readonly Statement[], input: { signer: SigningKey; key: PublicJwk; proof: string; keyKind: KeyKind; deviceName: string | null; at: string }): Promise<Statement[]> {
  const proof = fromBase64url(input.proof);
  if (!isPublicJwk(input.key) || !proof || !verify(input.key, keyProofBytes(input.key), proof)) throw new Error('That key does not prove it is held');
  return [...chain, await signed(chain, input.signer, input.at, { kind: 'key-added', key: input.key, keyKind: input.keyKind, deviceName: input.deviceName, proof: input.proof })];
}

/** Anything else a person says: a key revoked, their profile, an identity linked or unlinked. */
export async function say(chain: readonly Statement[], input: { signer: SigningKey; at: string; said: Exclude<Said, { kind: 'created' | 'key-added' }> }): Promise<Statement[]> {
  return [...chain, await signed(chain, input.signer, input.at, input.said)];
}

/** Why a chain is not a person, at which statement; or the person it is. */
export type Checked = { ok: true; person: Person } | { ok: false; problem: string; at: number };

const isProfile = (value: unknown): value is Profile => {
  const profile = value as Profile;
  return (
    typeof profile === 'object' &&
    profile !== null &&
    typeof profile.name === 'string' &&
    profile.name.trim().length >= 1 &&
    profile.name.length <= 100 &&
    (profile.shortName === null || (typeof profile.shortName === 'string' && profile.shortName.length <= 30)) &&
    (profile.locale === null || typeof profile.locale === 'string') &&
    (profile.pictureId === null || typeof profile.pictureId === 'string')
  );
};

/**
 * A chain checked from its first statement: each in order after the one it
 * names, no earlier than it, signed by a key the person held then — not one
 * revoked — and every key added proving it is held. A person keeps at least
 * one key. Anything else, and it is no one.
 */
export function checkChain(chain: readonly Statement[]): Checked {
  const keys = new Map<string, PersonKey>();
  let profile: Profile | null = null;
  let linked: Linked[] = [];
  let createdAt = '';
  let updatedAt = '';
  const refused = (problem: string, at: number): Checked => ({ ok: false, problem, at });
  if (!chain.length) return refused('A person is at least the statement that made them', 0);
  const person = chain[0]!.person;
  if (!PERSON_ID.test(person)) return refused('A person’s id is p- and a ULID', 0);

  for (const [index, statement] of chain.entries()) {
    if (statement.person !== person) return refused('A statement about someone else', index);
    if (statement.seq !== index) return refused('Statements out of their order', index);
    if (statement.prev !== (index ? hashOf(chain[index - 1] as unknown as Json) : null)) return refused('A statement that does not follow the one before it', index);
    if (index && statement.at < chain[index - 1]!.at) return refused('A statement dated before the one it follows', index);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(statement.at)) return refused('A statement’s time is an instant in UTC', index);
    const said = statement.said;
    const signature = fromBase64url(statement.signature);
    const { signature: _signature, ...body } = statement;

    // The first: the person, made by their first key, which signs it.
    if (index === 0) {
      if (said.kind !== 'created' || !isPublicJwk(said.key) || !isProfile(said.profile)) return refused('A chain begins with the statement that made the person', 0);
      const first = keyId(said.key);
      if (statement.signer !== first || !signature || !verify(said.key, unsigned(body), signature)) return refused('The first statement is signed by the key it names', 0);
      keys.set(first, { id: first, kind: 'device', publicJwk: said.key, deviceName: said.deviceName, addedAt: statement.at, addedWith: null, revokedAt: null });
      profile = said.profile;
      createdAt = updatedAt = statement.at;
      continue;
    }

    // Every other: signed by a key the person holds now.
    const signer = keys.get(statement.signer);
    if (!signer) return refused('Signed by a key that is not the person’s', index);
    if (signer.revokedAt !== null) return refused('Signed by a key revoked before it', index);
    if (!signature || !verify(signer.publicJwk, unsigned(body), signature)) return refused('A signature that is not the signer’s', index);

    switch (said.kind) {
      case 'created':
        return refused('A person is made once', index);
      case 'key-added': {
        if (!isPublicJwk(said.key) || (said.keyKind !== 'device' && said.keyKind !== 'recovery')) return refused('A key added is a P-256 public key', index);
        const id = keyId(said.key);
        if (keys.has(id)) return refused('A key added twice', index);
        const proof = fromBase64url(said.proof);
        if (!proof || !verify(said.key, keyProofBytes(said.key), proof)) return refused('A key added that does not prove it is held', index);
        keys.set(id, { id, kind: said.keyKind, publicJwk: said.key, deviceName: said.deviceName, addedAt: statement.at, addedWith: signer.id, revokedAt: null });
        break;
      }
      case 'key-revoked': {
        const key = keys.get(said.keyId);
        if (!key || key.revokedAt !== null) return refused('A key revoked that is not one the person holds', index);
        if ([...keys.values()].filter((each) => each.revokedAt === null).length === 1) return refused('A person keeps at least one key', index);
        key.revokedAt = statement.at;
        break;
      }
      case 'profile':
        if (!isProfile(said.profile)) return refused('A profile has a name', index);
        profile = said.profile;
        updatedAt = statement.at;
        break;
      case 'linked':
        if (!PROVIDER.test(said.linked.provider) || typeof said.linked.subject !== 'string' || !said.linked.subject) return refused('An identity linked is a provider’s, by its subject', index);
        linked = [...linked.filter((each) => each.provider !== said.linked.provider), said.linked];
        break;
      case 'unlinked':
        linked = linked.filter((each) => each.provider !== said.provider);
        break;
      default:
        return refused('A statement of a kind this does not know', index);
    }
  }
  return { ok: true, person: { id: person, profile: profile!, keys: [...keys.values()], linked, createdAt, updatedAt, head: hashOf(chain.at(-1) as unknown as Json) } };
}

/** Whether a key is one a checked person holds now: what a node signs them in by. */
export const holds = (person: Person, id: string): PersonKey | null => person.keys.find((key) => key.id === id && key.revokedAt === null) ?? null;
