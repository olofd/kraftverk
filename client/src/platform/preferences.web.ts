/**
 * The app's own choices, kept across a reload: in a browser, its
 * `localStorage` — or memory, where a private window refuses it. What is
 * kept is small: the servers it knows, which it uses, what a transport
 * keeps between runs. Not kept: whether writes from this app are allowed —
 * refused on every launch, on purpose. A phone's is `preferences.ts`.
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
