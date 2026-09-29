import type { DeviceDescription, DeviceInfo, Reading } from '@kraftverk/device-sdk';
import { putDeviceStore, uploadAudit, uploadReadings, type AuditUpload, type LiveEvent } from '@kraftverk/api-client';

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
const MAX_QUEUED_EVENTS = 500;

type QueuedReadings = {
  deviceId: string;
  connectionId: string;
  identity: string | null;
  readings: Map<string, Reading>;
  /** What the device is now, and what it says of itself — sent when it differs from what was last sent. */
  description: DeviceDescription | null;
  info: DeviceInfo | null;
  sentDescription: string | null;
  /** What the device said happened, in order, until the server has it. */
  events: LiveEvent[];
};

/** What a session this app holds has to send. */
export type Collected = {
  deviceId: string;
  connectionId: string;
  identity: string | null;
  readings: readonly Reading[];
  description?: DeviceDescription | null;
  info?: DeviceInfo | null;
};

export class Uplink {
  #readings = new Map<string, QueuedReadings>();
  #audit: AuditUpload[];
  #store: { deviceId: string; connectionId: string; key: string; value: unknown }[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(
    private options: {
      /** This app, as the server knows it; null until it has registered. */
      clientId: () => string | null;
      /** Where the audit queue is kept across a reload: one per server. */
      key: string;
      /** The readings to send now, from every session this app holds. */
      collect: () => Collected[];
    }
  ) {
    try {
      this.#audit = JSON.parse(readPreference(options.key) ?? '[]') as AuditUpload[];
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

  audit(entry: AuditUpload): void {
    this.#audit = [...this.#audit, entry].slice(-MAX_QUEUED_AUDIT);
    writePreference(this.options.key, JSON.stringify(this.#audit));
    void this.flush();
  }

  /** Something a device this app holds said happened: sent with its readings, and kept on the server as its own devices' events are. */
  event(deviceId: string, connectionId: string, event: LiveEvent): void {
    const queued = this.#queued(deviceId, connectionId);
    queued.events = [...queued.events, event].slice(-MAX_QUEUED_EVENTS);
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

  #queued(deviceId: string, connectionId: string): QueuedReadings {
    const queued = this.#readings.get(deviceId) ?? { deviceId, connectionId, identity: null, readings: new Map<string, Reading>(), description: null, info: null, sentDescription: null, events: [] };
    queued.connectionId = connectionId;
    this.#readings.set(deviceId, queued);
    return queued;
  }

  #queue({ deviceId, connectionId, identity, readings, description, info }: Collected): void {
    const queued = this.#queued(deviceId, connectionId);
    queued.identity = identity ?? queued.identity;
    queued.description = description ?? queued.description;
    queued.info = info ?? queued.info;
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

  /**
   * Sends what is queued. One run at a time; asked again while one runs, it
   * runs once more when that one ends — so an audit entry queued mid-run goes
   * up then, not at the next timer — and the promise covers both.
   */
  flush(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#flushOnce();
      } while (this.#again);
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #flushOnce(): Promise<void> {
    const clientId = this.options.clientId();
    for (const collected of this.options.collect()) this.#queue(collected);
    if (!clientId) return;
    // Each on its own: one device this app no longer holds must not keep the rest from going up.
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch {
        // Kept for the next try: the server is away, or this app no longer holds that connection.
      }
    };
    if (this.#audit.length) {
      await attempt(async () => {
        const sending = this.#audit.slice(0, 500);
        await uploadAudit(clientId, sending);
        this.#audit = this.#audit.slice(sending.length);
        writePreference(this.options.key, JSON.stringify(this.#audit));
      });
    }
    for (const [deviceId, queued] of [...this.#readings]) {
      if (!queued.readings.size && !queued.events.length) continue;
      await attempt(async () => {
        const sending = [...queued.readings.entries()].slice(0, 2000);
        const events = queued.events.slice(0, 500);
        const description = queued.description ? JSON.stringify(queued.description) : null;
        const describe = description !== null && description !== queued.sentDescription;
        await uploadReadings(deviceId, {
          clientId,
          connectionId: queued.connectionId,
          identity: queued.identity,
          readings: sending.map(([, reading]) => reading),
          ...(describe ? { description: queued.description!, ...(queued.info ? { info: queued.info } : {}) } : {}),
          ...(events.length ? { events } : {}),
        });
        if (describe) queued.sentDescription = description;
        for (const [key] of sending) queued.readings.delete(key);
        queued.events = queued.events.slice(events.length);
      });
    }
    for (const write of [...this.#store]) {
      await attempt(async () => {
        await putDeviceStore(write.deviceId, write.key, { clientId, connectionId: write.connectionId, value: write.value });
        this.#store = this.#store.filter((pending) => pending !== write);
      });
    }
  }
}
