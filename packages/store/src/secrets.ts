/**
 * How a connection's secrets are kept at rest: what the place keeping a home
 * provides (docs/PLAN-SHARED-CORE.md). The server seals with a key from its
 * environment, or keeps them as given when it has none and says so; a phone
 * with a key it keeps in its secure storage.
 */
export interface SecretsAtRest {
  /** Whether what is sealed now is encrypted: what a screen says of where secrets are kept. */
  readonly encrypted: boolean;
  seal(value: string): { value: string; encrypted: boolean };
  /** The value again; null when it cannot be opened — sealed with a key no longer here. */
  open(stored: string, encrypted: boolean): string | null;
}

/** Secrets kept as given: a test's, or a place with nothing to seal them with. */
export const plainSecrets: SecretsAtRest = {
  encrypted: false,
  seal: (value) => ({ value, encrypted: false }),
  open: (stored, encrypted) => (encrypted ? null : stored),
};
