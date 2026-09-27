import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from '@kraftverk/protocol';

/**
 * A station's writes, in the terms of the write gate.
 *
 * Shared by both ways the app reaches a station — through a server, and over a
 * Bluetooth link it holds itself — so the two lock the same controls and show
 * the same thing while a write is in flight. See `writeGate.ts` in
 * `@kraftverk/ui`.
 */

/**
 * What is being written to the station right now, by what it touches.
 *
 * A control named here shows the value that was asked for and is locked until
 * the station confirms it — the app has already put the asked-for value into
 * `status` and `settings`, so a screen only has to lock the control and say it
 * is waiting. Locked rather than live, because a station that is still busy
 * with the first tap has no business receiving a second.
 */
export type WritesInFlight = {
  readonly ports: ReadonlySet<PortId>;
  readonly settings: ReadonlySet<keyof StationSettings>;
};

export const NO_WRITES_IN_FLIGHT: WritesInFlight = { ports: new Set(), settings: new Set() };

/** What one write occupies: an output, or one of the station's settings. */
export type StationWriteKey = `port:${PortId}` | keyof StationSettings;

export const portKey = (id: PortId): StationWriteKey => `port:${id}`;

/**
 * The keys a settings change occupies.
 *
 * The DC input type moves the charging-current ceiling on the station by
 * itself, so changing it also holds the current: its readback is on the way,
 * and a value typed into it now would be overwritten by the one the station
 * chose.
 */
export function settingsKeys(patch: StationSettingsPatch): Partial<Record<StationWriteKey, unknown>> {
  const keys: Partial<Record<StationWriteKey, unknown>> = { ...patch };
  if (patch.dcInputType !== undefined && patch.maxChargingCurrent === undefined) {
    keys.maxChargingCurrent = undefined;
  }
  return keys;
}

/** The pending keys, as the station's screens want them. */
export function writesInFlight(pending: ReadonlyMap<StationWriteKey, unknown>): WritesInFlight {
  const ports = new Set<PortId>();
  const settings = new Set<keyof StationSettings>();
  for (const key of pending.keys()) {
    if (key.startsWith('port:')) ports.add(key.slice('port:'.length) as PortId);
    else settings.add(key as keyof StationSettings);
  }
  return { ports, settings };
}

/**
 * The last confirmed state, with what is being written shown as asked.
 *
 * Only an output's on/off is overlaid — not its watts, which the station will
 * report once it has switched. A pending key with no value (a setting held
 * because another write moves it) keeps its confirmed value.
 */
export function withPending(
  status: StationStatus | null,
  settings: StationSettings | null,
  pending: ReadonlyMap<StationWriteKey, unknown>
): { status: StationStatus | null; settings: StationSettings | null } {
  if (pending.size === 0) return { status, settings };

  let nextSettings = settings;
  let ports = status?.ports;
  for (const [key, value] of pending) {
    if (value === undefined) continue;
    if (key.startsWith('port:')) {
      const id = key.slice('port:'.length);
      ports = ports?.map((port) => (port.id === id ? { ...port, enabled: value as boolean } : port));
    } else if (nextSettings) {
      nextSettings = { ...nextSettings, [key]: value };
    }
  }

  return {
    status: status && ports !== status.ports ? { ...status, ports: ports ?? status.ports } : status,
    settings: nextSettings,
  };
}
