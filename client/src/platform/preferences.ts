import Storage from 'expo-sqlite/kv-store';

/**
 * The app's own choices, kept across a restart: on a phone, in expo-sqlite's
 * key-value store — a small SQLite file of its own, synchronous, as a
 * browser's storage is. What is kept is small: the servers it knows, which
 * it uses, what a transport keeps between runs. Not kept: whether writes
 * from this app are allowed — refused on every launch, on purpose. A
 * browser's is `preferences.web.ts`.
 */

export function readPreference(key: string): string | null {
  return Storage.getItemSync(key);
}

export function writePreference(key: string, value: string): void {
  Storage.setItemSync(key, value);
}

export function clearPreference(key: string): void {
  Storage.removeItemSync(key);
}
