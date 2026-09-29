import type { ConnectionHealth, EventLevel, Reading, SavedDeviceId, Value } from '@kraftverk/device-sdk';

/**
 * What a holder hears from the devices it holds, as it happens
 * (docs/ARCHITECTURE.md §4.7).
 *
 * Readings, health, events and changes to what a device is: published by the
 * holder as its sessions report them, and listened to by whatever needs them
 * at once — the server's live stream to the app, automations waiting on an
 * event or a threshold, a bridge to Home Assistant. A listener that throws is
 * its own problem: the others still hear.
 */

export type DeviceEventMessage = {
  id: string;
  level: EventLevel;
  part: string | null;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

export type LiveMessage =
  | { kind: 'readings'; deviceId: SavedDeviceId; readings: readonly Reading[] }
  | { kind: 'health'; deviceId: SavedDeviceId; health: ConnectionHealth }
  | { kind: 'event'; deviceId: SavedDeviceId; event: DeviceEventMessage }
  /** What the device is — its description or information — changed: read it again. */
  | { kind: 'described'; deviceId: SavedDeviceId };

export type LiveListener = (message: LiveMessage) => void;

export class LiveBus {
  #listeners = new Set<LiveListener>();

  /** Hears every message from now on. Returns how to stop. */
  subscribe(listener: LiveListener): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  publish(message: LiveMessage): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch {
        // One listener failing must not silence the rest.
      }
    }
  }

  get listening(): number {
    return this.#listeners.size;
  }
}
