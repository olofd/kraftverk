import { validateConfig, type DeviceStore } from '@kraftverk/device-sdk';
import type {
  PortId,
  PortState,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
} from './model/types.ts';

import { SETTINGS_SCHEMA, settingsToValues, valuesToSettings } from './index.ts';
import type { StationSource } from './station.ts';

/**
 * A P280 that is not there: the app is usable without hardware, the contract
 * suite has something to exercise, and a test can switch outlets without a
 * station in the room. It models the quantities the real station reports.
 *
 * Its settings are kept in the device's own store, so each simulated station
 * remembers its own, and none of them leaves a file behind.
 */

const BASE_CAPACITY_WH = 2048;
const MODEL = 'AFERIY P280 (simulated)';
const SETTINGS_KEY = 'simulator.settings';

const DEFAULTS: StationSettings = {
  chargeLimit: 90,
  dischargeFloor: 10,
  acChargingWatts: 1800,
  dcInputType: 'pv',
  maxChargingCurrent: 20,
  acSilentCharging: false,
  stopChargeAfterMinutes: 0,
  ledMode: 'off',
  keySound: true,
  usbStandbyMinutes: 0,
  acStandbyMinutes: 0,
  dcStandbyMinutes: 0,
  screenRestSeconds: 300,
  sleepMinutes: 480,
  temperatureUnit: 'C',
};

const PORT_LABELS: Record<PortId, string> = {
  ac: 'AC outlets',
  dc: '12V DC / car port',
  usb: 'USB-A + USB-C',
  led: 'Light',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, places = 0) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * Settings the P280's own schema accepts, or null.
 *
 * The same schema the app renders and the server validates writes against —
 * so the simulator cannot drift into accepting a value the real station would
 * be refused, least of all the one that bricks it.
 */
function checked(settings: StationSettings): StationSettings | null {
  const result = validateConfig(SETTINGS_SCHEMA, settingsToValues(settings));
  return result.ok ? (valuesToSettings(result.value) as StationSettings) : null;
}

/**
 * What a simulated station is set up with (the type's `simulation`), and the
 * world it runs in: how fast its time goes, and whether what feeds its mains
 * input gives it power.
 */
export type SimulatedStationOptions = {
  /** Its charge to start from, in %. */
  level?: number;
  /** Expansion packs beside its own 2048 Wh, each as much again. */
  packs?: number;
  /** What its AC outlets supply, on average: a load plugged into it. */
  acLoadWatts?: number;
  /** How many times faster than real time it runs: its battery fills and drains that much faster. */
  speed?: number;
  /**
   * Whether what feeds its mains input gives it power now — a simulated plug
   * it is plugged into — or null when nothing simulated does: then mains is
   * what `setGridConnected` last said.
   */
  fed?: () => boolean | null;
  /** After each step of its world: what it reports moved. */
  onTick?: () => void;
};

