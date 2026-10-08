// What the tests use: the package as others import it, and text as bytes.
export * from '../src/index.ts';
export const utf8Of = (text: string): Uint8Array => new TextEncoder().encode(text);
