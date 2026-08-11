import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  StationSettingsSchema,
  type PortId,
  type PortState,
  type StationSettings,
  type StationSettingsPatch,
  type StationStatus,
} from '../types.ts';
import type { StationDriver } from './types.ts';

/**
 * A simulated AFERIY P280, so the app is usable without hardware on the
 * network. It models the same quantities the real driver reports.
 */

const BASE_CAPACITY_WH = 2048;
const MODEL = 'AFERIY P280 (simulated)';
const SETTINGS_FILE = resolve(import.meta.dirname, '../../data/settings.json');

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

export class SimulatorDriver implements StationDriver {
  readonly mode = 'simulator' as const;

  #settings: StationSettings = { ...DEFAULTS };
  #level = 68;
  #expansion = [82.5];
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

  async start(): Promise<void> {
    try {
      const raw = await readFile(SETTINGS_FILE, 'utf8');
      const parsed = StationSettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.#settings = parsed.data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') console.warn('[sim] could not read settings.json:', error);
    }
    this.#timer = setInterval(() => this.#tick(), 1000);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(SETTINGS_FILE), { recursive: true });
    await writeFile(SETTINGS_FILE, `${JSON.stringify(this.#settings, null, 2)}\n`, 'utf8');
  }

  #tick(): void {
    const now = Date.now();
    const hours = (now - this.#lastTick) / 3_600_000;
    this.#lastTick = now;

    for (const [id, port] of Object.entries(this.#ports) as [
      PortId,
      { enabled: boolean; watts: number },
    ][]) {
      if (!port.enabled) {
        port.watts = 0;
        continue;
      }
      const base = id === 'ac' ? 145 : id === 'dc' ? 60 : id === 'usb' ? 18 : 5;
      port.watts = round(clamp(base + (Math.random() - 0.5) * base * 0.35, 0, 2800));
    }

    const net = this.#inputWatts - this.outputWatts;
    const capacity = BASE_CAPACITY_WH * (1 + this.#expansion.length);
    this.#level = clamp(this.#level + ((net * hours) / capacity) * 100, 0, 100);

    if (this.#level <= this.#settings.dischargeFloor && this.outputWatts > 0) {
      for (const port of Object.values(this.#ports)) {
        port.enabled = false;
        port.watts = 0;
      }
    }
  }

  get outputWatts(): number {
    return round(Object.values(this.#ports).reduce((sum, p) => sum + p.watts, 0));
  }

  get #inputWatts(): number {
    if (this.#settings.stopChargeAfterMinutes > 0) return 0;
    if (!this.#gridConnected) return this.#solarWatts;
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
    const output = this.outputWatts;
    const net = input - output;
    const capacity = BASE_CAPACITY_WH * (1 + this.#expansion.length);

    const state: StationStatus['state'] =
      net > 5 ? 'charging' : output > 5 ? 'discharging' : this.#gridConnected ? 'idle' : 'standby';

    const wh = (this.#level / 100) * capacity;
    const floorWh = (this.#settings.dischargeFloor / 100) * capacity;
    const targetWh = (this.#settings.chargeLimit / 100) * capacity;

    const ports: PortState[] = (Object.keys(this.#ports) as PortId[]).map((id) => ({
      id,
      label: PORT_LABELS[id],
      enabled: this.#ports[id].enabled,
      watts: this.#ports[id].watts,
    }));

    return {
      name: 'Aferiy Powerstation',
      model: MODEL,
      state,
      link: { mode: 'simulator', state: 'connected', mac: null, lastSeen: new Date().toISOString() },
      level: round(this.#level, 1),
      expansionSoc: this.#expansion,
      capacityWh: capacity,
      gridConnected: this.#gridConnected,
      solarConnected: this.#solarWatts > 0,
      acInputWatts: Math.max(0, input - this.#solarWatts),
      solarInputWatts: this.#solarWatts,
      totalInputWatts: input,
      totalOutputWatts: output,
      acInputVolts: this.#gridConnected ? 230.4 : 0,
      acInputHz: this.#gridConnected ? 50 : 0,
      acOutputVolts: this.#ports.ac.enabled ? 230.1 : 0,
      acOutputHz: this.#ports.ac.enabled ? 50 : 0,
      minutesToFull: net > 5 ? Math.round(((targetWh - wh) / net) * 60) : null,
      minutesRemaining: output > 5 ? Math.round(((wh - floorWh) / output) * 60) : null,
      chargeBookingMinutes: this.#settings.stopChargeAfterMinutes,
      ports,
      lastUpdated: new Date().toISOString(),
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
    this.#settings = StationSettingsSchema.parse(next);
    await this.#persist();
    return this.settings();
  }

  async setPort(id: PortId, enabled: boolean): Promise<StationStatus> {
    this.#ports[id].enabled = enabled;
    if (!enabled) this.#ports[id].watts = 0;
    return this.status();
  }

  async setGridConnected(connected: boolean): Promise<StationStatus> {
    this.#gridConnected = connected;
    return this.status();
  }
}
