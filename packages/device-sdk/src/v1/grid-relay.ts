/**
 * The v1 extension contract's capabilities — named after one use, the grid
 * relay, which is what the architecture review found wrong with them.
 *
 * Kept only while the two plugins in `packages/plugins` still implement it.
 * Their replacements are device types offering `switch` and `powerMeter`
 * (docs/ARCHITECTURE.md, step 5), and this file goes with the gateway's move
 * to capabilities (step 6). Nothing new should use it.
 */

export const PLUGIN_CAPABILITIES = [
  /** Voltage, current, power, energy. */
  'powerMeter.read',
  /** Relay position and reachability. */
  'gridRelay.read',
  /** Actuation. Only the core's action gateway may invoke this. */
  'gridRelay.switch',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** Capabilities that change the physical world, and so need an explicit grant. */
export const ACTUATOR_CAPABILITIES: readonly PluginCapability[] = ['gridRelay.switch'];

/**
 * The word a caller must repeat back to arm a physical action.
 *
 * Shared vocabulary rather than a server secret: the point is to make a switch
 * impossible to trigger by accident — a stray request, a double tap, a curious
 * `curl` — not to keep anyone out. Defined here so the app and the gateway
 * cannot drift on it.
 */
export const ACTUATOR_CONFIRMATION = 'switch-grid-relay';

export const isActuator = (name: PluginCapability): boolean => ACTUATOR_CAPABILITIES.includes(name);

/** A physical thing only one plugin may own at a time. */
export type Resource = 'gridRelay';

export type PowerReading = {
  watts?: number;
  volts?: number;
  amps?: number;
  kwh?: number;
  hz?: number;
  powerFactor?: number;
  /**
   * When the device last actually answered — not when we last asked.
   *
   * Every consumer treats a stale reading as unusable rather than as a number,
   * so this is not optional and must not be refreshed by a failed poll.
   */
  updatedAt: string;
  reachable: boolean;
};

export interface PowerMeterProvider {
  read(): Promise<PowerReading>;
}

export type RelayState = PowerReading & {
  relayOn: boolean;
};

export type RelaySwitchResult = {
  /** The command was accepted by the device. Not proof the relay moved. */
  accepted: boolean;
  /** The device's own view after the command, when it offers one. */
  readback?: RelayState;
  error?: string;
  tookMs: number;
};

export interface GridRelayProvider extends PowerMeterProvider {
  getState(): Promise<RelayState>;
  /** Gateway-only. A plugin must never call its own actuator. */
  setRelay(on: boolean, reason: string): Promise<RelaySwitchResult>;
  readonly bootBehaviour: import('../capabilities.ts').BootBehaviour;
}

/** The implementation shape for each v1 capability name. */
export type PluginCapabilityImpl = {
  'powerMeter.read': PowerMeterProvider;
  'gridRelay.read': GridRelayProvider;
  'gridRelay.switch': GridRelayProvider;
};
