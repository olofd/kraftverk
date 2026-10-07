import { ed25519Pair, ed25519Sign, ed25519Verify, hkdfSha512, open, randomBytes, seal, x25519Pair, x25519Shared } from './crypto.ts';
import { pack } from './opack.ts';
import { clientSide, publicOf, randomPrivate } from './srp.ts';
import { byte, readTlv, TLV, tlvError, writeTlv } from './tlv8.ts';

/*
  HomeKit's pairing, as an Apple TV's Companion and AirPlay take it
  (pyatv's hap_srp, MIT; NOTICE): pair-setup once, with the PIN the TV
  shows, which leaves each side the other's long-term Ed25519 key; then
  pair-verify on every connection, an X25519 exchange each side signs,
  from which the connection's keys are derived. Pure: TLV in, TLV out —
  the frames they travel in are the protocol's (companion.ts).
*/

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const hex = (bytes: Uint8Array): string => [...bytes].map((each) => each.toString(16).padStart(2, '0')).join('');
const fromHex = (text: string): Uint8Array => new Uint8Array((text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/**
 * What a pairing leaves this side: the TV's long-term public key, this
 * side's long-term secret, the TV's pairing id and this side's — written as
 * pyatv writes them, hex joined by ":", so credentials pyatv made are taken
 * too.
 */
export type Credentials = { tvKey: Uint8Array; secret: Uint8Array; tvId: Uint8Array; clientId: Uint8Array };

export const writeCredentials = (credentials: Credentials): string => [credentials.tvKey, credentials.secret, credentials.tvId, credentials.clientId].map(hex).join(':');

export function readCredentials(text: string | null | undefined): Credentials | null {
  const parts = (text ?? '').trim().split(':');
  if (parts.length !== 4 || parts.some((part) => !/^([0-9a-f]{2})+$/i.test(part))) return null;
  const [tvKey, secret, tvId, clientId] = parts.map(fromHex) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  return tvKey.length === 32 && secret.length === 32 ? { tvKey, secret, tvId, clientId } : null;
}

/** A pairing that refused, with why in words a person acts on. */
export class PairingRefused extends Error {}

const refusedBy = (items: Map<number, Uint8Array>, what: string): never => {
  throw new PairingRefused(`The TV refused ${what}: ${tlvError(items) ?? 'it said nothing more'}`);
};

/** Pair-setup, from this side: started, then given the PIN, then finished. */
export class PairSetup {
  #a = randomPrivate();
  #salt: Uint8Array | null = null;
  #B: Uint8Array | null = null;
  #K: Uint8Array | null = null;
  #M2: Uint8Array | null = null;
  #long = ed25519Pair();
  /** This side's pairing id: a UUID, as Apple's own remotes make theirs. */
  readonly clientId = encoder.encode(hex(randomBytes(16)).toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-'));

  /** M1: asks the TV to start pairing — it shows a PIN. */
  start(): Uint8Array {
    return writeTlv([[TLV.Method, byte(0)], [TLV.State, byte(1)]]);
  }

  /** M2 in, M3 out: the TV's salt and public value, and this side's proof of the PIN. */
  proof(reply: Uint8Array, pin: string): Uint8Array {
    const items = readTlv(reply);
    if (items.has(TLV.Error) || items.get(TLV.State)?.[0] !== 2) refusedBy(items, 'to start pairing');
    this.#salt = items.get(TLV.Salt)!;
    this.#B = items.get(TLV.PublicKey)!;
    const outcome = clientSide({ username: 'Pair-Setup', password: pin, salt: this.#salt, a: this.#a, B: this.#B });
    if (!outcome) throw new PairingRefused('The TV answered with a value no pairing can meet: start again');
    this.#K = outcome.K;
    this.#M2 = outcome.M2;
    return writeTlv([[TLV.State, byte(3)], [TLV.PublicKey, publicOf(this.#a)], [TLV.Proof, outcome.M1]]);
  }

  /** M4 in, M5 out: the TV's proof checked — the PIN was right — then this side's long-term key, signed and sealed. */
  exchange(reply: Uint8Array, name: string): Uint8Array {
    const items = readTlv(reply);
    if (items.get(TLV.Error)?.[0] === 2) throw new PairingRefused('That was not the PIN the TV shows: start again, and type the new one');
    if (items.has(TLV.Error) || items.get(TLV.State)?.[0] !== 4) refusedBy(items, 'the PIN');
    const proof = items.get(TLV.Proof);
    if (!proof || hex(proof) !== hex(this.#M2!)) throw new PairingRefused('The TV’s answer does not prove it knows the PIN: start again');
    const deviceX = hkdfSha512(this.#K!, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
    const signature = ed25519Sign(join(deviceX, this.clientId, this.#long.public), this.#long.secret);
    const inner = writeTlv([
      [TLV.Identifier, this.clientId],
      [TLV.PublicKey, this.#long.public],
      [TLV.Signature, signature],
      [TLV.Name, pack({ name })],
    ]);
    const key = hkdfSha512(this.#K!, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
    return writeTlv([[TLV.State, byte(5)], [TLV.EncryptedData, seal(key, 'PS-Msg05', inner)]]);
  }

  /** M6 in: the TV's long-term key, its signature checked — what is kept to verify every connection after. */
  finish(reply: Uint8Array): Credentials {
    const items = readTlv(reply);
    if (items.has(TLV.Error) || items.get(TLV.State)?.[0] !== 6) refusedBy(items, 'to finish pairing');
    const key = hkdfSha512(this.#K!, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
    const opened = open(key, 'PS-Msg06', items.get(TLV.EncryptedData) ?? new Uint8Array(0));
    if (!opened) throw new PairingRefused('The TV’s last answer could not be read: start again');
    const inner = readTlv(opened);
    const tvId = inner.get(TLV.Identifier);
    const tvKey = inner.get(TLV.PublicKey);
    const signature = inner.get(TLV.Signature);
    if (!tvId || !tvKey || !signature) throw new PairingRefused('The TV’s last answer is missing what pairing leaves: start again');
    const accessoryX = hkdfSha512(this.#K!, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
    if (!ed25519Verify(signature, join(accessoryX, tvId, tvKey), tvKey)) throw new PairingRefused('The TV’s signature does not hold: start again');
    return { tvKey, secret: this.#long.secret, tvId, clientId: this.clientId };
  }
}

/** The keys a verified connection is encrypted with: this side's to send with, and to read with. */
export type SessionKeys = { output: Uint8Array; input: Uint8Array };

/** Pair-verify, from this side: with the credentials pairing left, on every connection. */
export class PairVerify {
  #ephemeral = x25519Pair();
  #shared: Uint8Array | null = null;

  constructor(private credentials: Credentials) {}

  /** M1: this side's key for this connection. */
  start(): Uint8Array {
    return writeTlv([[TLV.State, byte(1)], [TLV.PublicKey, this.#ephemeral.public]]);
  }

  /** M2 in, M3 out: the TV's key and its signature checked against the one pairing left; this side's signed in turn. */
  answer(reply: Uint8Array): Uint8Array {
    const items = readTlv(reply);
    if (items.has(TLV.Error) || items.get(TLV.State)?.[0] !== 2) refusedBy(items, 'the connection: pair it again');
    const theirs = items.get(TLV.PublicKey)!;
    this.#shared = x25519Shared(this.#ephemeral.secret, theirs);
    const key = hkdfSha512(this.#shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
    const opened = open(key, 'PV-Msg02', items.get(TLV.EncryptedData) ?? new Uint8Array(0));
    if (!opened) throw new PairingRefused('The TV’s answer could not be read: pair it again');
    const inner = readTlv(opened);
    const tvId = inner.get(TLV.Identifier);
    const signature = inner.get(TLV.Signature);
    if (!tvId || hex(tvId) !== hex(this.credentials.tvId)) throw new PairingRefused('Another device answered than the one paired with: pair it again');
    if (!signature || !ed25519Verify(signature, join(theirs, tvId, this.#ephemeral.public), this.credentials.tvKey)) throw new PairingRefused('The TV’s signature does not hold: pair it again');
    const mine = ed25519Sign(join(this.#ephemeral.public, this.credentials.clientId, theirs), this.credentials.secret);
    const sealed = seal(key, 'PV-Msg03', writeTlv([[TLV.Identifier, this.credentials.clientId], [TLV.Signature, mine]]));
    return writeTlv([[TLV.State, byte(3)], [TLV.EncryptedData, sealed]]);
  }

  /** M4 in: verified — and the connection's keys, by the names its protocol derives them with. */
  finish(reply: Uint8Array, salt: string, outputInfo: string, inputInfo: string): SessionKeys {
    const items = readTlv(reply);
    if (items.has(TLV.Error) || items.get(TLV.State)?.[0] !== 4) refusedBy(items, 'the connection: pair it again');
    return { output: hkdfSha512(this.#shared!, salt, outputInfo), input: hkdfSha512(this.#shared!, salt, inputInfo) };
  }
}

/** A pairing id, as text: what an id read back is shown as. */
export const idText = (id: Uint8Array): string => decoder.decode(id);
