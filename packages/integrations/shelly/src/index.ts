/**
 * Shelly as a platform. See docs/ADDING-A-DEVICE.md.
 *
 * The one place kraftverk meets Shelly (docs/PLAN-INTEGRATIONS.md §1.1): how
 * a Shelly of Gen2 and later is spoken to (`./protocol/`: RPC over a
 * WebSocket on the home network), the way it is reached and found, and the
 * generic type for a Shelly that switches, which describes itself from what
 * it reports. It names no product: a product's own package, built on this,
 * may say more of one.
 *
 * Ported from Home Assistant's `shelly` integration and aioshelly (NOTICE).
 */

export { SHELLY_LAN, SHELLY_WAYS } from './ways.ts';
export { describeShelly, default as shellySwitch } from './switch.ts';
