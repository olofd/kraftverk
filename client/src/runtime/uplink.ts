import type { Reading } from '@kraftverk/device-sdk';
import { putDeviceStore, uploadAudit, uploadReadings, type AuditEntry } from '@kraftverk/api-client';

import { readPreference, writePreference } from '../lib/preferences';

/**
 * What this app owes the server for the connections it holds
 * (docs/DATA-MODEL.md §4): the readings its sessions take, the audit entries
 * its gateway and sessions write, and the device stores they change.
 *
 * Sent every little while, and kept when the server cannot be reached: a
 * reading queued here arrives late and becomes history at the minute it was
 * taken. Audit entries are kept across a reload too — a switch made from a
 * phone on a train must still be on the timeline when it gets home. Readings
 * are kept in memory only, and thinned to one a minute per measurement.
 */

const FLUSH_MS = 20_000;
/** A day of minute readings for a dozen measurements, at most, per device. */
const MAX_QUEUED_READINGS = 20_000;
const MAX_QUEUED_AUDIT = 1000;

type QueuedAudit = Omit<AuditEntry, 'actor' | 'id'>;
type QueuedReadings = { deviceId: string; connectionId: string; identity: string | null; readings: Map<string, Reading> };

export class Uplink {
  #readings = new Map<string, QueuedReadings>();
  #audit: QueuedAudit[];
  #store: { deviceId: string; connectionId: string; key: string; value: unknown }[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #flushing = false;

  constructor(
    private options: {
      /** This app, as the server knows it; null until it has registered. */
      clientId: () => string | null;
      /** Where the audit queue is kept across a reload: one per server. */
      key: string;
      /** The readings to send now, from every session this app holds. */
      collect: () => { deviceId: string; connectionId: string; identity: string | null; readings: readonly Reading[] }[];
    }
  ) {
    try {
      this.#audit = JSON.parse(readPreference(options.key) ?? '[]') as QueuedAudit[];
    } catch {
      this.#audit = [];
    }
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.flush(), FLUSH_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  audit(entry: QueuedAudit): void {
    this.#audit = [...this.#audit, entry].slice(-MAX_QUEUED_AUDIT);
    writePreference(this.options.key, JSON.stringify(this.#audit));
    void this.flush();
  }

  store(deviceId: string, connectionId: string, key: string, value: unknown): void {
    this.#store = [...this.#store.filter((write) => !(write.deviceId === deviceId && write.key === key)), { deviceId, connectionId, key, value }];
    void this.flush();
  }

  /** Readings waiting to go up, for the queue's size on screen. */
  get backlog(): number {
    let count = 0;
    for (const queued of this.#readings.values()) count += queued.readings.size;
    return count + this.#audit.length;
  }

  #queue(deviceId: string, connectionId: string, identity: string | null, readings: readonly Reading[]): void {
    const queued = this.#readings.get(deviceId) ?? { deviceId, connectionId, identity, readings: new Map<string, Reading>() };
    queued.identity = identity ?? queued.identity;
    queued.connectionId = connectionId;
    for (const reading of readings) {
      if (!reading.at || reading.value === null) continue;
      // One per measurement per minute: that is the resolution history keeps.
      const minute = Math.floor(Date.parse(reading.at) / 60_000);
      queued.readings.set(`${reading.key}@${minute}`, reading);
    }
    if (queued.readings.size > MAX_QUEUED_READINGS) {
      const keep = [...queued.readings.entries()].slice(-MAX_QUEUED_READINGS);
      queued.readings = new Map(keep);
    }
    this.#readings.set(deviceId, queued);
  }

  async flush(): Promise<void> {
    const clientId = this.options.clientId();
    if (this.#flushing) return;
    for (const { deviceId, connectionId, identity, readings } of this.options.collect()) this.#queue(deviceId, connectionId, identity, readings);
    if (!clientId) return;
    this.#flushing = true;
    // Each on its own: one device this app no longer holds must not keep the rest from going up.
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch {
        // Kept for the next try: the server is away, or this app no longer holds that connection.
      }
    };
    try {
      if (this.#audit.length) {
        await attempt(async () => {
          const sending = this.#audit.slice(0, 500);
          await uploadAudit(clientId, sending);
          this.#audit = this.#audit.slice(sending.length);
          writePreference(this.options.key, JSON.stringify(this.#audit));
        });
      }
      for (const [deviceId, queued] of [...this.#readings]) {
        if (!queued.readings.size) continue;
        await attempt(async () => {
          const sending = [...queued.readings.entries()].slice(0, 2000);
          await uploadReadings(deviceId, { clientId, connectionId: queued.connectionId, identity: queued.identity, readings: sending.map(([, reading]) => reading) });
          for (const [key] of sending) queued.readings.delete(key);
        });
      }
      for (const write of [...this.#store]) {
        await attempt(async () => {
          await putDeviceStore(write.deviceId, write.key, { clientId, connectionId: write.connectionId, value: write.value });
          this.#store = this.#store.filter((pending) => pending !== write);
        });
      }
    } finally {
      this.#flushing = false;
    }
  }
}
