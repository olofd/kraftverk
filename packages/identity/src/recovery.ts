import { mapHashToField } from '@noble/curves/abstract/modular.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { utf8 } from './bytes.ts';
import { softwareKey, type SigningKey } from './keys.ts';

/*
  A person's recovery key (docs/PLAN-WORLD-MODEL.md §10.2): twelve words,
  shown once when they sign up, and written down. The key is made from the
  words each time they are typed in, and kept nowhere: with them, a person
  who has lost every device signs a new one in and revokes the rest. The
  words are BIP 39's English list (its 2 048 words, checksummed: a word
  mistyped is caught), through @scure/bip39, MIT.
*/

/** Twelve new words: 128 bits. */
export const newRecoveryWords = (): string[] => generateMnemonic(wordlist, 128).split(' ');

/** The words as typed, tidied: lower case, single spaces. */
const tidy = (words: string | readonly string[]): string =>
  (typeof words === 'string' ? words : words.join(' ')).trim().toLowerCase().split(/\s+/).join(' ');

/** Whether words are twelve of the list, their checksum right. */
export const areRecoveryWords = (words: string | readonly string[]): boolean => {
  const text = tidy(words);
  return text.split(' ').length === 12 && validateMnemonic(text, wordlist);
};

/** The recovery key twelve words make: the same words, the same key, anywhere. */
export function recoveryKey(words: string | readonly string[]): SigningKey {
  const text = tidy(words);
  if (!areRecoveryWords(text)) throw new Error('Those are not your twelve recovery words: check each one');
  const entropy = mnemonicToEntropy(text, wordlist);
  const material = hkdf(sha256, entropy, undefined, utf8('kraftverk recovery key'), 48);
  return softwareKey(mapHashToField(material, p256.Point.Fn.ORDER));
}

/** Words from entropy: for a test that needs the same words twice. */
export const recoveryWordsOf = (entropy: Uint8Array): string[] => entropyToMnemonic(entropy, wordlist).split(' ');
