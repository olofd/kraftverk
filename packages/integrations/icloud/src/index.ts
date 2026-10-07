/**
 * iCloud as a platform. See docs/ADDING-A-DEVICE.md.
 *
 * The one place kraftverk meets iCloud (docs/PLAN-INTEGRATIONS.md §1.1): how
 * it is signed into and spoken to (`./protocol/`: Apple's SRP sign-in, a
 * second factor, the trust token kept; Find My), the account as a bridge to
 * every device in its Find My (`./account.ts`), and the device reached
 * through it (`./device.ts`): where it is, how charged, a sound played.
 *
 * Ported from Home Assistant's `icloud` integration and pyicloud (NOTICE).
 */

export { ICLOUD_WAYS, ICLOUD_WEB } from './ways.ts';
export type { FindMyLink } from './link.ts';
