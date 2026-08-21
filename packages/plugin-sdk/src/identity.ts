/**
 * Which id is which, and how well a device is answering.
 *
 * Three different identities were all called `id`, and the core silently
 * overwrote one with another: `DeviceDescriptor.id` is the vendor's identity
 * for a thing, and the registry replaced it with the catalog's. That works only
 * while one adapter provides exactly one device — the moment a Home Assistant
 * adapter provides thirty, the id in a DTO no longer says which of the two
 * questions it answers, and the code that reads it cannot be told apart from
 * the code that got it wrong.
 *
 * These aliases are documentation the compiler will not enforce — they are all
 * `string` — but a signature that says `SavedDeviceId` cannot be misread, and
 * `Omit<DeviceDescriptor, 'id'>` in `SavedDeviceView` is what actually stops
 * the overwrite coming back.
 */

/**
 * The core's own id for a device you added.
 *
 * The primary key, the route segment, and what history is keyed by. It outlives
 * every connection detail: rebinding a station to a different unit, or moving a
 * plug to a new address, must not change it, or the charts lose their subject.
 */
export type SavedDeviceId = string;

/**
 * A temporary identity, alive only during commissioning.
 *
 * A discovered candidate is not a device — it is evidence that something is
 * reachable. It never reaches the database under this id: completing the wizard
 * mints a `SavedDeviceId`, and this one is forgotten.
 */
export type CandidateId = string;

/**
 * The adapter's or vendor's identity for the same thing.
 *
 * A MAC, a Tuya device id, a serial. Unique only within its adapter, which is
 * why it can never be the primary key, and why it must be passed explicitly to
 * an adapter rather than inferred from whatever id happened to be at hand.
 */
export type ProviderDeviceId = string;

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
  /** Never finished being set up: no transport chosen, or no driver installed. */
  | 'unconfigured'
  /** Something is wrong that the user has to act on — a wrong key, a refused link. */
  | 'error';

export type ConnectionHealth = {
  status: ConnectionStatus;
  /** One plain sentence, always present, even when connected. */
  detail: string;
  /** Who holds the link: the server, or the app in the user's hand. */
  owner: 'server' | 'client' | null;
  /** How it is reached — `ble`, `mqtt`, `tuya-lan`, `sim`. Null until chosen. */
  transport: string | null;
  /** When the device last produced a reading, not when it was last asked. */
  lastReadingAt: string | null;
};

/** Connected, and nothing else. The one question most UI actually asks. */
export const isOnline = (health: ConnectionHealth): boolean => health.status === 'connected';
