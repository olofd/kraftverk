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
  settings(): StationSettings;

  applySettings(patch: StationSettingsPatch): Promise<StationSettings>;
  setPort(id: PortId, enabled: boolean): Promise<StationStatus>;

  /** Simulator-only affordance; real hardware ignores it. */
  setGridConnected?(connected: boolean): Promise<StationStatus>;
}
