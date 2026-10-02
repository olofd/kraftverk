import type { SecretsAtRest } from '@kraftverk/store';

/*
  Secrets in a configuration file (docs/CONFIG.md), as the hub reads and
  writes them: sealed with a passphrase for an export that travels, or kept
  as the home keeps its own for the snapshot beside its database.
*/

/** A passphrase shorter than this is refused: an export travels, and is guessed at offline. */
export const PASSPHRASE_MIN = 12;

/**
 * Sealing a secret with a passphrase, and opening it: the place's to give,
 * as its key derivation and cipher are — the server's scrypt and AES-GCM
 * from its runtime, a browser's from Web Crypto. Asynchronous, as a
 * browser's is. `open` throws, in words, when the passphrase is wrong or the
 * value was changed.
 */
export interface PassphraseSealing {
  seal(passphrase: string, value: string): Promise<string>;
  open(passphrase: string, sealed: string): Promise<string>;
}

/** Whether a secret in a file is sealed with a passphrase (`sealed:v1:…`), whichever version. */
export const isSealed = (value: string): boolean => /^sealed:v\d+:/.test(value);

/** A secret as the home's own snapshot keeps it: sealed as the database seals it. */
const KEPT = 'sealed:server:';

/**
 * A secret as the snapshot beside the database keeps it: sealed with the
 * home's key, as the database seals it ("sealed:server:…") — or, with none,
 * as the database keeps it. It opens only where it was kept, and never leaves.
 */
export function keep(secrets: SecretsAtRest, value: string): string {
  const sealed = secrets.seal(value);
  return sealed.encrypted ? `${KEPT}${sealed.value}` : value;
}

/** A secret the snapshot kept, opened; null when the key that sealed it is gone. */
export const openKept = (secrets: SecretsAtRest, value: string): string | null => (value.startsWith(KEPT) ? secrets.open(value.slice(KEPT.length), true) : value);

/** Whether a secret in a file is one the home kept for itself. */
export const isKept = (value: string): boolean => value.startsWith(KEPT);
