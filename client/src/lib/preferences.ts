import type { TransportKind } from '@kraftverk/protocol';

/**
 * A tiny key/value store for choices that should survive a reload.
 *
 * Web gets `localStorage`; native falls back to memory, because the app has no
 * storage dependency. What is kept is deliberately small: how you last
 * connected, and to which station. Notably *not* kept: whether writes were
 * allowed. That one starts refused on every launch, on purpose.
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

const STATION_KEY = 'kraftverk.link.station';

/**
 * The station this app last talked to directly, so a reload can pick up where
 * it left off instead of starting at "choose a device" every time.
 *
 * The server keeps its own binding server-side; this is only for the links the
 * app holds itself.
 */
export type RememberedStation = {
  /** Peripheral id — per-origin in a browser, per-app on iOS. Never a MAC. */
  id: string;
  name: string;
  kind: TransportKind;
  /** When it was last connected, for "2 minutes ago" in the UI. */
  at: string;
  /**
   * Whether a reload should reconnect on its own.
   *
   * True while a session ends connected; false once the user disconnects
   * deliberately. Without the distinction, a refreshed tab would silently take
   * the station's single Bluetooth slot back off whoever the user handed it to.
   */
  autoConnect: boolean;
};

export function readRememberedStation(): RememberedStation | null {
  const raw = readPreference(STATION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedStation>;
    if (typeof value.id !== 'string' || typeof value.kind !== 'string') return null;
    return {
      id: value.id,
      name: typeof value.name === 'string' && value.name ? value.name : value.id,
      kind: value.kind as TransportKind,
      at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
      autoConnect: value.autoConnect !== false,
    };
  } catch {
    return null;
  }
}

export function writeRememberedStation(station: RememberedStation): void {
  writePreference(STATION_KEY, JSON.stringify(station));
}

export const forgetRememberedStation = (): void => clearPreference(STATION_KEY);
