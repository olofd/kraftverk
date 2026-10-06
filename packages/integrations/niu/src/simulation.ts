import type { NiuBatteryHealth, NiuState, NiuTotals } from '@kraftverk/protocol-niu-cloud';

/**
 * A NIU scooter that is not there: it charges from 30 % to 90 % at about 1 %
 * in 3.5 minutes — as a UQi's battery on its charger — then is ridden back
 * down, and again, reporting a minute apart as NIU's do while charging. What
 * a simulated scooter, and a simulated account's scooters, are.
 */
export class SimulatedScooter {
  soc: number;
  charging: boolean;
  odometer: number;
  at = new Date().toISOString();

  constructor(start: { soc?: number; charging?: boolean; odometer?: number } = {}) {
    this.soc = start.soc ?? 55;
    this.charging = start.charging ?? true;
    this.odometer = start.odometer ?? 4180.4;
  }

  /** What it reports now, as NIU gives it. */
  state(): NiuState {
    const soc = Math.round(this.soc);
    return {
      at: this.at,
      soc,
      batteries: [{ compartment: 'A', connected: true, soc }],
      charging: this.charging,
      online: true,
      minutesToFull: this.charging ? Math.round((100 - this.soc) * 3.5) : null,
      rangeKm: Math.round(this.soc * 0.55),
      speedKmh: this.charging ? 0 : 24,
      poweredOn: !this.charging,
      alarmArmed: this.charging,
      lockStatus: this.charging ? 0 : 1,
      gsm: 4,
      gps: this.charging ? 2 : 5,
      controlUnitBattery: 100,
    };
  }

  /** A minute on: charging, or ridden. */
  step(): void {
    if (this.charging) this.soc = Math.min(90, this.soc + 60 / 210);
    else {
      this.soc = Math.max(30, this.soc - 0.8);
      this.odometer += 0.4;
    }
    if (this.charging && this.soc >= 90) this.charging = false;
    else if (!this.charging && this.soc <= 30) this.charging = true;
    this.at = new Date().toISOString();
  }

  batteries(): NiuBatteryHealth[] {
    return [{ compartment: 'A', soc: null, temperature: 21, health: 96, cycles: 212 }];
  }

  totals(): NiuTotals {
    return { odometerKm: Math.round(this.odometer * 10) / 10, daysOwned: 1800 };
  }
}
