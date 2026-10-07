import type { Value } from '@kraftverk/device-sdk';

import type { FirmwareCalls } from './link.ts';
import { FIRMWARE_EVENTS, ieeeOf, objectOf, updateOf, versionName, type BridgeDevice, type FirmwareState, type UpdateSaid } from './protocol/index.ts';

/*
  Firmware updates on a Zigbee network (docs/PLAN-ZIGBEE.md §5.7), as
  Zigbee2MQTT does them: one device at a time — the rest wait their turn —
  each followed by its own state, not by Zigbee2MQTT's answer, which comes
  only at the end and is lost if the broker restarts meanwhile. What an
  update did is said as the device's events: updated, failed, and its
  settings found otherwise than before.
*/

/** How long the steps of following an update wait; a test plays them faster. */
export const UPDATE_TIMING = {
  /** Without Zigbee2MQTT saying an update began, before it is taken as not begun: it gives a device 60 s to answer. */
  startWaitMs: 3 * 60_000,
  /** After Zigbee2MQTT says an update stopped short, for its reason: its answer comes just after its state. */
  reasonWaitMs: 3000,
  /** After an update, before its settings are asked again: Zigbee2MQTT interviews and configures it anew first. */
  settingsAskMs: 60_000,
  /** And for their answers, before they are compared. */
  settingsCompareMs: 15_000,
};
/** The least a device on batteries must have to start: Zigbee2MQTT's advice. */
const BATTERY_MIN = 70;
/** How long a check waits: Zigbee2MQTT asks the device what it runs first. */
const CHECK_TIMEOUT_MS = 60_000;

