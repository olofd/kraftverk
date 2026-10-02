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
  /** Something is wrong that the user has to act on — a wrong key, a refused link. */
  | 'error';

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

/** Connected, and nothing else. The one question most UI actually asks. */
export const isOnline = (health: SessionHealth): boolean => health.status === 'connected';
