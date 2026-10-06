import type { NodeId } from './node.ts';

/*
  How well a device is answering: a status, and always a sentence saying why.
*/

/**
 * Why a device is or is not answering.
 *
 * A boolean could not say the difference between "you have not finished setting
 * this up", "the radio is busy elsewhere" and "it is simply unplugged" — and
 * those three want three different things from the user. Every state carries a
 * sentence, because a grey card with no reason is the thing this whole model
 * exists to avoid.
 */
export type ConnectionStatus =
  /** Reachable, and producing readings. */
  | 'connected'
  /** A link is being established. Normal, and brief. */
  | 'connecting'
  /** Configured, but nothing is answering. The resting state of an unplugged device. */
  | 'offline'
  /** Never finished being set up, or its type is not installed here. */
  | 'unconfigured'
  /** Something is wrong — a wrong key, a refused link — and it is tried again, in a while. */
  | 'error'
  /**
   * It waits on a person — a password refused, a sign-in lapsed — and nothing
   * tries it again until they act: tried in a loop, a vendor locks the account.
   */
  | 'needs-you'
  /** Paused by its owner: kept, with its history, and not reached until resumed. */
  | 'paused';

/**
 * How a device is doing, as its session knows it. Nothing about who holds it
 * or how: a session cannot know that, and the same session runs in every holder.
 */
export type SessionHealth = {
  status: ConnectionStatus;
  /** One plain sentence, always present, even when connected. */
  detail: string;
  /** When the device last produced a reading, not when it was last asked. */
  lastReadingAt: string | null;
};

/** How a device is doing, as the node holding it reports it: its session's word, and which node holds it over what. */
export type ConnectionHealth = SessionHealth & {
  /** The node that holds the connection in use; null when none does. */
  node: NodeId | null;
  /** The transport of the connection in use — `ble`, `mqtt`, `lan` — or `sim`. Null when none is. */
  transport: string | null;
};

/**
 * Thrown by a session, its check or a bridge when a person must act before it
 * can work — a password refused, a sign-in lapsed. Its holder tries nothing
 * again until they have: its connection's secrets given anew, say. The
 * message says what to do, in a person's words.
 */
export class NeedsSignIn extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsSignIn';
  }
}

/**
 * Thrown when it cannot be reached now but may be later — rate-limited,
 * unplugged, the service down. Its holder tries again: after
 * `retryAfterMs` when it is said, else on its own backoff.
 */
export class NotReachable extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'NotReachable';
  }
}

/** Whether what was thrown waits on a person: by its name, so a copy of the SDK bundled elsewhere is understood too. */
export const needsSignIn = (thrown: unknown): boolean => thrown instanceof Error && thrown.name === 'NeedsSignIn';

/** When what was thrown says to try again, in ms; null when it does not say. */
export const retryAfterOf = (thrown: unknown): number | null =>
  thrown instanceof Error && thrown.name === 'NotReachable' ? ((thrown as NotReachable).retryAfterMs ?? null) : null;

/** Connected, and nothing else. The one question most UI actually asks. */
export const isOnline = (health: SessionHealth): boolean => health.status === 'connected';
