/**
 * Which id is which, and how well a device is answering.
 *
 * A device's own id and the identity it reports are both strings. Left as
 * plain aliases they interchange silently, and the failure is not a type error
 * but a command sent to the wrong device. So the core's id is branded: a
 * distinct type the compiler will not substitute. Crossing into it is
 * deliberate and happens only at the edges — where a database row or an HTTP
 * parameter arrives — through `savedDeviceId`. Everywhere inside, the
 * signature is the guarantee.
 */

declare const brand: unique symbol;

type Branded<Name extends string> = string & { readonly [brand]: Name };

/**
 * The core's own id for a device you added.
 *
 * The primary key, the route segment, and what history is keyed by. It outlives
 * every connection detail: reaching a station a second way, or moving a plug to
 * a new address, must not change it, or the charts lose their subject. A
 * device's identity — what it says it is — is a separate thing (`Identified`).
 */
export type SavedDeviceId = Branded<'SavedDeviceId'>;

/**
 * Where a raw string becomes a device id: a row out of SQLite, a path segment
 * off an HTTP request. Naming the crossing keeps it rare and reviewable, and
 * makes `id as SavedDeviceId` in the middle of the code stand out as the
 * mistake it would be.
 */
export const savedDeviceId = (raw: string): SavedDeviceId => raw as SavedDeviceId;

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

/** How a device is doing, as its holder reports it: its session's word, and who holds it over what. */
export type ConnectionHealth = SessionHealth & {
  /** Who holds the link: the server, or the app in the user's hand. */
  owner: 'server' | 'client' | null;
  /** The transport of the connection in use — `ble`, `mqtt`, `lan` — or `sim`. Null when none is. */
  transport: string | null;
};

/** Connected, and nothing else. The one question most UI actually asks. */
export const isOnline = (health: SessionHealth): boolean => health.status === 'connected';
