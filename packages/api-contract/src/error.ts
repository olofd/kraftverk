/**
 * Why a home refused, in words — the one thing in the API's contract that
 * runs (docs/PLAN-SHARED-CORE.md, "Refusals in words, not in HTTP").
 *
 * The hub throws it; the server's routes answer it with the status its kind
 * maps to, and `@kraftverk/api-client` turns that status back into the same
 * error — so a screen handles one refusal whether its home is in the process
 * or on a server.
 */

/**
 * - `invalid` — what was asked cannot be: a value out of range, a rule that
 *   does not hold (400);
 * - `not-found` — there is no such thing, or it is not yours (404);
 * - `forbidden` — it is, but not for whoever asks: an app speaking for a
 *   connection it does not hold (403);
 * - `conflict` — it cannot be done as things are: the key is taken, it is
 *   already running (409);
 * - `needs-yes` — a person must say yes: retried with `needsConfirmation` as
 *   its confirmation (409);
 * - `not-allowed` — not asked that way: a tool that writes, asked as a read
 *   (405);
 * - `too-large` — more than is kept: a device's stored value past its limit
 *   (413);
 * - `locked` — every write to hardware is refused here: read-only (423);
 * - `failed` — the device answered, and not as it declares (502);
 * - `unavailable` — what it needs is not running here (503).
 */
export type ApiErrorKind = 'invalid' | 'not-found' | 'forbidden' | 'conflict' | 'needs-yes' | 'not-allowed' | 'too-large' | 'locked' | 'failed' | 'unavailable';

export const API_ERROR_STATUS: Readonly<Record<ApiErrorKind, number>> = {
  invalid: 400,
  'not-found': 404,
  forbidden: 403,
  conflict: 409,
  'needs-yes': 409,
  'not-allowed': 405,
  'too-large': 413,
  locked: 423,
  failed: 502,
  unavailable: 503,
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** Each thing wrong, when there are several: a file's problems, what an import still needs. */
  readonly problems: readonly string[];
  /** For `needs-yes`: the token a person's yes is sent back with, good once, for a minute. */
  readonly needsConfirmation: string | null;

  constructor(kind: ApiErrorKind, message: string, more: { problems?: readonly string[]; needsConfirmation?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.problems = more.problems ?? [];
    this.needsConfirmation = more.needsConfirmation ?? null;
  }
}
