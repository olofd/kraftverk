import {
  readHoldingRegisters,
  readInputRegisters,
  writeRegister,
  type ParsedFrame,
} from './modbus.ts';
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
import { buildSettings, buildStatus, portRegister, settingsWrites } from './station.ts';
import type {
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
  TransportKind,
} from './types.ts';

/**
 * The station client, independent of how the bytes get there.
 *
 * The server runs this over noble or MQTT; the app runs the very same class
 * over Web Bluetooth or react-native-ble-plx. Everything specific to a
 * Bluetooth stack lives behind `StationTransport`, so the polling cadence, the
 * write whitelist, the read-only guard and the decode all have exactly one
 * implementation. That matters more than the code saved: a station that has to
 * be safe to write to should not have two independently maintained ideas of
 * which writes are safe.
 */

/** Something that looks like a power station, found by a transport. */
export type DiscoveredDevice = {
  /** Stable handle for binding. MAC over MQTT, peripheral id over BLE. */
  id: string;
  kind: TransportKind;
  name: string;
  mac: string | null;
  /** BLE only. */
  rssi?: number;
  firstSeen: string;
  lastSeen: string;
  /**
   * Strong evidence this is actually a power station — a matching advertised
   * service UUID or device name. Only these are auto-bound; anything else must
   * be bound deliberately, so we never connect to a stranger's peripheral.
   */
  likelyStation: boolean;
};

/**
 * A way to exchange MODBUS frames with **one** station.
 *
 * Every transport carries byte-identical frames — the GATT link and the MQTT
 * bridge speak the same protocol — so everything above this interface is shared.
 *
 * This is deliberately the smaller half of what a transport does, and it is
 * exactly what `StationClient` needs: it polls, decodes and writes, and never
 * asks who else is out there. Splitting it out is what lets a server hold
 * several of these at once — one per station — while the app, which really does
 * hold a single link, keeps implementing the whole `StationTransport` below and
 * needs no changes at all.
 */
export interface StationLink {
  readonly kind: TransportKind;

  /** The station this link talks to, if it has one yet. */
  readonly boundId: string | null;

  /** True when that station is reachable right now. */
  readonly connected: boolean;

  send(frame: Uint8Array): Promise<void>;

  /**
   * Sends a frame and resolves with the matching response.
   * `expect` selects which response stream to wait on: telemetry (0x04) or
   * settings (0x03).
   */
  request(frame: Uint8Array, expect: 'input' | 'holding', timeoutMs?: number): Promise<ParsedFrame>;

  onFrame(listener: (frame: ParsedFrame) => void): () => void;
}

/**
 * A link that also owns the radio: it scans, and it binds to one station.
 *
 * The app's transports are these — a browser or a phone holds one station at a
 * time, so discovery and the link belong together there. The server's are not:
 * see `TransportHost` in `server/src/transport/types.ts`, which separates the
 * one radio from the several links it can carry.
 */
export interface StationTransport extends StationLink {
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Devices seen so far. */
  discovered(): DiscoveredDevice[];

  bind(id: string): Promise<void>;
  unbind(): Promise<void>;

  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void;
}

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
  onUpdate?: (status: StationStatus, settings: StationSettings) => void;
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
  #unsubscribe: (() => void) | null = null;

  #telemetry: DecodedTelemetry | null = null;
  #deviceSettings: DecodedSettings | null = null;
  #firmware: FirmwareVersions | null = null;
  #lastSeen: Date | null = null;
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
    return this.#transport.boundId;
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

    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
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
   * Rebinding used to mean telling one transport to bind elsewhere, because
   * there was only ever one. With a link per station, changing which station a
   * saved device means is changing which link it holds — and the frame
   * subscription has to move with it, or the client would go on listening to
   * the station the user just walked away from.
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
  }

  #emit(): void {
    this.#onUpdate?.(this.status(), this.settings());
  }

  #ingest(frame: ParsedFrame | null): boolean {
    if (frame?.kind !== 'registers') return false;
    // Function 0x04 carries telemetry; 0x03 carries settings.
    if (frame.fn === 0x04 && frame.values.length >= 60) {
      this.#telemetry = decodeTelemetry(frame.values);
      return true;
    }
    if (frame.fn === 0x03 && frame.values.length >= 69) {
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
    if (!this.#transport.boundId) return;

    try {
      await this.#enqueue(async () =>
        this.#ingest(
          await this.#transport.request(readInputRegisters(0, INPUT_REGISTER_COUNT), 'input')
        )
      );

      await this.#enqueue(async () =>
        this.#ingest(
          await this.#transport.request(readHoldingRegisters(0, HOLDING_REGISTER_COUNT), 'holding')
        )
      );

      this.#emit();
    } catch (error) {
      // Expected whenever the station is asleep or out of range.
      this.#onError?.(error);
    }
  }

  async #write(register: number, value: number): Promise<void> {
    if (!this.#transport.boundId) throw new Error('No device bound');

    // Whitelist first, so an unsafe value is reported as unsafe even in
    // read-only mode rather than being masked by the read-only refusal.
    assertWritable(register, value);

    if (this.#readOnly) {
      this.#blocked.push({ at: new Date().toISOString(), register, value });
      if (this.#blocked.length > 50) this.#blocked.shift();
      throw new ReadOnlyError(register, value);
    }

    await this.#enqueue(async () => {
      await this.#transport.send(writeRegister(register, value));
      // The device drops frames sent back to back.
      await new Promise((r) => setTimeout(r, 150));
    });
  }

  status(): StationStatus {
    return buildStatus(this.#telemetry, this.#firmware, {
      transport: this.#transport.kind,
      connected: this.#transport.connected,
      deviceId: this.#transport.boundId,
      lastSeen: this.#lastSeen,
      model: this.#model,
    });
  }

  settings(): StationSettings {
    return buildSettings(this.#deviceSettings, this.#temperatureUnit);
  }

  async applySettings(patch: StationSettingsPatch): Promise<StationSettings> {
    // Display preference only — the device has no register for it.
    if (patch.temperatureUnit) this.#temperatureUnit = patch.temperatureUnit;

    const writes = settingsWrites(patch);
    for (const [register, value] of writes) await this.#write(register, value);

    // Re-read rather than trusting the patch: writing DC_INPUT_TYPE moves
    // MAX_CHARGING_CURRENT on the device by itself.
    if (writes.length) await this.#poll();
    return this.settings();
  }

  async setPort(id: PortId, enabled: boolean): Promise<StationStatus> {
    // Known firmware quirk: registers 25/26 toggle on any write rather than
    // honouring the value, so skip the write when we are already in the state.
    const current = this.status().ports.find((p) => p.id === id);
    if (current && current.enabled === enabled) return this.status();

    await this.#write(portRegister(id), enabled ? 1 : 0);
    await this.#poll();
    return this.status();
  }

  /**
   * Diagnostics: read an arbitrary register range.
   *
   * Reads only — no write frame can be produced here — so exploring outside the
   * documented 0-79 window is safe. An out-of-range address simply returns a
   * MODBUS exception, which surfaces as a timeout or a null result.
   */
  async readRange(fn: 3 | 4, start: number, count: number): Promise<number[]> {
    if (!this.#transport.boundId) throw new Error('No device bound');
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
