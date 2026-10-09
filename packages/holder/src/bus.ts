import type { ModeAxis } from '@kraftverk/api-contract';
import type { Actor, AutomationId, ConnectionHealth, EventLevel, Reading, SavedDeviceId, Value } from '@kraftverk/device-sdk';

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

/** A line of a run, as the live stream carries it: a step, a script's own words, or its end. */
export type RunLine = { kind: 'step' | 'log' | 'ended'; depth: number; what: string; outcome: string; detail: string | null };

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
  | { kind: 'automation'; automationId: AutomationId }
  /**
   * One line of a run, as it happens: a step begun or ended, a line a script
   * said with `log`, or the run ended with its summary — what a developer's
   * console follows live.
   */
  | { kind: 'run'; automationId: AutomationId; name: string; runId: string; line: RunLine }
  /**
   * Someone came to, or left, a place the family knows — a home, a zone, a
   * room of a home — as far as they share; or where they are is no longer
   * told there (`unshared`): they share less now, which is not leaving. Who
   * it was is for automations; a stream says only that presence moved.
   */
  | { kind: 'presence'; personId: string; place: WorldPlace; change: 'arrived' | 'left' | 'unshared'; at: string }
  /** A space of a home has someone in it now, or nobody any more. */
  | { kind: 'occupancy'; homeId: string; spaceId: string; occupied: boolean; at: string }
  /**
   * A home's mode on one of its axes changed: from `previous`, to `mode`, by
   * whom — and, set by an automation, the automations whose runs led to it,
   * outermost first: what keeps two from setting it back and forth forever.
   */
  | { kind: 'mode'; homeId: string; axis: ModeAxis; mode: string; previous: string | null; by: Actor; cause: readonly string[]; at: string }
  /** The family's own modes changed: one added, renamed or let go. */
  | { kind: 'modes'; at: string };

/** A place someone can be at: a home, a zone, or a space of a home (its home's id beside it). */
export type WorldPlace = { id: string; kind: 'home' | 'zone' } | { id: string; kind: 'space'; homeId: string };

export type LiveListener = (message: LiveMessage) => void;

/** How far a reading's time must move, its value the same, to be passed on again: what keeps "as of" true without a stream of polls. */
export const FRESH_AGAIN_MS = 60_000;

/**
 * What a device has said since it was last asked, reading by reading.
 *
 * A session's readings come from its cache and are asked for often; most of
 * them have not moved. This keeps what was last passed on, per device, and
 * gives back only the readings whose value changed — or whose time moved by
 * `FRESH_AGAIN_MS` or more: a phone located afresh at the same place is news
 * ("located a minute ago"), a plug polled every two seconds is not — so a
 * stream carries what moved and nothing else.
 */
export class ReadingChanges {
  #last = new Map<string, Map<string, { value: string; at: number }>>();

  /** The readings of `deviceId` whose value differs from the last time, or whose time moved enough; remembers these. */
  since(deviceId: string, readings: readonly Reading[]): Reading[] {
    const last = this.#last.get(deviceId) ?? new Map<string, { value: string; at: number }>();
    this.#last.set(deviceId, last);
    const changed: Reading[] = [];
    for (const reading of readings) {
      const value = JSON.stringify(reading.value);
      const at = Date.parse(reading.at);
      const before = last.get(reading.key);
      if (before && before.value === value && !(at - before.at >= FRESH_AGAIN_MS)) continue;
      last.set(reading.key, { value, at });
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
