import type { Transport } from '../transport/types.ts';
import {
  readHoldingRegisters,
  readInputRegisters,
  writeRegister,
  type ParsedFrame,
} from '../protocol/modbus.ts';
import {
  assertWritable,
  decodeSettings,
  decodeTelemetry,
  HOLDING,
  HOLDING_REGISTER_COUNT,
  INPUT_REGISTER_COUNT,
  type DecodedSettings,
  type DecodedTelemetry,
} from '../protocol/registers.ts';
import { LED_MODES, type LedMode, type PortId, type StationSettings, type StationSettingsPatch, type StationStatus } from '../types.ts';
import type { StationDriver } from './types.ts';

/** AFERIY P280: 2048Wh base pack, each expansion adds another 2048Wh. */
const BASE_CAPACITY_WH = 2048;
const MODEL = 'AFERIY P280';

export type DeviceDriverOptions = {
  transport: Transport;
  pollMs?: number;
  /**
   * Refuse every write, at the lowest level that still knows a frame is a
   * write. For bringing up an unfamiliar unit: poll and decode freely while
   * making it impossible to change anything on the hardware.
   */
  readOnly?: boolean;
};

export class ReadOnlyError extends Error {
  constructor(register: number, value: number) {
    super(
      `Refused to write ${value} to register ${register}: the server is in read-only mode. ` +
        `Restart without --read-only to allow writes.`
    );
  }
}

/**
 * Talks to a real station over the embedded MQTT broker.
 *
 * Requests are serialised: the protocol carries no correlation id, so two
 * in-flight reads would be impossible to tell apart.
 */
export class DeviceDriver implements StationDriver {
  readonly mode = 'device' as const;

  #transport: Transport;
  #pollMs: number;
  #readOnly: boolean;
  /** Writes blocked while read-only, for the diagnostics view. */
  #blocked: { at: string; register: number; value: number }[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  #telemetry: DecodedTelemetry | null = null;
  #deviceSettings: DecodedSettings | null = null;
  #lastSeen: Date | null = null;
  #temperatureUnit: StationSettings['temperatureUnit'] = 'C';

  constructor(options: DeviceDriverOptions) {
    this.#transport = options.transport;
    this.#pollMs = options.pollMs ?? 5000;
    this.#readOnly = options.readOnly ?? false;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get blockedWrites(): { at: string; register: number; value: number }[] {
    return this.#blocked;
  }

  get transport(): Transport {
    return this.#transport;
  }

  get mac(): string | null {
    return this.#transport.boundId;
  }

