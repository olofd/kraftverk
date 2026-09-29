import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { describeError, type DeviceScreenProps } from '@kraftverk/api-client';
import { useWriteGate } from '@kraftverk/ui';

import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from '../src/model/types';
import { outletPart, patchToValues, valuesToSettings } from '../src/index';
import { portKey, settingsKeys, withPending, writesInFlight, type StationWriteKey } from '../src/writes';
import type { StationView } from './contract';

/** Two seconds: what the energy flow needs to look alive. */
const POLL_MS = 2000;

/**
 * One station's state, as its screens draw it.
 *
 * Read from the station's own `state` tool, through whoever holds its
 * connection, every two seconds while the app is in front. Writes go through
 * the same path — settings as settings, outlets as capability commands through
 * the holder's gateway — and are held on screen until the station confirms
 * them: a poll asked for before a write finished would otherwise flip a switch
 * back for a moment after every tap (see `writeGate.ts` in `@kraftverk/ui`).
 */
export function useStation({ device, actions, holder, readOnly, version }: DeviceScreenProps): StationView {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [settings, setSettings] = useState<StationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [gate, writes] = useWriteGate<StationWriteKey>();
  const reachable = holder === 'server' || holder === 'this-app';

  const load = useCallback(async () => {
    if (!reachable) return;
    const askedAt = gate.epoch;
    try {
      const state = await actions.tool<{ status: StationStatus; settings: StationSettings | null }>('state');
      if (!gate.fresh(askedAt)) return;
      setStatus(state.status);
      setSettings(state.settings);
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, [actions, gate, reachable]);

  useEffect(() => {
    if (!reachable) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    void load().then(start);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void load();
        start();
      } else stop();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [load, reachable]);

  const updateSettings = useCallback(
    async (patch: StationSettingsPatch) => {
      setWriteError(null);
      try {
        await gate.run(settingsKeys(patch), async () => {
          const result = await actions.write(patchToValues(patch));
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          const values = result.values ?? {};
          if (Object.keys(values).length) setSettings((current) => ({ ...(current ?? ({} as StationSettings)), ...valuesToSettings(values) }));
        });
      } catch (err) {
        const message = describeError(err);
        if (message) setWriteError(message);
        await load();
      }
    },
    [actions, gate, load]
  );

  const togglePort = useCallback(
    async (id: PortId, enabled: boolean) => {
      setWriteError(null);
      try {
        await gate.run({ [portKey(id)]: enabled }, async () => {
          const result = await actions.command({ part: outletPart(id), capability: 'switch', command: 'set', args: { on: enabled }, reason: 'Switched on the station’s screen' });
          if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
          // The station as it is now, read inside the write, so the switch holds its position until this lands.
          const state = await actions.tool<{ status: StationStatus }>('state').catch(() => null);
          if (state) setStatus(state.status);
        });
      } catch (err) {
        const message = describeError(err);
        if (message) setWriteError(message);
        await load();
      }
    },
    [actions, gate, load]
  );

  const pending = useMemo(() => writesInFlight(writes.pending), [writes.pending]);
  const shown = useMemo(() => withPending(status, settings, writes.pending), [settings, status, writes.pending]);
  const inUse = device.connections.find((connection) => connection.inUse) ?? null;

  return {
    status: shown.status,
    settings: shown.settings,
    pending,
    readOnly,
    simulated: status?.link.mode === 'simulator',
    direct: holder === 'this-app',
    waitingFor:
      holder === 'other-app' || holder === 'none'
        ? device.health.detail
        : error ?? (holder === 'this-app' ? 'Connecting from this app…' : 'Waiting for the server…'),
    version: holder === 'server' ? version : null,
    linkLabel: inUse
      ? `${inUse.methodLabel}, ${inUse.heldBy.kind === 'server' ? 'through the server' : holder === 'this-app' ? 'from this app' : `from ${inUse.heldBy.name}`}`
      : null,
    resuming: false,
    writeError,
    updateSettings,
    togglePort,
  };
}
