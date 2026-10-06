/**
 * MD5 (RFC 1321), as the NIU account API wants a password: hashed, in hex.
 *
 * Here rather than borrowed because a protocol is pure — it runs in the app as
 * well as on the server, where Node's `crypto` is not, and the browser's
 * `crypto.subtle` has no MD5. It is not used for anything that needs to be
 * secure: it is how NIU's sign-in expects the password to look.
 */

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  // Padded to 56 bytes mod 64, then the length in bits, little-endian.
  const length = (((message.length + 8) >>> 6) + 1) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(message);
  bytes[message.length] = 0x80;
  const bits = message.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let chunk = 0; chunk < length; chunk += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(chunk + i * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i]! + m[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
  return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