export class SimulatedStation implements StationSource {
  #store: DeviceStore | null;
  #settings: StationSettings = { ...DEFAULTS };
  #level: number;
  #expansion: number[];
  #acLoadWatts: number;
  #speed: number;
  #fed: () => boolean | null;
  #onTick: () => void;
  #ports: Record<PortId, { enabled: boolean; watts: number }> = {
    ac: { enabled: true, watts: 145 },
    dc: { enabled: false, watts: 0 },
    usb: { enabled: true, watts: 18 },
    led: { enabled: false, watts: 0 },
  };
  #gridConnected = true;
  #solarWatts = 0;
  #lastTick = Date.now();
  #timer: ReturnType<typeof setInterval> | null = null;

  /** `store` keeps its settings between runs; without one they last as long as it does. */
  constructor(store: DeviceStore | null = null, options: SimulatedStationOptions = {}) {
    this.#store = store;
    this.#level = clamp(options.level ?? 68, 0, 100);
    this.#expansion = Array.from({ length: Math.max(0, Math.round(options.packs ?? 1)) }, () => 82.5);
    this.#acLoadWatts = Math.max(0, options.acLoadWatts ?? 145);
    this.#ports.ac.watts = this.#acLoadWatts;
    this.#speed = Math.max(1, options.speed ?? 1);
    this.#fed = options.fed ?? (() => null);
    this.#onTick = options.onTick ?? (() => {});
  }

  start(): void {
    const saved = this.#store?.get<StationSettings>(SETTINGS_KEY);
    if (saved) this.#settings = checked({ ...DEFAULTS, ...saved }) ?? { ...DEFAULTS };
    // Sped up, it steps more often: a world an hour a second still moves a little at a time.
    this.#timer = setInterval(() => this.#tick(), this.#speed > 1 ? 100 : 1000);
  }

  /** Whether mains reaches it now: what feeds it, when something simulated does; else as last said. */
  get #mains(): boolean {
    return this.#fed() ?? this.#gridConnected;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    const now = Date.now();
    const hours = ((now - this.#lastTick) * this.#speed) / 3_600_000;
    this.#lastTick = now;

    for (const [id, port] of Object.entries(this.#ports) as [PortId, { enabled: boolean; watts: number }][]) {
      if (!port.enabled) {
        port.watts = 0;
        continue;
      }
      const base = id === 'ac' ? this.#acLoadWatts : id === 'dc' ? 60 : id === 'usb' ? 18 : 5;
      port.watts = round(clamp(base + (Math.random() - 0.5) * base * 0.35, 0, 2800));
    }

    const net = this.#inputWatts - this.#outputWatts;
    const capacity = BASE_CAPACITY_WH * (1 + this.#expansion.length);
    this.#level = clamp(this.#level + ((net * hours) / capacity) * 100, 0, 100);

    if (this.#level <= this.#settings.dischargeFloor && this.#outputWatts > 0) {
      for (const port of Object.values(this.#ports)) {
        port.enabled = false;
        port.watts = 0;
      }
    }
    this.#onTick();
  }

  get #outputWatts(): number {
    return round(Object.values(this.#ports).reduce((sum, p) => sum + p.watts, 0));
  }

  get #inputWatts(): number {
    if (this.#settings.stopChargeAfterMinutes > 0) return 0;
    if (!this.#mains) return this.#solarWatts;
    if (this.#level >= this.#settings.chargeLimit) return 0;

    // Silent charging trades speed for noise, otherwise honour the configured
    // AC charging power (600-1800 W on a P280).
    const ceiling = this.#settings.acSilentCharging
      ? Math.min(400, this.#settings.acChargingWatts)
      : this.#settings.acChargingWatts;
    const headroom = this.#settings.chargeLimit - this.#level;
    const taper = headroom < 10 ? clamp(headroom / 10, 0.15, 1) : 1;
    return round(ceiling * taper) + this.#solarWatts;
  }

  status(): StationStatus {
    const input = this.#inputWatts;
    const output = this.#outputWatts;
    const net = input - output;
    const capacity = BASE_CAPACITY_WH * (1 + this.#expansion.length);

    const state: StationStatus['state'] =
      net > 5 ? 'charging' : output > 5 ? 'discharging' : this.#mains ? 'idle' : 'standby';

    const wh = (this.#level / 100) * capacity;
    const floorWh = (this.#settings.dischargeFloor / 100) * capacity;
    const targetWh = (this.#settings.chargeLimit / 100) * capacity;

    const ports: PortState[] = (Object.keys(this.#ports) as PortId[]).map((id) => ({
      id,
      label: PORT_LABELS[id],
      enabled: this.#ports[id].enabled,
      watts: this.#ports[id].watts,
    }));

    const now = new Date().toISOString();
    return {
      name: 'Aferiy Powerstation',
      model: MODEL,
      firmware: { ac: '1.8', controllerA: '1.4', controllerB: '1.4', panel: '2.8' },
      state,
      link: { mode: 'simulator', state: 'connected', mac: null, lastSeen: now },
      level: round(this.#level, 1),
      expansionSoc: this.#expansion,
      capacityWh: capacity,
      gridConnected: this.#mains,
      solarConnected: this.#solarWatts > 0,
      acInputWatts: Math.max(0, input - this.#solarWatts),
      solarInputWatts: this.#solarWatts,
      totalInputWatts: input,
      totalOutputWatts: output,
      acInputVolts: this.#mains ? 230.4 : 0,
      acInputHz: this.#mains ? 50 : 0,
      acOutputVolts: this.#ports.ac.enabled ? 230.1 : 0,
      acOutputHz: this.#ports.ac.enabled ? 50 : 0,
      minutesToFull: net > 5 ? Math.round(((targetWh - wh) / net) * 60) : null,
      minutesRemaining: output > 5 ? Math.round(((wh - floorWh) / output) * 60) : null,
      chargeBookingMinutes: this.#settings.stopChargeAfterMinutes,
      ports,
      lastUpdated: now,
    };
  }

  settings(): StationSettings {
    return { ...this.#settings };
  }

  async applySettings(patch: StationSettingsPatch): Promise<StationSettings> {
    const next = { ...this.#settings, ...patch };
    if (next.dischargeFloor >= next.chargeLimit) {
      next.dischargeFloor = Math.max(0, next.chargeLimit - 10);
    }
    // Mirrors the real station: switching the DC input type also moves the
    // current ceiling, since a DC adapter tolerates less than a solar array.
    if (patch.dcInputType && patch.dcInputType !== this.#settings.dcInputType) {
      next.maxChargingCurrent = patch.dcInputType === 'dc' ? 8 : 20;
    }
    const valid = checked(next);
    if (!valid) throw new Error('The station would refuse those settings');
    this.#settings = valid;
    this.#store?.set(SETTINGS_KEY, this.#settings);
    return this.settings();
  }

  async setPort(id: PortId, enabled: boolean): Promise<StationStatus> {
    this.#ports[id].enabled = enabled;
    if (!enabled) this.#ports[id].watts = 0;
    return this.status();
  }

  /** Mains coming and going, for tests of what depends on it. Real hardware has no such thing. */
  setGridConnected(connected: boolean): void {
    this.#gridConnected = connected;
  }
}
