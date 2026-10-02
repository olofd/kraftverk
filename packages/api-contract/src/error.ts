/**
 * Why a home refused, in words — the one thing in the API's contract that
 * runs (docs/PLAN-SHARED-CORE.md, "Refusals in words, not in HTTP").
 *
 * The hub throws it; the server's routes answer it with the status its kind
 * maps to and the refusal itself in the body (`toWire`), and
 * `@kraftverk/api-client` reads it back as the same error (`fromWire`) — so a
 * screen handles one refusal whether its home is in the process, in a
 * worker across a message port, or on a server.
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

const KINDS = new Set<string>(Object.keys(API_ERROR_STATUS));

/** Whether a value is a kind of refusal: what crossed the wire is checked, not trusted. */
export const isApiErrorKind = (value: unknown): value is ApiErrorKind => typeof value === 'string' && KINDS.has(value);

/**
 * A refusal as it travels — in an HTTP answer's body, in a message across a
 * port — and is read back on the other side as the same `ApiError`: its
 * words, its kind, each problem and the token a yes is sent back with.
 */
export type ApiErrorWire = { error: string; kind: ApiErrorKind; problems?: readonly string[]; needsConfirmation?: string };

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

  /** This refusal as it travels. */
  toWire(): ApiErrorWire {
    return { error: this.message, kind: this.kind, ...(this.problems.length ? { problems: this.problems } : {}), ...(this.needsConfirmation ? { needsConfirmation: this.needsConfirmation } : {}) };
  }

  /** A refusal that travelled, as the error it was; null when what came is not one. */
  static fromWire(wire: unknown): ApiError | null {
    if (!wire || typeof wire !== 'object') return null;
    const { error, kind, problems, needsConfirmation } = wire as Record<string, unknown>;
    if (typeof error !== 'string' || !isApiErrorKind(kind)) return null;
    return new ApiError(kind, error, {
      problems: Array.isArray(problems) ? problems.map(String) : [],
      ...(typeof needsConfirmation === 'string' ? { needsConfirmation } : {}),
    });
  }
}
