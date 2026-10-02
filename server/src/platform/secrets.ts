import { plainSecrets, sealedWithKey, secretKeyFrom, type SecretsAtRest } from '@kraftverk/store';

/**
 * How the server keeps a connection's secrets at rest: encrypted only if a
 * key is supplied from outside (`KRAFTVERK_SECRET_KEY`).
 *
 * With one, values are sealed as every place seals them (`sealedWithKey`),
 * with a key made from it once. Without one they are stored as given — and
 * `encrypted` says so plainly, so the app can say so, because a key kept
 * next to the data it protects would be decoration rather than encryption.
 */
export const serverSecrets = (passphrase: string | null): SecretsAtRest => (passphrase ? sealedWithKey(secretKeyFrom(passphrase)) : plainSecrets);
