import type { CapabilityName } from '../capabilities.ts';
import type { ControlSpec, SettingsSpec } from '../device-type.ts';
import type { ConfigValues } from '../schema.ts';
import type { MetricSpec, Reading } from '../telemetry.ts';

/**
 * How a device is described to the app today, and what a v1 plugin provides.
 *
 * Transitional. The same facts — telemetry, controls, settings, capabilities —
 * now belong to a `DeviceType`, declared once per product rather than per
 * device, and the view the app receives will be built from that
 * (docs/ARCHITECTURE.md, steps 3–4). Until then the registry assembles one of
 * these per saved device, and the station package and the two plugins supply them.
 */
export type DeviceDescriptor = {
  /** Stable and namespaced: `tuya:bf8dc9…`, `station:AC276E629BEA`. */
  id: string;
  /** The vendor's name for it. The user's own name is stored by the core. */
  name: string;
  /**
   * Free text for grouping on screen: 'battery', 'smart-plug'. Never
   * behaviour — that comes from capabilities — so it is not a closed list a
   * contributor would have to extend.
   */
  category: string;
  icon: string;
  /** Model, product name — whatever helps tell two of them apart. */
  description?: string;

  /** What it measures. Sampled into history; charted generically. */
  measurements: readonly MetricSpec[];
  /** What it can be told to do, right now. */
  controls: readonly ControlSpec[];
  /** What the device itself remembers. */
  settings?: SettingsSpec;
  /** What this device can do, for wiring and for permission checks. */
  capabilities?: readonly CapabilityName[];
};

/** What a v1 plugin implements to provide devices. */
export interface DeviceProvider {
  /** The devices this plugin currently provides. May change with config. */
  devices(): DeviceDescriptor[];
  /** Current readings for one device. Stale is reported, never hidden. */
  readDevice(deviceId: string): Promise<Reading[]>;
  /** Current values of the device's own settings. */
  readSettings?(deviceId: string): Promise<ConfigValues>;
  /** Applies settings, and returns what the device reports afterwards: a readback, not an echo. */
  writeSettings?(deviceId: string, patch: ConfigValues): Promise<ConfigValues>;
}