/** What the network gives the updates: its requests, its devices, and the way to tell a device's links. */
export type UpdatesHost = {
  /** A bridge request, answered — after `timeoutMs`, or never when it is `Infinity`. */
  request(what: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  device(key: string): BridgeDevice | null;
  values(key: string): Readonly<Record<string, unknown>>;
  /** The device's own settings: what is compared before and after. */
  settings(key: string): readonly { property: string; gettable: boolean }[];
  get(key: string, payload: Record<string, unknown>): Promise<void>;
  /** Tells the device's links something happened to it. */
  event(key: string, id: string, data: Record<string, Value>): void;
  changed(): void;
  log(message: string): void;
};

/** What a device ran and was offered, and its settings, when it was asked to update. */
type Before = { installed: number | null; build: string | null; latest: number | null; source: string | null; settings: Record<string, unknown> };

export class FirmwareUpdates {
  /** The device being updated at kraftverk's asking, and those waiting their turn, oldest first. */
  #current: string | null = null;
  #waiting: string[] = [];
  /** What each device asked to update ran, and its settings, before. */
  #before = new Map<string, Before>();
  /** Where each device's update stood when its state was last heard: what a change is told against. */
  #was = new Map<string, FirmwareState | null>();
  #installed = new Map<string, number | null>();
  /** Why an update stopped short, as Zigbee2MQTT answered or as it was stopped. */
  #reasons = new Map<string, string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #startTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #timing: typeof UPDATE_TIMING;

  constructor(
    private readonly host: UpdatesHost,
    timing: Partial<typeof UPDATE_TIMING> = {}
  ) {
    this.#timing = { ...UPDATE_TIMING, ...timing };
  }

  /** The device being updated now and how far along, for its coordinator to say; null when none is. */
  get current(): { key: string; progress: number | null } | null {
    if (!this.#current) return null;
    const said = updateOf(this.host.values(this.#current).update);
    return { key: this.#current, progress: said?.state === 'updating' ? said.progress : null };
  }

  /** How many devices wait their turn. */
  get waiting(): number {
    return this.#waiting.length;
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#startTimer) clearTimeout(this.#startTimer);
  }

  calls(key: string): FirmwareCalls {
    return { update: () => this.#update(key), stop: () => this.#stop(key), check: () => this.#check(key) };
  }

  // --- asked --------------------------------------------------------------------

  async #update(key: string): Promise<string> {
    const device = this.#updatable(key);
    const said = updateOf(this.host.values(key).update);
    if (said?.state === 'updating') return `It is updating already${said.progress !== null ? `: ${Math.round(said.progress)} %` : ''}`;
    if (said?.state === 'scheduled') return 'It is scheduled already: it updates the next time it wakes and asks';
    if (this.#current === key || this.#waiting.includes(key)) return 'It is waiting its turn already';
    if (said?.state !== 'available') throw new Error('No newer firmware is offered for it: check for one first');

    if (/battery/i.test(device.power_source ?? '')) {
      const battery = this.host.values(key).battery;
      if (typeof battery === 'number' && battery < BATTERY_MIN) throw new Error(`Its battery is at ${battery} %: an update needs at least ${BATTERY_MIN} %, or it may stop half-way`);
      this.#remember(key);
      await this.host.request('device/ota_update/schedule', { id: ieeeOf(key) });
      return 'Scheduled: it updates the next time it wakes and asks — press its button to wake it now. 10–100 minutes; it keeps working meanwhile';
    }

    this.#remember(key);
    if (this.#current) {
      this.#waiting.push(key);
      this.host.changed();
      return `Waiting its turn: another device is updating, and one at a time keeps the network responsive. ${this.#waiting.length === 1 ? 'It is next' : `${this.#waiting.length - 1} before it`}`;
    }
    this.#start(key);
    return 'Updating: Zigbee2MQTT is asking it for the new firmware. 10–100 minutes; it keeps working meanwhile';
  }

  async #stop(key: string): Promise<string> {
    if (this.#waiting.includes(key)) {
      this.#waiting = this.#waiting.filter((other) => other !== key);
      this.#before.delete(key);
      this.host.changed();
      return 'Taken out of line: it keeps the firmware it has';
    }
    const said = updateOf(this.host.values(key).update);
    if (said?.state === 'scheduled') {
      await this.host.request('device/ota_update/unschedule', { id: ieeeOf(key) });
      this.#before.delete(key);
      return 'Unscheduled: it keeps the firmware it has';
    }
    if (said?.state === 'updating' || this.#current === key) {
      this.#reasons.set(key, 'Stopped by a person');
      await this.host.request('device/ota_update/update/abort', { id: ieeeOf(key) });
      return 'Stopped: it keeps the firmware it has';
    }
    return 'It is not updating, nor waiting to';
  }

  async #check(key: string): Promise<string> {
    this.#updatable(key);
    const answer = objectOf(await this.host.request('device/ota_update/check', { id: ieeeOf(key) }, CHECK_TIMEOUT_MS));
    if (answer?.update_available !== true) return 'No newer firmware is offered for it';
    const said = updateOf(this.host.values(key).update);
    const name = said ? versionName(said.latest, said.source) : null;
    return `A newer firmware is offered${name ? `: ${name}` : ''}${typeof answer.release_notes === 'string' && answer.release_notes ? `. ${answer.release_notes.replace(/\s+/g, ' ').trim()}` : ''}`;
  }

  /** The device, if Zigbee2MQTT can update it. */
  #updatable(key: string): BridgeDevice {
    const device = this.host.device(key);
    if (!device) throw new Error('Zigbee2MQTT does not know this device');
    if (!device.definition?.supports_ota) throw new Error('Zigbee2MQTT cannot update this device’s firmware');
    return device;
  }

  /** What it runs, and its settings, before: what after is told against. */
  #remember(key: string): void {
    const values = this.host.values(key);
    const settings = Object.fromEntries(this.host.settings(key).flatMap(({ property }) => (property in values ? [[property, values[property]]] : [])));
    const said = updateOf(values.update);
    this.#before.set(key, { installed: said?.installed ?? null, build: this.host.device(key)?.software_build_id ?? null, latest: said?.latest ?? null, source: said?.source ?? null, settings });
  }

  #start(key: string): void {
    this.#current = key;
    this.#reasons.delete(key);
    this.host.log(`${ieeeOf(key)}: updating its firmware`);
    // Answered only at the end — or never, if the broker restarts meanwhile: its state is followed, and this answer only gives a reason.
    this.host.request('device/ota_update/update', { id: ieeeOf(key) }, Infinity).catch((error: Error) => {
      // A person's stop, said first, is why: Zigbee2MQTT's own answer to it only says it was aborted.
      if (!this.#reasons.has(key)) this.#reasons.set(key, error.message);
      // Refused before it began: nothing in its state will say so.
      if (this.#was.get(key) !== 'updating' && this.#current === key) this.#ended(key, false);
    });
    this.#startTimer = setTimeout(() => {
      this.#startTimer = null;
      if (this.#current === key && this.#was.get(key) !== 'updating') {
        this.#reasons.set(key, this.#reasons.get(key) ?? 'Zigbee2MQTT did not say it began: the device may not have answered');
        this.#ended(key, false);
      }
    }, this.#timing.startWaitMs);
    this.host.changed();
  }

  // --- heard --------------------------------------------------------------------

  /** A device's state, heard: an update that began or ended is told. */
  heard(key: string, values: Readonly<Record<string, unknown>>): void {
    const said: UpdateSaid | null = updateOf(values.update);
    if (!said) return;
    const first = !this.#was.has(key);
    const was = this.#was.get(key) ?? null;
    this.#was.set(key, said.state);
    if (said.installed !== null && !this.#installed.has(key)) this.#installed.set(key, said.installed);
    if (first) return;
    if (said.state === 'updating' && was !== 'updating') {
      // Begun — at kraftverk's asking, or a device on batteries that woke and asked.
      if (this.#current === key && this.#startTimer) {
        clearTimeout(this.#startTimer);
        this.#startTimer = null;
      }
      this.host.changed();
      return;
    }
    if (was === 'updating' && said.state !== 'updating') {
      const before = this.#before.get(key)?.installed ?? this.#installed.get(key) ?? null;
      const done = said.installed !== null && before !== null && said.installed !== before;
      if (done) this.#ended(key, true);
      // Its reason comes just after its state.
      else this.#later(this.#timing.reasonWaitMs, () => this.#ended(key, false));
    }
  }

  #ended(key: string, done: boolean): void {
    const values = this.host.values(key);
    const said = updateOf(values.update);
    const before = this.#before.get(key);
    const from = before?.build ?? versionName(before?.installed ?? this.#installed.get(key) ?? null, null) ?? 'unknown';
    if (done) {
      // Named as its image was, when it is the one offered: Zigbee2MQTT forgets the image once it is installed.
      const to = versionName(said?.installed ?? null, said?.installed === before?.latest ? (before?.source ?? null) : (said?.source ?? null)) ?? 'unknown';
      this.host.event(key, FIRMWARE_EVENTS.updated, { from, to });
      this.host.log(`${ieeeOf(key)}: firmware updated, ${from} → ${to}`);
      if (before) this.#checkSettings(key, before);
    } else {
      const reason = this.#reasons.get(key) ?? 'Zigbee2MQTT stopped it before it was done';
      this.host.event(key, FIRMWARE_EVENTS.failed, { reason });
      this.host.log(`${ieeeOf(key)}: firmware update failed: ${reason}`);
      this.#before.delete(key);
    }
    this.#installed.set(key, said?.installed ?? null);
    this.#reasons.delete(key);
    if (this.#current === key) {
      this.#current = null;
      if (this.#startTimer) clearTimeout(this.#startTimer);
      this.#startTimer = null;
      this.#next();
    }
    this.host.changed();
  }

  #next(): void {
    while (this.#waiting.length) {
      const key = this.#waiting.shift()!;
      // Still offered one, and still there.
      if (this.host.device(key) && updateOf(this.host.values(key).update)?.state === 'available') return this.#start(key);
      this.#before.delete(key);
    }
  }

  /**
   * Its settings asked again once Zigbee2MQTT has interviewed and configured
   * it anew, and compared with before: a new firmware has turned a plug's
   * protections on before — and switched it off with nothing drawing.
   */
  #checkSettings(key: string, before: Before): void {
    this.#later(this.#timing.settingsAskMs, () => {
      const gettable = this.host.settings(key).filter((setting) => setting.gettable && setting.property in before.settings);
      if (gettable.length) void this.host.get(key, Object.fromEntries(gettable.map(({ property }) => [property, '']))).catch(() => undefined);
      this.#later(this.#timing.settingsCompareMs, () => {
        this.#before.delete(key);
        const now = this.host.values(key);
        const changed = Object.entries(before.settings).flatMap(([property, was]) =>
          property in now && JSON.stringify(now[property]) !== JSON.stringify(was) ? [`${property}: ${short(was)} → ${short(now[property])}`] : []
        );
        if (!changed.length) return;
        const said = changed.join('; ');
        this.host.event(key, FIRMWARE_EVENTS.settingsChanged, { changed: said.length > 900 ? `${said.slice(0, 900)}…` : said });
        this.host.log(`${ieeeOf(key)}: settings changed by its new firmware: ${said}`);
      });
    });
  }

  #later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    this.#timers.add(timer);
  }
}

/** A setting's value in a sentence: an object by what changed in it is too much here, so whole, but short. */
function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
