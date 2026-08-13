/**
 * What an extension can offer the core, named by the role it plays rather than
 * by the hardware behind it.
 *
 * The core depends on `gridRelay` — "the thing that can interrupt the station's
 * AC input" — never on ATORCH, Tuya or Home Assistant. That is what lets a
 * second plug arrive as a device profile, and a second protocol as one new
 * plugin, without the automation learning anything about either.
 */

export const CAPABILITIES = [
  /** Voltage, current, power, energy. A plug that only measures stops here. */
  'powerMeter.read',
  /** Relay position and reachability. */
  'gridRelay.read',
  /** Actuation. Only the core's action gateway may invoke this. */
  'gridRelay.switch',
  /** The station's own output ports. Held by the core, never by a plugin. */
  'station.ports',
  // Declared for the shape of things to come; nothing implements them yet.
  'weather.forecast',
  'pv.forecast',
  'price.forecast',
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];

/** Capabilities that change the physical world, and so need an explicit grant. */
export const ACTUATOR_CAPABILITIES: readonly CapabilityName[] = ['gridRelay.switch'];

/**
 * The word a caller must repeat back to arm a physical action.
 *
 * Shared vocabulary rather than a server secret: the point is to make a switch
 * impossible to trigger by accident — a stray request, a double tap, a curious
 * `curl` — not to keep anyone out. Defined here so the app and the gateway
 * cannot drift on it.
 */
export const ACTUATOR_CONFIRMATION = 'switch-grid-relay';

export const isActuator = (name: CapabilityName): boolean =>
  ACTUATOR_CAPABILITIES.includes(name);

/** A physical thing only one plugin may own at a time. */
export type Resource = 'gridRelay';

// --- power metering ---------------------------------------------------------

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

// --- grid relay -------------------------------------------------------------

export type RelayState = PowerReading & {
  relayOn: boolean;
};

export type CommandResult = {
  /** The command was accepted by the device. Not proof the relay moved. */
  accepted: boolean;
  /** The device's own view after the command, when it offers one. */
  readback?: RelayState;
  error?: string;
  tookMs: number;
};

/**
 * What the relay does when power is restored after a cut.
 *
 * `last` or `off` on a plug that feeds the station's charger means a flat pack
 * cannot restore its own charging input without someone walking to it. The
 * controller refuses to arm until this is recorded from a real power-cut test,
 * which is why `unknown` is a value rather than an omission.
 */
export type BootBehaviour = 'on' | 'off' | 'last' | 'unknown';

export interface GridRelayProvider extends PowerMeterProvider {
  getState(): Promise<RelayState>;
  /** Gateway-only. A plugin must never call its own actuator. */
  setRelay(on: boolean, reason: string): Promise<CommandResult>;
  readonly bootBehaviour: BootBehaviour;
}

/** The implementation shape for each capability name. */
export type CapabilityImpl = {
  'powerMeter.read': PowerMeterProvider;
  'gridRelay.read': GridRelayProvider;
  'gridRelay.switch': GridRelayProvider;
  /** Held by the core, never registered by a plugin. */
  'station.ports': never;
  'weather.forecast': unknown;
  'pv.forecast': unknown;
  'price.forecast': unknown;
};
