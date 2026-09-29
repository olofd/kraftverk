/**
 * What the station brings to automations (docs/AUTOMATIONS.md): the events of
 * its mains input. `acInput` declares them, so the shared recipes ("when mains
 * power is lost") hear this station as they would any other; the recipes that
 * need only what a P280 does — the reserve controller — will live here.
 */

/** Raises `mains.lost` and `mains.restored` when the station's mains presence changes — never on its first reading. */
export function mainsWatcher(raise: (event: 'mains.lost' | 'mains.restored') => void): (present: boolean | null) => void {
  let last: boolean | null = null;
  return (present) => {
    if (present === null) return;
    if (last !== null && present !== last) raise(present ? 'mains.restored' : 'mains.lost');
    last = present;
  };
}
