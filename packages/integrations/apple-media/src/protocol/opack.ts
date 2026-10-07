/*
  OPACK, Apple's compact binary form for the Companion protocol's messages:
  a tag byte for each value — small numbers and short texts in the tag
  itself — and a table of what was already written, so a value seen again
  may be written as a reference to it. Written here without references,
  which is OPACK too: a table both sides must fill alike is not risked; read
  with them, filled exactly as pyatv fills it. Ported from pyatv's opack
  (MIT; NOTICE).
*/

/** A value OPACK carries. A Uint8Array is bytes; a plain object, a dictionary; a bigint, a number past what a double holds exactly. */
export type Opack = null | boolean | number | bigint | string | Uint8Array | readonly Opack[] | { readonly [key: string]: Opack };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** n as `width` bytes, little-endian. */
const little = (n: number | bigint, width: number): number[] => {
  const out: number[] = [];
  let value = BigInt(n);
  for (let index = 0; index < width; index++) {
    out.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return out;
};

const readBig = (data: Uint8Array, at: number, width: number): bigint => {
  let value = 0n;
  for (let index = width - 1; index >= 0; index--) value = (value << 8n) | BigInt(data[at + index]!);
  return value;
};
const readLittle = (data: Uint8Array, at: number, width: number): number => Number(readBig(data, at, width));
/** A number read, as a bigint only when a double would not hold it exactly. */
const exact = (value: bigint): number | bigint => (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value);

/** Writes one value as OPACK, every value in full. */
export function pack(value: Opack): Uint8Array {
  const out: number[] = [];
  const write = (each: Opack): void => {
    let bytes: number[];
    if (each === null) bytes = [0x04];
    else if (each === true) bytes = [0x01];
    else if (each === false) bytes = [0x02];
    else if (typeof each === 'bigint') bytes = [0x33, ...little(each, 8)];
    else if (typeof each === 'number') {
      if (!Number.isInteger(each)) {
        const buffer = new DataView(new ArrayBuffer(8));
        buffer.setFloat64(0, each, true);
        bytes = [0x36, ...new Uint8Array(buffer.buffer)];
      } else if (each < 0) throw new Error('OPACK carries no negative integer');
      else if (each < 0x28) bytes = [0x08 + each];
      else if (each <= 0xff) bytes = [0x30, each];
      else if (each <= 0xffff) bytes = [0x31, ...little(each, 2)];
      else if (each <= 0xffffffff) bytes = [0x32, ...little(each, 4)];
      else bytes = [0x33, ...little(each, 8)];
    } else if (typeof each === 'string') {
      const text = [...encoder.encode(each)];
      if (text.length <= 0x20) bytes = [0x40 + text.length, ...text];
      else if (text.length <= 0xff) bytes = [0x61, text.length, ...text];
      else if (text.length <= 0xffff) bytes = [0x62, ...little(text.length, 2), ...text];
      else if (text.length <= 0xffffff) bytes = [0x63, ...little(text.length, 3), ...text];
      else bytes = [0x64, ...little(text.length, 4), ...text];
    } else if (each instanceof Uint8Array) {
      const data = [...each];
      if (data.length <= 0x20) bytes = [0x70 + data.length, ...data];
      else if (data.length <= 0xff) bytes = [0x91, data.length, ...data];
      else if (data.length <= 0xffff) bytes = [0x92, ...little(data.length, 2), ...data];
      else if (data.length <= 0xffffffff) bytes = [0x93, ...little(data.length, 4), ...data];
      else bytes = [0x94, ...little(data.length, 8), ...data];
    } else if (Array.isArray(each)) {
      out.push(0xd0 + Math.min(each.length, 0xf));
      for (const item of each) write(item);
      if (each.length >= 0xf) out.push(0x03);
      return;
    } else {
      const entries = Object.entries(each as Record<string, Opack>);
      out.push(0xe0 + Math.min(entries.length, 0xf));
      for (const [key, item] of entries) {
        write(key);
        write(item);
      }
      if (entries.length >= 0xf) out.push(0x03);
      return;
    }
    out.push(...bytes);
  };
  write(value);
  return new Uint8Array(out);
}

/** Whether two values read are equal, as Python compares them: bytes and texts by what they hold. */
function same(a: Opack, b: Opack): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, index) => byte === b[index]);
  return a === b;
}

