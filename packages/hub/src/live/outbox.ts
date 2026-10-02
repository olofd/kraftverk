import type { ConnectionHealth, LiveUpdate } from '@kraftverk/api-contract';
import type { AutomationId, Reading, SavedDeviceId } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

/** Events kept for a listener that is not draining; past this, it is told to read everything again instead. */
const MAX_QUEUED_EVENTS = 100;

/**
 * What one listener of the live stream has waiting, coalesced: a reading by
 * its key, health by its device, a change to the list once — so a device that
 * chatters costs a phone nothing extra, and a slow one is sent the latest
 * rather than a backlog.
 */
export class Outbox {
  readings = new Map<SavedDeviceId, Map<string, Reading>>();
  health = new Map<SavedDeviceId, ConnectionHealth>();
  events: LiveUpdate[] = [];
  changed = false;
  /** Automations that moved: each is said once, however often it moved since. */
  automations = new Set<AutomationId>();

  add(message: LiveMessage): void {
    switch (message.kind) {
      case 'readings': {
        const waiting = this.readings.get(message.deviceId) ?? new Map<string, Reading>();
        for (const reading of message.readings) waiting.set(reading.key, reading);
        this.readings.set(message.deviceId, waiting);
        return;
      }
      case 'health':
        this.health.set(message.deviceId, message.health);
        return;
      case 'event':
        if (this.events.length >= MAX_QUEUED_EVENTS) {
          this.events = [];
          this.changed = true;
          return;
        }
        this.events.push({ type: 'event', deviceId: message.deviceId, event: message.event });
        return;
      case 'described':
      case 'changed':
        this.changed = true;
        return;
      case 'automation':
        this.automations.add(message.automationId);
    }
  }

  /** Everything waiting, in the order it is best applied, and empties. */
  take(): LiveUpdate[] {
    const updates: LiveUpdate[] = [];
    // Read the list again first: what follows is applied on top of it.
    if (this.changed) updates.push({ type: 'changed', deviceId: null });
    for (const [deviceId, readings] of this.readings) updates.push({ type: 'readings', deviceId, readings: [...readings.values()] });
    for (const [deviceId, health] of this.health) updates.push({ type: 'health', deviceId, health });
    updates.push(...this.events);
    for (const id of this.automations) updates.push({ type: 'automation', id });
    this.readings.clear();
    this.health.clear();
    this.events = [];
    this.changed = false;
    this.automations.clear();
    return updates;
  }
}
