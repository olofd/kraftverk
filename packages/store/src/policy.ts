import { isPolicyValueName, POLICY_VALUES, type PolicyValueName, type PolicyValues } from '@kraftverk/device-sdk';

import type { HomeSettings } from './home-settings.ts';

/**
 * The values this home has set that declarations name — how much is a load —
 * kept in `home_setting`. What was never set
 * takes its default; a name no declaration can use any more is not kept.
 */

const KEY = 'policy.values';

export function policyValues(state: HomeSettings): PolicyValues {
  try {
    const kept = JSON.parse(state.get(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(kept).filter(([name, value]) => isPolicyValueName(name) && typeof value === 'number' && Number.isFinite(value)));
  } catch {
    return {};
  }
}

/** Sets one, within its bounds, or back to its default with null. Returns what is now in force. */
export function setPolicyValue(state: HomeSettings, name: PolicyValueName, value: number | null): PolicyValues {
  const next: Record<string, number> = { ...policyValues(state) };
  if (value === null) delete next[name];
  else {
    const spec = POLICY_VALUES[name];
    if (!(value >= spec.min && value <= spec.max)) throw new RangeError(`${spec.label} is from ${spec.min} to ${spec.max} ${spec.unit}`);
    next[name] = value;
  }
  state.set(KEY, JSON.stringify(next));
  return next;
}
