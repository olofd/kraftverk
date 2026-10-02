import { useCallback, useEffect, useMemo, useState } from 'react';

import { describeError, type DeviceScreenProps } from '@kraftverk/api-client';
import { useWriteGate } from '@kraftverk/ui';

import type { PortId, StationSettingsPatch } from '../src/model/types';
import { outletPart, patchToValues, stationView, valuesToSettings } from '../src/index';
import { portKey, settingsKeys, withPending, writesInFlight, type StationWriteKey } from '../src/writes';
import type { StationView } from './contract';

/**
 * How long a confirmed value is shown over readings that do not say it yet:
 * long enough for them to catch up, short enough that a change made elsewhere
 * in between is not hidden for long.
 */
const CONFIRMED_HOLD_MS = 15_000;

/**
 * One station, as its screens draw it: read from its readings — the ones every
 * screen, the history and the automations see, which the app keeps live — and
 * nothing else. It asks the station nothing of its own.
 *
 * Writes go through whoever holds it — settings as settings, outlets as
 * capability commands through the holder's gateway — and are held on screen
 * until the station confirms them, then until its readings say so too: the
 * gateway's readback can arrive a moment before the live reading does, and a
 * switch must not flick back in between (see `write-gate.ts` in `@kraftverk/ui`).
 */
export function useStation({ device, actions, reach, readOnly, version }: DeviceScreenProps): StationView {
  const [writeError, setWriteError] = useState<string | null>(null);
  const [gate, writes] = useWriteGate<StationWriteKey>();
  /** What the station confirmed, and when: shown until its readings catch up. */
  const [confirmed, setConfirmed] = useState<ReadonlyMap<StationWriteKey, { value: unknown; at: number }>>(new Map());

  const inUse = device.connections.find((connection) => connection.inUse) ?? null;
  const seen = useMemo(
    () =>
      stationView({
        readings: device.readings,
        info: device.info,
        health: device.health,
        address: inUse?.address ?? null,
        simulated: device.health.transport === 'sim',
      }),
    [device.readings, device.info, device.health, inUse?.address]
  );

  // A confirmed value goes once the readings say it too, or, since someone
  // else may have changed it again before they caught up, once they have had
  // time to: then the readings are what is so.
  useEffect(() => {
    if (!confirmed.size) return;
    const now = Date.now();
    const done = [...confirmed].filter(
      ([key, { value, at }]) =>
        now - at >= CONFIRMED_HOLD_MS ||
        (key.startsWith('port:')
          ? seen.status?.ports.find((port) => `port:${port.id}` === key)?.enabled === value
          : (seen.settings as Record<string, unknown> | null)?.[key] === value)
    );
    if (done.length) {
      setConfirmed((current) => new Map([...current].filter(([key]) => !done.some(([gone]) => gone === key))));
      return;
    }
    // Readings may stop coming: look again when the first hold runs out.
    const next = Math.min(...[...confirmed.values()].map(({ at }) => at + CONFIRMED_HOLD_MS));
    const timer = setTimeout(() => setConfirmed((current) => new Map(current)), Math.max(0, next - now));
    return () => clearTimeout(timer);
  }, [confirmed, seen]);

  const hold = (values: Record<string, unknown>) => {
    const at = Date.now();
    setConfirmed((current) => new Map([...current, ...Object.entries(values).map(([key, value]) => [key as StationWriteKey, { value, at }] as const)]));
  };

  const updateSettings = useCallback(
    async (patch: StationSettingsPatch) => {
      setWriteError(null);
      try {
        await gate.run(settingsKeys(patch), async () => {
          const result = await actions.write(patchToValues(patch));
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          // The reply is a readback: one setting can move another.
          hold(valuesToSettings(result.values ?? {}));
        });
      } catch (err) {
        const message = describeError(err);
        if (message) setWriteError(message);
      }
    },
    [actions, gate]
  );

  const togglePort = useCallback(
    async (id: PortId, enabled: boolean) => {
      setWriteError(null);
      try {
        await gate.run({ [portKey(id)]: enabled }, async () => {
          const result = await actions.command({ part: outletPart(id), capability: 'switch', command: 'set', args: { on: enabled }, reason: 'Switched on the station’s screen' });
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          if (result.deviceAgreed) hold({ [portKey(id)]: enabled });
        });
      } catch (err) {
        const message = describeError(err);
        if (message) setWriteError(message);
      }
    },
    [actions, gate]
  );

  const pending = useMemo(() => writesInFlight(writes.pending), [writes.pending]);
  const shown = useMemo(() => withPending(seen.status, seen.settings, new Map([...[...confirmed].map(([key, { value }]) => [key, value] as const), ...writes.pending])), [confirmed, seen, writes.pending]);

  return {
    status: shown.status,
    settings: shown.settings,
    pending,
    readOnly,
    simulated: seen.status?.link.mode === 'simulator',
    waitingFor: reach.waiting,
    version,
    linkLabel: reach.via,
    mainsFrom: device.links.find((link) => link.role === 'target' && link.part === 'input.ac')?.other.name ?? null,
    writeError,
    updateSettings,
    togglePort,
  };
}
