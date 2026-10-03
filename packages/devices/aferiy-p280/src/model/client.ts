import {
  readHoldingRegisters,
  readInputRegisters,
  writeRegister,
  type ParsedFrame,
  type SydpowerLink,
} from '@kraftverk/protocol-sydpower';
import {
  assertWritable,
  decodeFirmware,
  decodeSettings,
  decodeTelemetry,
  HOLDING_REGISTER_COUNT,
  INPUT_REGISTER_COUNT,
  type DecodedSettings,
  type DecodedTelemetry,
  type FirmwareVersions,
} from './registers.ts';
import { buildSettings, buildStatus, PORT_LABELS, portEnabled, portRegister, settingsWrites } from './station.ts';
import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from './types.ts';

/**
 * The station client, independent of how the bytes get there.
 *
 * It runs wherever the station's connection is held — on the server over its
 * broker or its radio, in the app over the browser's or the phone's Bluetooth —
 * over the link the protocol builds on that channel. So the polling cadence, the
 * write whitelist, the read-only guard and the decode all have exactly one
 * implementation. That matters more than the code saved: a station that has to
 * be safe to write to should not have two independently maintained ideas of
 * which writes are safe.
 */

/**
 * What `StationClient` needs of a link: the part of `SydpowerLink` that polls,
 * decodes and writes, and never asks who else is out there. The protocol's
 * `linkOver` gives one over any channel; tests give a scripted one.
 */
export type StationLink = Pick<SydpowerLink, 'transport' | 'address' | 'connected' | 'send' | 'request' | 'onFrame'>;

/**
 * Deliberately says nothing about *how* to turn writes on: the server maps this
 * to HTTP 423 and the app has its own wording for that, while a direct link
 * shows this text as-is. Naming `--read-only` here would be wrong advice to
 * half the people who see it.
 */
export class ReadOnlyError extends Error {
  constructor(register: number, value: number) {
    super(`Refused to write ${value} to register ${register}: this link is read-only.`);
  }
}

/**
 * An output could not be switched safely, or did not switch.
 *
 * The station's output registers toggle on any write instead of taking the
 * value written, so a switch is only safe when the output's state is known at
 * the moment of writing. When it is not, nothing is sent; when the station
 * does not report the new state afterwards, that is said rather than
 * reported as success. The server maps this to HTTP 409.
 */
export class PortSwitchError extends Error {}

/**
 * A write that waited too long behind other work to still be wanted.
 *
 * Sending it anyway would change the hardware long after whoever asked for it
 * was told it failed — and has perhaps tried again.
 */
export class StaleWriteError extends Error {}

/** How long a write may wait for its turn before it is dropped instead of sent. */
export const WRITE_DEADLINE_MS = 15_000;

export type BlockedWrite = { at: string; register: number; value: number };

export type StationClientOptions = {
  /** Only the link half is needed: this class never asks what else is out there. */
  transport: StationLink;
  pollMs?: number;
  /**
   * Refuse every write, at the lowest level that still knows a frame is a
   * write. For bringing up an unfamiliar unit: poll and decode freely while
   * making it impossible to change anything on the hardware.
   */
  readOnly?: boolean;
  model?: string;
  /** Called after every successful poll, for UIs that want to re-render. */
  onUpdate?: (status: StationStatus, settings: StationSettings | null) => void;
  /** Called when a poll fails, so a UI can show why it went quiet. */
  onError?: (error: unknown) => void;
};

export class StationClient {
  #transport: StationLink;
  #pollMs: number;
  #readOnly: boolean;
  #model: string | undefined;
  #onUpdate: StationClientOptions['onUpdate'];
  #onError: StationClientOptions['onError'];

  /** Writes blocked while read-only, for the diagnostics view. */
  #blocked: BlockedWrite[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** The poll in progress, if any — so the timer never stacks a second behind it. */
  #polling: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;

  #telemetry: DecodedTelemetry | null = null;
  #deviceSettings: DecodedSettings | null = null;
  #firmware: FirmwareVersions | null = null;
  #lastSeen: Date | null = null;
  /** When the last telemetry frame was decoded. */
  #readingAt: Date | null = null;
  #temperatureUnit: StationSettings['temperatureUnit'] = 'C';

  constructor(options: StationClientOptions) {
    this.#transport = options.transport;
    this.#pollMs = options.pollMs ?? 5000;
    this.#readOnly = options.readOnly ?? false;
    this.#model = options.model;
    this.#onUpdate = options.onUpdate;
    this.#onError = options.onError;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  set readOnly(value: boolean) {
    this.#readOnly = value;
  }

  get blockedWrites(): BlockedWrite[] {
    return this.#blocked;
  }

  get transport(): StationLink {
    return this.#transport;
  }

  get mac(): string | null {
    return this.#transport.address || null;
  }

  /** True once a telemetry frame has been decoded — i.e. the UI has real data. */
  get hasData(): boolean {
    return this.#telemetry !== null;
  }

