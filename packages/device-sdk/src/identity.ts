/**
 * Which id is which, and how well a device is answering.
 *
 * A device has several identities at once — the one you gave it, the one its
 * vendor stamped on it, the one a scan produced before it was yours — and they
 * are all strings. Left as plain aliases they interchange silently, and the
 * failure is not a type error but a command sent to the wrong power station.
 *
 * So they are branded: distinct types the compiler will not substitute for one
 * another. Crossing into them is deliberate and happens only at the edges —
 * where a database row, an HTTP parameter or a radio advertisement arrives —
 * through the parse functions below. Everywhere inside, the signature is the
 * guarantee.
 */

declare const brand: unique symbol;

type Branded<Name extends string> = string & { readonly [brand]: Name };

/**
 * The core's own id for a device you added.
 *
 * The primary key, the route segment, and what history is keyed by. It outlives
 * every connection detail: rebinding a station to a different unit, or moving a
 * plug to a new address, must not change it, or the charts lose their subject.
 */
export type SavedDeviceId = Branded<'SavedDeviceId'>;

/**
 * A temporary identity, alive only during commissioning.
 *
 * A discovered candidate is not a device — it is evidence that something is
 * reachable. It never reaches the database under this id: completing the wizard
 * mints a `SavedDeviceId`, and this one is forgotten.
 */
export type CandidateId = Branded<'CandidateId'>;

/**
 * The adapter's or vendor's identity for the same thing.
 *
 * A MAC, a Tuya device id, a serial. Unique only within its adapter, which is
 * why it can never be the primary key, and why it must be passed explicitly to
 * an adapter rather than inferred from whatever id happened to be at hand.
 */
export type ProviderDeviceId = Branded<'ProviderDeviceId'>;

/**
 * A station as a radio or a broker knows it: a MAC, a peripheral id.
 *
 * What a link binds to, and deliberately not a `SavedDeviceId`. `bind` takes
 * both — the device that will hold the link, and the station it reaches — and
 * they are the two arguments most worth being unable to swap.
 */
export type StationId = Branded<'StationId'>;

/**
 * Where a raw string becomes an identity.
 *
 * Every one of these is a boundary: a row out of SQLite, a path segment off an
 * HTTP request, an advertisement off the air. Naming the crossing is what keeps
 * it rare and reviewable, and what makes `id as SavedDeviceId` sprinkled
 * through the middle of the code stand out as the mistake it would be.
 */
export const savedDeviceId = (raw: string): SavedDeviceId => raw as SavedDeviceId;
export const candidateId = (raw: string): CandidateId => raw as CandidateId;
export const providerDeviceId = (raw: string): ProviderDeviceId => raw as ProviderDeviceId;
export const stationId = (raw: string): StationId => raw as StationId;

/** Station ids are compared without regard to case: MACs and peripheral ids disagree. */
export const sameStation = (a: StationId | null, b: StationId | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

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
