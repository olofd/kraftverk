import { describe, expect, test } from 'bun:test';

import { bigOfBytes, bytesOfBig, clientSide, k, publicOf, serverPublicOf, serverSide, verifierOf, xOf } from '../src/protocol/srp.ts';
import { HAP_VECTORS as V } from './hap-vectors.ts';

/*
  HomeKit's SRP, checked against its published vectors: every value the
  exchange works out, from the group's k to the client's proof — what a
  real Apple TV checks a PIN by.
*/

const fromHex = (hex: string): Uint8Array => new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const big = (hex: string): bigint => BigInt(`0x${hex}`);

describe('SRP-6a as HomeKit speaks it', () => {
  const salt = fromHex(V.s);

  test('the group, the password’s x and its verifier', () => {
    expect(k).toBe(big(V.k));
    expect(xOf(V.I, V.P, salt)).toBe(big(V.x));
    expect(verifierOf(V.I, V.P, salt)).toBe(big(V.v));
  });

  test('both public values', () => {
    expect(hexOf(publicOf(big(V.a)))).toBe(V.A);
    expect(hexOf(serverPublicOf(big(V.v), big(V.b)))).toBe(V.B);
  });

  test('the client’s side: u, the shared secret, the session key and its proof', () => {
    const outcome = clientSide({ username: V.I, password: V.P, salt, a: big(V.a), B: fromHex(V.B) })!;
    expect(outcome.u).toBe(big(V.u));
    expect(outcome.S).toBe(big(V.S));
    expect(hexOf(outcome.K)).toBe(V.K);
    expect(hexOf(outcome.M1)).toBe(V.M1);
  });

  test('the server’s side agrees: the same key, the same proofs', () => {
    const client = clientSide({ username: V.I, password: V.P, salt, a: big(V.a), B: fromHex(V.B) })!;
    const server = serverSide({ username: V.I, verifier: big(V.v), salt, b: big(V.b), A: fromHex(V.A) });
    expect(server.K).toEqual(client.K);
    expect(server.M1).toEqual(client.M1);
    expect(server.M2).toEqual(client.M2);
    // The wrong PIN proves nothing.
    expect(clientSide({ username: V.I, password: 'password124', salt, a: big(V.a), B: fromHex(V.B) })!.M1).not.toEqual(client.M1);
    expect(bigOfBytes(bytesOfBig(123456789n))).toBe(123456789n);
  });
});
