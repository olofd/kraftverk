/**
 * Which id is which: the ids of what a home keeps, and how a new one is made.
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
export type Branded<Name extends string> = string & { readonly [brand]: Name };
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
/*
  The other ids the core keeps are branded for the same reason: a connection
  id passed where a device id was meant, or an app's id where a link's was,
  is a wrong row updated, not an error. Each crosses in at the edge, named.
*/

/** One way a device is reached: a row of `device_connection`. */
export type ConnectionId = Branded<'ConnectionId'>;
export const connectionId = (raw: string): ConnectionId => raw as ConnectionId;
/** Random bytes as hex, from the random values every place has. */
export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/**
 * A new id: what it is, and 64 random bits (`d-1b6f399a3ff1c2d0`). Opaque —
 * an id that says what it names invites code that reads it. A node's is made
 * by the node and shared by every home it joins, so wide enough that two
 * never meet.
 */
export const newId = (prefix: string): string => `${prefix}-${randomHex(8)}`;
/** A fact about the house between two parts: a row of `device_link`. */
export type LinkId = Branded<'LinkId'>;
export const linkId = (raw: string): LinkId => raw as LinkId;
/** An automation. */
export type AutomationId = Branded<'AutomationId'>;
export const automationId = (raw: string): AutomationId => raw as AutomationId;