  async start(): Promise<void> {
    // Stations push telemetry unprompted (every 60s over MQTT, and after each
    // request on both transports), so absorb those rather than relying only on
    // our own polls.
    this.#unsubscribe = this.#transport.onFrame((frame) => {
      this.#lastSeen = new Date();
      if (this.#ingest(frame)) this.#emit();
    });

    /*
      Skipped while the last poll is still running. A station that has gone
      quiet makes every request wait out its timeout — 8 s over Bluetooth,
      longer than the interval — and stacking polls behind one another grew
      the queue without end, with any write waiting at the back of it.
    */
    this.#timer = setInterval(() => {
      if (this.#polling) return;
      this.#polling = this.#poll().finally(() => {
        this.#polling = null;
      });
    }, this.#pollMs);
    // Deliberately not awaited: a station that is asleep, out of range or not
    // bound yet would otherwise hold up whatever started us — on the server
    // that is the HTTP listener, which must come up regardless. Callers that
    // want a first reading before continuing can await `poll()`.
    void this.#poll();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Points this client at a different link.
   *
   * There is a link per station, so changing which station a saved device means
   * is changing which link it holds. The frame subscription moves with it: a
   * client left listening to its previous link would go on decoding the station
   * the user just walked away from.
   *
   * Callers almost always want `reset()` too: the cached telemetry describes
   * the old station.
   */
  retarget(link: StationLink): void {
    const running = this.#unsubscribe !== null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#transport = link;
    if (running) {
      this.#unsubscribe = this.#transport.onFrame((frame) => {
        this.#lastSeen = new Date();
        if (this.#ingest(frame)) this.#emit();
      });
    }
  }

  /** Drops cached telemetry, e.g. after binding a different station. */
  reset(): void {
    this.#telemetry = null;
    this.#deviceSettings = null;
    this.#firmware = null;
    this.#lastSeen = null;
    this.#readingAt = null;
  }

  #emit(): void {
    this.#onUpdate?.(this.status(), this.settings());
  }

  #ingest(frame: ParsedFrame | null): boolean {
    if (frame?.kind !== 'registers') return false;
    // Function 0x04 carries telemetry; 0x03 carries settings — each the block from register 0, and nothing
    // else: a diagnostics read of other registers shares the channel, and is not the station's state.
    const block = (count: number) => (frame.start === 0 && frame.values.length >= 60) || (frame.start === null && frame.values.length === count);
    if (frame.fn === 0x04 && block(INPUT_REGISTER_COUNT)) {
      this.#telemetry = decodeTelemetry(frame.values);
      this.#readingAt = new Date();
      return true;
    }
    if (frame.fn === 0x03 && block(HOLDING_REGISTER_COUNT) && frame.values.length >= 69) {
      this.#deviceSettings = decodeSettings(frame.values);
      this.#firmware = decodeFirmware(frame.values);
      return true;
    }
    return false;
  }

  /** Serialises work so only one MODBUS exchange is in flight at a time. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Reads both register banks. Public so a UI can force a refresh. */
  async poll(): Promise<void> {
    return this.#poll();
  }

  async #poll(): Promise<void> {
    if (!this.#transport.address) return;

    /*
      Pinned for the whole poll.

      `#enqueue` runs its task later, and a task that reads `this.#transport`
      when it *runs* reads whatever the link is by then. Rebinding between the
      two halves of a poll would therefore decode one station's input registers
      and the other's holding registers into a single cache — station A's charge
      level under station B's name, until the next poll corrected it.
    */
    const link = this.#transport;
    const ingestFrom = async (frame: ParsedFrame) => {
      if (link !== this.#transport) return; // retargeted mid-flight; not ours
      this.#ingest(frame);
    };

    try {
      await this.#enqueue(async () =>
        ingestFrom(await link.request(readInputRegisters(0, INPUT_REGISTER_COUNT), 'input'))
      );

      await this.#enqueue(async () =>
        ingestFrom(await link.request(readHoldingRegisters(0, HOLDING_REGISTER_COUNT), 'holding'))
      );

      if (link === this.#transport) this.#emit();
    } catch (error) {
      // Expected whenever the station is asleep or out of range.
      this.#onError?.(error);
    }
  }

  /** Everything that must hold before a write is even queued. */
  #checkWrite(register: number, value: number): void {
    if (!this.#transport.address) throw new Error('No station to write to');

    // Whitelist first, so an unsafe value is reported as unsafe even in
    // read-only mode rather than being masked by the read-only refusal.
    assertWritable(register, value);

    if (this.#readOnly) {
      this.#blocked.push({ at: new Date().toISOString(), register, value });
      if (this.#blocked.length > 50) this.#blocked.shift();
      throw new ReadOnlyError(register, value);
    }
  }

  /**
   * Runs a write's turn on the queue, on the link it was meant for, while it
   * is still wanted.
   *
   * Pinned, and refused if it moved. The queue defers this, so reading
   * `this.#transport` when the task runs would send the write to whatever
   * station the client points at *by then*. A write meant for the station in
   * the van, applied to the one in the shed, is the worst outcome this codebase
   * has — one of these registers bricks the hardware. Refusing is the only safe
   * answer; the caller can retry against the station it meant.
   *
   * And dropped if it waited too long: see `StaleWriteError`.
   */
  #writeTurn<T>(work: (link: StationLink) => Promise<T>): Promise<T> {
    const link = this.#transport;
    const queuedAt = Date.now();
    return this.#enqueue(async () => {
      if (link !== this.#transport) {
        throw new Error('The station changed before this write was sent, so it was not applied.');
      }
      if (Date.now() - queuedAt > WRITE_DEADLINE_MS) {
        throw new StaleWriteError(
          `The station was busy or not answering for over ${WRITE_DEADLINE_MS / 1000} s, so the change was not sent.`
        );
      }
      return work(link);
    });
  }

  /** One register write on the wire, then the pause the device needs. */
  async #send(link: StationLink, register: number, value: number): Promise<void> {
    await link.send(writeRegister(register, value));
    // The device drops frames sent back to back.
    await new Promise((r) => setTimeout(r, 150));
  }

  async #write(register: number, value: number): Promise<void> {
    this.#checkWrite(register, value);
    await this.#writeTurn((link) => this.#send(link, register, value));
  }

  status(): StationStatus {
    return buildStatus(this.#telemetry, this.#firmware, {
      transport: this.#transport.transport,
      connected: this.#transport.connected,
      deviceId: this.#transport.address || null,
      lastSeen: this.#lastSeen,
      readingAt: this.#readingAt,
      model: this.#model,
    });
  }

  /** The station's settings, or null until they have been read from it. */
  settings(): StationSettings | null {
    return buildSettings(this.#deviceSettings, this.#temperatureUnit);
  }

  async applySettings(patch: StationSettingsPatch): Promise<StationSettings | null> {
    // Display preference only — the device has no register for it.
    if (patch.temperatureUnit) this.#temperatureUnit = patch.temperatureUnit;

    const writes = settingsWrites(patch);
    for (const [register, value] of writes) await this.#write(register, value);

    // Re-read rather than trusting the patch: writing DC_INPUT_TYPE moves
    // MAX_CHARGING_CURRENT on the device by itself.
    if (writes.length) await this.#poll();
    return this.settings();
  }

  /**
   * Switches an output on or off — and only ever to the state asked for.
   *
   * The station's output registers toggle on any write rather than taking the
   * value written, so the write must be skipped when the output is already
   * there. Deciding that from the cached reading was the danger: with no
   * reading yet it said "off", so "on" was sent to outlets that were on, and
   * turned them off; a button pressed at the unit since the last poll, or a
   * second tap racing the first, did the same.
   *
   * So the state is read fresh, and the decision and the write happen in the
   * same turn on the queue — nothing can come between them. No answer means
   * nothing is sent. Afterwards the station must report the new state, or the
   * caller hears that it did not.
   */
  async setPort(id: PortId, enabled: boolean): Promise<StationStatus> {
    const register = portRegister(id);
    const value = enabled ? 1 : 0;
    this.#checkWrite(register, value);
    const label = PORT_LABELS[id];

    const wrote = await this.#writeTurn(async (link) => {
      let frame: ParsedFrame;
      try {
        frame = await link.request(readInputRegisters(0, INPUT_REGISTER_COUNT), 'input');
      } catch {
        throw new PortSwitchError(
          `Did not switch “${label}”: the station did not answer, and an output can only be switched safely when its current state is known.`
        );
      }
      this.#lastSeen = new Date();
      if (!this.#ingest(frame) || !this.#telemetry) {
        throw new PortSwitchError(`Did not switch “${label}”: the station's answer could not be read.`);
      }
      if (portEnabled(this.#telemetry, id) === enabled) return false;
      await this.#send(link, register, value);
      return true;
    });

    if (!wrote) {
      this.#emit();
      return this.status();
    }

    // The station may take a moment to report the change.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      await this.#poll();
      if (this.#telemetry && portEnabled(this.#telemetry, id) === enabled) return this.status();
    }
    throw new PortSwitchError(
      `Sent the switch for “${label}”, but the station does not report it ${enabled ? 'on' : 'off'}. Check the station before trying again.`
    );
  }

  /**
   * Diagnostics: read an arbitrary register range.
   *
   * Reads only — no write frame can be produced here — so exploring outside the
   * documented 0-79 window is safe. An out-of-range address simply returns a
   * MODBUS exception, which surfaces as a timeout or a null result.
   */
  async readRange(fn: 3 | 4, start: number, count: number): Promise<number[]> {
    if (!this.#transport.address) throw new Error('No station to write to');
    const build = fn === 4 ? readInputRegisters : readHoldingRegisters;
    const frame = await this.#enqueue(() =>
      this.#transport.request(build(start, count), fn === 4 ? 'input' : 'holding')
    );
    return frame.kind === 'registers' ? frame.values : [];
  }

  /** Diagnostics: dump every input register as raw values. */
  readAllInput(): Promise<number[]> {
    return this.readRange(4, 0, INPUT_REGISTER_COUNT);
  }

  /** Diagnostics: dump every holding register as raw values. */
  readAllHolding(): Promise<number[]> {
    return this.readRange(3, 0, HOLDING_REGISTER_COUNT);
  }
}
