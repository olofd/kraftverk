import type { AutomationId, ConnectionHealth, EventLevel, Reading, SavedDeviceId, Value } from '@kraftverk/device-sdk';

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
  /** The readings whose values changed since the last message: not every reading. */
  | { kind: 'readings'; deviceId: SavedDeviceId; readings: readonly Reading[] }
  | { kind: 'health'; deviceId: SavedDeviceId; health: ConnectionHealth }
  | { kind: 'event'; deviceId: SavedDeviceId; event: DeviceEventMessage }
  /** What the device is — its description or information — changed: read it again. */
  | { kind: 'described'; deviceId: SavedDeviceId }
  /**
   * What you have changed — a device added, renamed or removed, a connection
   * or a link — or something a holder elsewhere reported: read the list again.
   */
  | { kind: 'changed'; deviceId: SavedDeviceId | null }
  /** An automation moved: a run started, took a step or ended. What its screen follows, as it goes. */
  | { kind: 'automation'; automationId: AutomationId };

export type LiveListener = (message: LiveMessage) => void;

/**
 * What a device has said since it was last asked, reading by reading.
 *
 * A session's readings come from its cache and are asked for often; most of
 * them have not moved. This keeps what was last passed on, per device, and
 * gives back only the readings whose value changed — a new time alone is not
 * a change — so a stream carries what moved and nothing else.
 */
export class ReadingChanges {
  #last = new Map<string, Map<string, string>>();

  /** The readings of `deviceId` whose value differs from the last time; remembers these. */
  since(deviceId: string, readings: readonly Reading[]): Reading[] {
    const last = this.#last.get(deviceId) ?? new Map<string, string>();
    this.#last.set(deviceId, last);
    const changed: Reading[] = [];
    for (const reading of readings) {
      const value = JSON.stringify(reading.value);
      if (last.get(reading.key) === value) continue;
      last.set(reading.key, value);
      changed.push(reading);
    }
    return changed;
  }

  /** Forgets a device, so everything it says next is new. */
  forget(deviceId: string): void {
    this.#last.delete(deviceId);
  }
}

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
      } catch (error) {
        // One listener failing must not silence the rest — and is said, not lost.
        console.error('[live] a listener failed:', error);
      }
    }
  }

  get listening(): number {
    return this.#listeners.size;
  }
}
