/**
 * A tiny key/value store for choices that should survive a reload.
 *
 * Web gets `localStorage`; native falls back to memory, because the app has no
 * storage dependency. What is kept is deliberately small: which servers, this
 * app's own devices in local mode, and what it owes a server. Notably *not*
 * kept: whether writes from this app are allowed. That one starts refused on
 * every launch, on purpose.
 */

const memory = new Map<string, string>();

const store = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return null;
  }
};

export function readPreference(key: string): string | null {
  try {
    return store()?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writePreference(key: string, value: string): void {
  memory.set(key, value);
  try {
    store()?.setItem(key, value);
  } catch {
    /* memory already has it */
  }
}

export function clearPreference(key: string): void {
  memory.delete(key);
  try {
    store()?.removeItem(key);
  } catch {
    /* memory is already clear */
  }
}