  async start(): Promise<void> {
    // Stations push telemetry unprompted (every 60s over MQTT, and after each
    // request on both transports), so absorb those rather than relying only on
    // our own polls.
    this.#transport.onFrame((frame) => {
      this.#lastSeen = new Date();
      this.#ingest(frame);
    });

    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
    void this.#poll();
  }

  /** Drops cached telemetry, e.g. after binding a different station. */
  reset(): void {
    this.#telemetry = null;
    this.#deviceSettings = null;
    this.#lastSeen = null;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #ingest(frame: ParsedFrame | null): void {
    if (frame?.kind !== 'registers') return;
    // Function 0x04 carries telemetry; 0x03 carries settings.
    if (frame.fn === 0x04 && frame.values.length >= 60) {
      this.#telemetry = decodeTelemetry(frame.values);
    } else if (frame.fn === 0x03 && frame.values.length >= 69) {
      this.#deviceSettings = decodeSettings(frame.values);
    }
  }

  /** Serialises work so only one MODBUS exchange is in flight at a time. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
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
    } catch (error) {
      // Expected whenever the station is asleep or out of range.
      if (process.env.DEBUG_LINK) console.warn('[device] poll failed:', error);
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
    const t = this.#telemetry;
    const packs = 1 + (t?.expansionSoc.length ?? 0);

    const state: StationStatus['state'] = !t
      ? 'standby'
      : t.charging
        ? 'charging'
        : t.totalOutputWatts > 5
          ? 'discharging'
          : t.acInputConnected
            ? 'idle'
            : 'standby';

    const linkState: StationStatus['link']['state'] = !this.#transport.boundId
      ? 'waiting'
      : t && this.#transport.connected
        ? 'connected'
        : 'offline';

    const ports: StationStatus['ports'] = [
      { id: 'ac', label: 'AC outlets', enabled: t?.acOutputEnabled ?? false, watts: t?.acOutputWatts ?? 0 },
      { id: 'dc', label: '12V DC / car port', enabled: t?.dcOutputEnabled ?? false, watts: t?.dcOutputWatts ?? 0 },
      { id: 'usb', label: 'USB-A + USB-C', enabled: t?.usbOutputEnabled ?? false, watts: t?.usbOutputWatts ?? 0 },
      { id: 'led', label: 'Light', enabled: t?.ledEnabled ?? false, watts: t?.ledWatts ?? 0 },
    ];

    return {
      name: 'Aferiy Powerstation',
      model: MODEL,
      state,
      link: {
        mode: 'device',
        state: linkState,
        transport: this.#transport.kind,
        mac: this.#transport.boundId,
        lastSeen: this.#lastSeen?.toISOString() ?? null,
      },
      level: t?.socPercent ?? 0,
      expansionSoc: t?.expansionSoc ?? [],
      capacityWh: BASE_CAPACITY_WH * packs,
      gridConnected: t?.acInputConnected ?? false,
      solarConnected: t?.dcInputConnected ?? false,
      acInputWatts: Math.max(0, (t?.totalInputWatts ?? 0) - (t?.dcInputWatts ?? 0)),
      solarInputWatts: t?.dcInputWatts ?? 0,
      totalInputWatts: t?.totalInputWatts ?? 0,
      totalOutputWatts: t?.totalOutputWatts ?? 0,
      acInputVolts: t?.acInputVolts ?? 0,
      acInputHz: t?.acInputHz ?? 0,
      acOutputVolts: t?.acOutputVolts ?? 0,
      acOutputHz: t?.acOutputHz ?? 0,
      minutesToFull: t?.minutesToFull ?? null,
      minutesRemaining: t?.minutesToEmpty ?? null,
      chargeBookingMinutes: t?.chargingBookingMinutes ?? 0,
      ports,
      lastUpdated: (this.#lastSeen ?? new Date()).toISOString(),
    };
  }

  settings(): StationSettings {
    const s = this.#deviceSettings;
    const ledMode: LedMode = LED_MODES[s?.ledMode ?? 0] ?? 'off';

    const oneOf = <T extends number>(value: number, allowed: readonly T[], fallback: T): T =>
      (allowed as readonly number[]).includes(value) ? (value as T) : fallback;

    return {
      chargeLimit: Math.round(s?.chargingUpperLimitPercent ?? 100),
      dischargeFloor: Math.round(s?.dischargeLowerLimitPercent ?? 0),
      maxChargingCurrent: s?.maxChargingCurrent || 20,
      acSilentCharging: s?.acSilentCharging ?? false,
      stopChargeAfterMinutes: s?.stopChargeAfterMinutes ?? 0,
      ledMode,
      keySound: s?.keySound ?? true,
      usbStandbyMinutes: oneOf(s?.usbStandbyMinutes ?? 0, [0, 3, 5, 10, 30] as const, 0),
      acStandbyMinutes: oneOf(s?.acStandbyMinutes ?? 0, [0, 480, 960, 1440] as const, 0),
      dcStandbyMinutes: oneOf(s?.dcStandbyMinutes ?? 0, [0, 480, 960, 1440] as const, 0),
      screenRestSeconds: oneOf(
        s?.screenRestSeconds ?? 300,
        [0, 180, 300, 600, 1800] as const,
        300
      ),
      sleepMinutes: oneOf(s?.sleepMinutes ?? 480, [5, 10, 30, 480] as const, 480),
      temperatureUnit: this.#temperatureUnit,
    };
  }

  async applySettings(patch: StationSettingsPatch): Promise<StationSettings> {
    // Display preference only — the device has no register for it.
    if (patch.temperatureUnit) this.#temperatureUnit = patch.temperatureUnit;

    const writes: [number, number][] = [];
    if (patch.chargeLimit !== undefined)
      writes.push([HOLDING.AC_CHARGING_UPPER_LIMIT, patch.chargeLimit * 10]);
    if (patch.dischargeFloor !== undefined)
      writes.push([HOLDING.DISCHARGE_LOWER_LIMIT, patch.dischargeFloor * 10]);
    if (patch.maxChargingCurrent !== undefined)
      writes.push([HOLDING.MAX_CHARGING_CURRENT, patch.maxChargingCurrent]);
    if (patch.acSilentCharging !== undefined)
      writes.push([HOLDING.AC_SILENT_CHARGING, patch.acSilentCharging ? 1 : 0]);
    if (patch.stopChargeAfterMinutes !== undefined)
      writes.push([HOLDING.STOP_CHARGE_AFTER_MINUTES, patch.stopChargeAfterMinutes]);
    if (patch.ledMode !== undefined)
      writes.push([HOLDING.LED_MODE, LED_MODES.indexOf(patch.ledMode)]);
    if (patch.keySound !== undefined) writes.push([HOLDING.KEY_SOUND, patch.keySound ? 1 : 0]);
    if (patch.usbStandbyMinutes !== undefined)
      writes.push([HOLDING.USB_STANDBY_MINUTES, patch.usbStandbyMinutes]);
    if (patch.acStandbyMinutes !== undefined)
      writes.push([HOLDING.AC_STANDBY_MINUTES, patch.acStandbyMinutes]);
    if (patch.dcStandbyMinutes !== undefined)
      writes.push([HOLDING.DC_STANDBY_MINUTES, patch.dcStandbyMinutes]);
    if (patch.screenRestSeconds !== undefined)
      writes.push([HOLDING.SCREEN_REST_SECONDS, patch.screenRestSeconds]);
    if (patch.sleepMinutes !== undefined) writes.push([HOLDING.SLEEP_MINUTES, patch.sleepMinutes]);

    for (const [register, value] of writes) {
      await this.#write(register, value);
    }

    if (writes.length) await this.#poll();
    return this.settings();
  }

  async setPort(id: PortId, enabled: boolean): Promise<StationStatus> {
    const register =
      id === 'ac'
        ? HOLDING.AC_OUTPUT
        : id === 'dc'
          ? HOLDING.DC_OUTPUT
          : id === 'usb'
            ? HOLDING.USB_OUTPUT
            : HOLDING.LED_MODE;

    // Known firmware quirk: registers 25/26 toggle on any write rather than
    // honouring the value, so skip the write when we are already in the state.
    const current = this.status().ports.find((p) => p.id === id);
    if (current && current.enabled === enabled) return this.status();

    await this.#write(register, id === 'led' ? (enabled ? 1 : 0) : enabled ? 1 : 0);
    await this.#poll();
    return this.status();
  }

  /** Diagnostics: dump every input register as raw values. */
  async readAllInput(): Promise<number[]> {
    if (!this.#transport.boundId) throw new Error('No device bound');
    const frame = await this.#enqueue(() =>
      this.#transport.request(readInputRegisters(0, INPUT_REGISTER_COUNT), 'input')
    );
    return frame.kind === 'registers' ? frame.values : [];
  }

  /** Diagnostics: dump every holding register as raw values. */
  async readAllHolding(): Promise<number[]> {
    if (!this.#transport.boundId) throw new Error('No device bound');
    const frame = await this.#enqueue(() =>
      this.#transport.request(readHoldingRegisters(0, HOLDING_REGISTER_COUNT), 'holding')
    );
    return frame.kind === 'registers' ? frame.values : [];
  }
}
