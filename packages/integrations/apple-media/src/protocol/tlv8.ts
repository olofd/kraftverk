/*
  TLV8, as HomeKit's pairing carries its messages: a type byte, a length
  byte, and up to 255 bytes of value — a longer value split into items of
  the same type one after another, and joined again when read.
*/

/** The types pairing uses. */
export const TLV = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  State: 0x06,
  Error: 0x07,
  BackOff: 0x08,
  Signature: 0x0a,
  Name: 0x11,
} as const;

/** An error the other side answered with, by its code. */
export const TLV_ERRORS: Readonly<Record<number, string>> = {
  1: 'it was refused',
  2: 'the PIN was not the one it shows',
  3: 'it asks to wait before trying again',
  4: 'it has paired with as many as it can',
  5: 'it has been tried too often: restart it, and try again',
  6: 'it is pairing with someone else',
  7: 'it is busy',
};

/** Items in order, each type with its value. */
export type Tlv = ReadonlyArray<readonly [number, Uint8Array]>;

export function writeTlv(items: Tlv): Uint8Array {
  const out: number[] = [];
  for (const [type, value] of items) {
    if (value.length === 0) out.push(type, 0);
    for (let at = 0; at < value.length; at += 255) {
      const piece = value.subarray(at, at + 255);
      out.push(type, piece.length, ...piece);
    }
  }
  return new Uint8Array(out);
}

/** Reads TLV8 into a map by type: what follows a type's 255 bytes, of the same type, is joined to it. */
export function readTlv(data: Uint8Array): Map<number, Uint8Array> {
  const found = new Map<number, Uint8Array>();
  let previous = -1;
  for (let at = 0; at + 2 <= data.length; ) {
    const type = data[at]!;
    const length = data[at + 1]!;
    const value = data.subarray(at + 2, at + 2 + length);
    if (at + 2 + length > data.length) throw new Error('A TLV item runs past the end');
    const before = found.get(type);
    if (before && previous === type) {
      const joined = new Uint8Array(before.length + value.length);
      joined.set(before);
      joined.set(value, before.length);
      found.set(type, joined);
    } else found.set(type, value.slice());
    previous = type;
    at += 2 + length;
  }
  return found;
}

/** The error a reply carries, in words; null when it carries none. */
export function tlvError(items: Map<number, Uint8Array>): string | null {
  const code = items.get(TLV.Error)?.[0];
  return code === undefined ? null : (TLV_ERRORS[code] ?? `it answered with error ${code}`);
}

export const byte = (value: number): Uint8Array => new Uint8Array([value]);
