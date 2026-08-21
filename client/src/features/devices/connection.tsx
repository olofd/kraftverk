import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  describeError,
  fetchStationDevice,
  fetchVersion,
  invokeDeviceControl,
  isOnline,
  patchStationDevice,
} from '@kraftverk/api-client';
import type {
  SavedDeviceView,
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
  VersionInfo,
} from '@kraftverk/api-client';

import { useDirectLink } from '../../state/DirectLinkProvider';

/**
 * One device's live connection.
 *
 * This is what replaced the global station state. The app used to hold a
 * single `status`, a single `settings` and one set of write functions, and
 * every screen read them — which meant the station was not a device, it was the
 * application, and a second station would have shown the first one's numbers on
 * both dashboards.
 *
 * Everything here is scoped to the device you name. Where the answer comes from
 * is a fact about the link, not about the device: through a server it is that
 * device's own route, and on a direct link it is the station this app is
 * holding itself. A screen should not have to know which, so it doesn't.
 */

/** Slower than the server's own polling; two seconds is what the panels expect. */
const POLL_MS = 2000;

export type DeviceConnection = {
  status: StationStatus | null;
  settings: StationSettings | null;
  /**
   * What is serving this device: the server, or the link the app holds itself.
   *
   * The model's panels show it in their connection card. It is fetched once
   * rather than arriving with every status poll — a fact about the server does
   * not change twice a second, and bundling it into station telemetry is how
   * "is this link read-only" ended up being a property of the whole app.
   */
  version: VersionInfo | null;
  /** True while the link refuses writes. A read-only server, or a direct link. */
  readOnly: boolean;
  simulated: boolean;
  /** The app is holding this station's Bluetooth connection itself. */
  direct: boolean;
  /** Why the last read or write failed, when one did. */
  error: string | null;
  /**
   * Why there is nothing to show, when the server can explain it.
   *
   * Distinct from `error`: nothing went wrong, the server simply is not holding
   * a link to this device — it can serve one station at a time, or its
   * transport never started. A screen should say that rather than spin.
   */
  reason: string | null;
  refresh: () => Promise<void>;
  updateSettings: (patch: StationSettingsPatch) => Promise<void>;
  togglePort: (id: PortId, enabled: boolean) => Promise<void>;
};

export function useDeviceConnection(device: SavedDeviceView | null): DeviceConnection {
  const link = useDirectLink();
  /*
    Only a station has this state to fetch. The server refuses the route for
    anything else — correctly — but a plug's screens should not be asking it
    twice a second to be told so, and a device that is not a station is not a
    broken device: it has no station telemetry, which is a different thing.
  */
  const isStation = device?.record.driver === 'core.station';
  const served = link.source === 'server';
  /** Only a station has station state to fetch. */
  const pollable = served && isStation;
  const deviceId = device?.id;

  const [status, setStatus] = useState<StationStatus | null>(null);
  const [settings, setSettings] = useState<StationSettings | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    // Only the model's own panels show it, so only they pay for it.
    if (!pollable) return;
    const controller = new AbortController();
    void fetchVersion(controller.signal)
      .then(setVersion)
      .catch(() => undefined);
    return () => controller.abort();
  }, [pollable]);

  /** Guards the poll from stomping on a value the user is still dragging. */
  const pending = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!pollable || !deviceId) return;
      try {
        const state = await fetchStationDevice(deviceId, signal);
        setStatus(state.status);
        if (pending.current === 0) setSettings(state.settings);
        setReadOnly(state.readOnly);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (!message) return; // aborted
        setError(message);
      }
    },
    [deviceId, pollable]
  );

  useEffect(() => {
    if (!pollable || !deviceId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(controller.signal), POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };

    void load(controller.signal).then(start);

    // Don't burn battery polling while the app is backgrounded on iOS.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void load(controller.signal);
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
      controller.abort();
    };
  }, [deviceId, load, pollable]);

  const updateSettings = useCallback(
    async (patch: StationSettingsPatch) => {
      if (!served) return link.updateSettings(patch);
      if (!deviceId) throw new Error('No device');

      setSettings((current) => (current ? { ...current, ...patch } : current));
      pending.current += 1;
      try {
        // A readback, not an echo: one setting can move another on this hardware.
        setSettings(await patchStationDevice(deviceId, patch));
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
        // Rejected or unreachable — resync so the UI stops lying.
        await fetchStationDevice(deviceId)
          .then((state) => setSettings(state.settings))
          .catch(() => undefined);
      } finally {
        pending.current -= 1;
      }
    },
    [deviceId, link, served]
  );

  const togglePort = useCallback(
    async (id: PortId, enabled: boolean) => {
      if (!served) return link.togglePort(id, enabled);
      if (!deviceId) throw new Error('No device');

      setStatus((current) =>
        current
          ? {
              ...current,
              ports: current.ports.map((port) =>
                port.id === id ? { ...port, enabled, watts: enabled ? port.watts : 0 } : port
              ),
            }
          : current
      );
      try {
        // Through the device's own control route, so a port switch passes the
        // same gateway every other physical action does.
        await invokeDeviceControl(deviceId, id, enabled);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
      } finally {
        await load();
      }
    },
    [deviceId, link, load, served]
  );

  const refresh = useCallback(async () => {
    if (!served) return link.refresh();
    await load();
  }, [link, load, served]);

  return useMemo<DeviceConnection>(
    () =>
      served
        ? {
            status,
            settings,
            version,
            readOnly,
            simulated: status?.link.mode === 'simulator',
            direct: false,
            error,
            /*
              The registry already wrote the reason onto the device itself, so
              the card on the canvas and the device's own screen agree.

              Health is asked first, and not merely for tidiness: every state
              carries a sentence now, including the connected ones. Reading the
              sentence alone would put "Connected" in the middle of a dashboard
              during the moment before the first telemetry arrives — a reason
              given for something that is not happening.
            */
            reason: status || !device || isOnline(device.health) ? null : device.health.detail,
            refresh,
            updateSettings,
            togglePort,
          }
        : {
            // On a direct link the app *is* the connection, and it holds exactly
            // one station — so this device's state is that link's state.
            status: link.status,
            settings: link.settings,
            version: link.version,
            readOnly: link.direct.readOnly,
            simulated: false,
            direct: true,
            error: link.error,
            reason: null,
            refresh: link.refresh,
            updateSettings: link.updateSettings,
            togglePort: link.togglePort,
          },
    [
      device,
      error,
      link,
      readOnly,
      refresh,
      served,
      settings,
      status,
      togglePort,
      updateSettings,
      version,
    ]
  );
}