/** Reads one value: it, and how many bytes it took. */
export function unpack(data: Uint8Array): { value: Opack; used: number } {
  const table: Opack[] = [];
  const read = (at: number): [Opack, number] => {
    const tag = data[at];
    if (tag === undefined) throw new Error('OPACK ends too soon');
    let value: Opack;
    let next: number;
    if (tag === 0x01) [value, next] = [true, at + 1];
    else if (tag === 0x02) [value, next] = [false, at + 1];
    else if (tag === 0x04) [value, next] = [null, at + 1];
    else if (tag === 0x05) [value, next] = [data.slice(at + 1, at + 17), at + 17];
    else if (tag === 0x06) [value, next] = [readLittle(data, at + 1, 8), at + 9];
    else if (tag >= 0x08 && tag <= 0x2f) [value, next] = [tag - 0x08, at + 1];
    else if (tag >= 0x30 && tag <= 0x33) {
      const width = 1 << (tag - 0x30);
      [value, next] = [exact(readBig(data, at + 1, width)), at + 1 + width];
    } else if (tag === 0x35) [value, next] = [new DataView(data.buffer, data.byteOffset + at + 1, 4).getFloat32(0, true), at + 5];
    else if (tag === 0x36) [value, next] = [new DataView(data.buffer, data.byteOffset + at + 1, 8).getFloat64(0, true), at + 9];
    else if (tag >= 0x40 && tag <= 0x64) {
      const width = tag <= 0x60 ? 0 : tag - 0x60;
      const length = width ? readLittle(data, at + 1, width) : tag - 0x40;
      const start = at + 1 + width;
      [value, next] = [decoder.decode(data.subarray(start, start + length)), start + length];
    } else if (tag >= 0x70 && tag <= 0x94) {
      const width = tag <= 0x90 ? 0 : [1, 2, 4, 8][tag - 0x91]!;
      const length = width ? readLittle(data, at + 1, width) : tag - 0x70;
      const start = at + 1 + width;
      [value, next] = [data.slice(start, start + length), start + length];
    } else if (tag >= 0xa0 && tag <= 0xc4) {
      const width = tag <= 0xc0 ? 0 : [1, 2, 4, 8][tag - 0xc1]!;
      const index = width ? readLittle(data, at + 1, width) : tag - 0xa0;
      if (index >= table.length) throw new Error('An OPACK reference to nothing written');
      return [table[index]!, at + 1 + width];
    } else if (tag >= 0xd0 && tag <= 0xdf) {
      const items: Opack[] = [];
      let cursor = at + 1;
      const endless = tag === 0xdf;
      for (let count = 0; endless ? data[cursor] !== 0x03 : count < tag - 0xd0; count++) {
        const [item, after] = read(cursor);
        items.push(item);
        cursor = after;
      }
      return [items, endless ? cursor + 1 : cursor];
    } else if (tag >= 0xe0 && tag <= 0xef) {
      const entries: Record<string, Opack> = {};
      let cursor = at + 1;
      const endless = tag === 0xef;
      for (let count = 0; endless ? data[cursor] !== 0x03 : count < tag - 0xe0; count++) {
        const [key, afterKey] = read(cursor);
        const [item, afterItem] = read(afterKey);
        entries[String(key)] = item;
        cursor = afterItem;
      }
      return [entries, endless ? cursor + 1 : cursor];
    } else throw new Error(`An OPACK tag nobody knows: 0x${tag.toString(16)}`);
    // What may be referred to later, as pyatv keeps it: not true, false, null or a small number, and each value once.
    const single = tag <= 0x04 || (tag >= 0x08 && tag <= 0x2f);
    if (!single && !table.some((kept) => same(kept, value))) table.push(value);
    return [value, next];
  };
  const [value, used] = read(0);
  return { value, used };
}
