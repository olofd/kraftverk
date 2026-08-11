import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  StationSettingsSchema,
  type PortId,
  type PortState,
  type StationSettings,
  type StationStatus,
} from './types.ts';

/**
 * A simulated Aferiy powerstation.
 *
 * Everything below the `--- hardware seam ---` marker is stand-in behaviour so
 * the UI has something live to render. When the real transport lands (BLE,
 * local Wi-Fi, or the vendor cloud), replace `tick()` with a poll of the device
 * and `applySettings`/`setPort` with real writes — the rest of the server and
 * the whole client stay as they are.
 */

const CAPACITY_WH = 3840;
const MODEL = 'Aferiy P310';

const DEFAULT_SETTINGS: StationSettings = {
  chargeLimit: 90,
  dischargeFloor: 10,
  maxInputWatts: 1000,
  chargeSpeed: 'standard',
  ecoMode: true,
  upsMode: false,
  quietHours: false,
  displayBrightness: 70,
  screenTimeoutMinutes: 5,
  temperatureUnit: 'C',
};

const SETTINGS_FILE = resolve(import.meta.dirname, '../data/settings.json');

const PORT_LABELS: Record<PortId, string> = {
  ac: 'AC outlets',
  dc: '12V DC / car port',
  usb: 'USB-A + USB-C',
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, places = 0) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export class Station {
  #settings: StationSettings = { ...DEFAULT_SETTINGS };
  #level = 68;
  #batteryTempC = 24.5;
  #ports: Record<PortId, { enabled: boolean; watts: number }> = {
    ac: { enabled: true, watts: 145 },
    dc: { enabled: false, watts: 0 },
    usb: { enabled: true, watts: 18 },
  };
  #gridConnected = true;
  #cycleCount = 41;
  #lastTick = Date.now();
  readonly startedAt = new Date();

  /** Reads persisted settings from disk; falls back to defaults. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(SETTINGS_FILE, 'utf8');
      const parsed = StationSettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.#settings = parsed.data;
      } else {
        console.warn('[station] settings.json failed validation, using defaults');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn('[station] could not read settings.json:', error);
      }
    }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(SETTINGS_FILE), { recursive: true });
    await writeFile(SETTINGS_FILE, `${JSON.stringify(this.#settings, null, 2)}\n`, 'utf8');
  }

  get settings(): StationSettings {
    return { ...this.#settings };
  }

  async applySettings(patch: Partial<StationSettings>): Promise<StationSettings> {
    const next = { ...this.#settings, ...patch };

    // The two battery guards must not cross over.
    if (next.dischargeFloor >= next.chargeLimit) {
      next.dischargeFloor = Math.max(0, next.chargeLimit - 10);
    }

    this.#settings = StationSettingsSchema.parse(next);
    await this.#persist();
    return this.settings;
  }

  setPort(id: PortId, enabled: boolean): StationStatus {
    this.#ports[id].enabled = enabled;
    if (!enabled) this.#ports[id].watts = 0;
    return this.status();
  }

  /** Dev-only affordance so the UI can be exercised without real hardware. */
  setGridConnected(connected: boolean): StationStatus {
    this.#gridConnected = connected;
    return this.status();
  }

  // --- hardware seam -------------------------------------------------------

  /** Advances the simulation. Called on an interval by the server. */
  tick(): void {
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
      const base = id === 'ac' ? 145 : id === 'dc' ? 60 : 18;
      // Wander around the nominal draw so the dashboard looks alive.
      port.watts = round(clamp(base + (Math.random() - 0.5) * base * 0.35, 0, 3600));
    }

    const output = this.outputWatts;
    const input = this.inputWatts;
    const netWatts = input - output;

    this.#level = clamp(this.#level + (netWatts * hours) / CAPACITY_WH * 100, 0, 100);

    // Charging warms the pack, idling lets it drift back to ambient.
    const target = 22 + Math.abs(netWatts) / 120;
    this.#batteryTempC = round(this.#batteryTempC + (target - this.#batteryTempC) * 0.08, 1);

    if (this.#level <= this.#settings.dischargeFloor && output > 0) {
      for (const port of Object.values(this.#ports)) {
        port.enabled = false;
        port.watts = 0;
      }
    }
  }

  get outputWatts(): number {
    return round(
      Object.values(this.#ports).reduce((sum, port) => sum + port.watts, 0)
    );
  }

  get inputWatts(): number {
    if (!this.#gridConnected) return 0;
    if (this.#level >= this.#settings.chargeLimit) return 0;

    const speedCeiling =
      this.#settings.chargeSpeed === 'silent'
        ? 300
        : this.#settings.chargeSpeed === 'standard'
          ? 900
          : 1500;

    const ceiling = Math.min(this.#settings.maxInputWatts, speedCeiling);

    // Taper the last stretch the way a real BMS does.
    const headroom = this.#settings.chargeLimit - this.#level;
    const taper = headroom < 10 ? clamp(headroom / 10, 0.15, 1) : 1;
    return round(ceiling * taper);
  }

  // -------------------------------------------------------------------------

  status(): StationStatus {
    const input = this.inputWatts;
    const output = this.outputWatts;
    const net = input - output;

    const state: StationStatus['state'] =
      net > 5 ? 'charging' : output > 5 ? 'discharging' : this.#gridConnected ? 'idle' : 'standby';

    const wh = (this.#level / 100) * CAPACITY_WH;
    const targetWh = (this.#settings.chargeLimit / 100) * CAPACITY_WH;
    const floorWh = (this.#settings.dischargeFloor / 100) * CAPACITY_WH;

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
      gridConnected: this.#gridConnected,
      level: round(this.#level, 1),
      capacityWh: CAPACITY_WH,
      inputWatts: input,
      outputWatts: output,
      batteryTempC: this.#batteryTempC,
      minutesToFull: net > 5 ? Math.round(((targetWh - wh) / net) * 60) : null,
      minutesRemaining: output > 5 ? Math.round(((wh - floorWh) / output) * 60) : null,
      cycleCount: this.#cycleCount,
      healthPercent: round(100 - this.#cycleCount * 0.004, 1),
      ports,
      lastUpdated: new Date().toISOString(),
    };
  }
}

export const station = new Station();
