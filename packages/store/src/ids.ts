/** Random bytes as hex, from the random values every place has: the tail of a new row's id (`d-1b6f399a3ff1`). */
export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
