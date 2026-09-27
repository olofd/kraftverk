import type {
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
} from '../types.ts';

/**
 * What the HTTP layer needs from a power station, whether that is real
 * hardware over MQTT or the built-in simulator.
 */
export interface StationDriver {
  readonly mode: 'device' | 'simulator';

  start(): Promise<void>;
  stop(): Promise<void>;

  status(): StationStatus;
  /** Null until the station's settings have been read from it. */
  settings(): StationSettings | null;

  applySettings(patch: StationSettingsPatch): Promise<StationSettings | null>;
  setPort(id: PortId, enabled: boolean): Promise<StationStatus>;

  /** Simulator-only affordance; real hardware ignores it. */
  setGridConnected?(connected: boolean): Promise<StationStatus>;
}
