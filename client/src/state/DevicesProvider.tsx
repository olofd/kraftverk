import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import {
  addDevice as apiAddDevice,
  describeError,
  fetchDeviceList,
  fetchDeviceSettings,
  fetchDeviceTypes,
  invokeDeviceControl,
  patchDeviceSettings,
  removeDevice as apiRemoveDevice,
  updateDevice as apiUpdateDevice,
} from '@kraftverk/api-client';
import type {
  ConfigValues,
  DeviceSettings,
  DeviceTypeOption,
  DeviceView,
  PortId,
} from '@kraftverk/api-client';
import {
  descriptor as stationDescriptor,
  readings as stationReadings,
  settingsToValues,
  valuesToSettings,
} from '@kraftverk/device-aferiy-p280';

import { useStation } from './StationProvider';

/**
 * The things you own.
 *
 * Separate from `StationProvider` on purpose. That one owns a *link* — a socket
 * to one station, which the app may be holding itself over Bluetooth. This one
 * owns a *catalog*, which only a server keeps: your devices, their names, and
 * their history, all of which outlive whatever happens to be reachable.
 *
 * The consequence is that on a direct link there is no catalog to read — so one
 * is composed from the link itself. An app holding a station's Bluetooth
 * connection owns exactly one device, and the same descriptions the server
 * would have sent are the ones the device package already carries. The grid, the
 * card and the detail screen then work identically on both links, and neither
 * of them has to know which it is looking at.
 *
 * What a direct link genuinely cannot do is *change* the catalog: adding,
 * renaming and forgetting devices are the server's, and they are refused here
 * rather than faked.
 */

/** Readings move slower than the station's own status, and cost more to fetch. */
const POLL_MS = 5000;

type DevicesContextValue = {
  /**
   * Whether the catalog can be changed.
   *
   * False on a direct link, where the list is the one station this app is
   * holding rather than anything persisted. Screens use this to hide what they
   * would otherwise have to disable.
   */
  editable: boolean;
  devices: DeviceView[];
  /** The station, if one has been added. The app's dashboard follows it. */
  station: DeviceView | null;
  /** True until the first answer, so the grid can show a spinner rather than "none". */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** What can be added. Fetched on demand — the add flow is the only reader. */
  types: () => Promise<DeviceTypeOption[]>;
  add: (input: {
    type: 'power-station' | 'smart-plug';
    driver: string;
    name: string;
    model?: string | null;
    config?: Record<string, unknown>;
  }) => Promise<DeviceView>;
  rename: (id: string, name: string) => Promise<void>;
  setModel: (id: string, model: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;

  /**
   * A device's own settings, and a way to change them.
   *
   * Routed here rather than in the screen for the same reason the server has a
   * registry: which side does the reading is a fact about the link, not about
   * the device, and the settings screen should not have to know.
   */
  readSettings: (device: DeviceView) => Promise<DeviceSettings>;
  writeSettings: (device: DeviceView, patch: ConfigValues) => Promise<ConfigValues>;
  /** Invokes a control. Anything physical still passes the server's gateway. */
  invoke: (
    device: DeviceView,
    controlId: string,
    value: boolean | number | string,
    confirmation?: string
  ) => Promise<void>;
};

const DevicesContext = createContext<DevicesContextValue | null>(null);

export function DevicesProvider({ children }: { children: ReactNode }) {
  const { source, status, connection, settings, updateSettings, togglePort } = useStation();
  const editable = source === 'server';

  const [served, setServed] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards the poll from overwriting a list the user just changed.
   *
   * Adding or removing a device is answered by the server before the next poll
   * runs, and without this the in-flight poll's stale list lands afterwards and
   * the device the user just added blinks out of existence.
   */
  const pending = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!editable) {
        setLoading(false);
        return; // the direct link's device is composed below, not fetched
      }
      try {
        const next = await fetchDeviceList(signal);
        if (pending.current === 0) setServed(next);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (!message) return; // aborted
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [editable]
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer || !editable) return;
      timer = setInterval(() => void load(controller.signal), POLL_MS);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };

    setLoading(true);
    void load(controller.signal).then(start);

    // Same bargain the station link makes: nothing polls while backgrounded.
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
  }, [editable, load]);

  /**
   * Runs a change, then reloads.
   *
   * The reload is what keeps a mutation honest: adding a device returns the
   * record, but only the full list shows what the registry made of it — which
   * driver answered, whether it is online, what it is reading.
   */
  const mutate = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      if (!editable) {
        throw new Error('The device list lives on the server; this app is holding the link itself.');
      }
      pending.current += 1;
      try {
        const result = await work();
        setError(null);
        return result;
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
        throw err;
      } finally {
        pending.current -= 1;
        await load();
      }
    },
    [editable, load]
  );

  const add = useCallback<DevicesContextValue['add']>(
    (input) => mutate(() => apiAddDevice(input)),
    [mutate]
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await mutate(() => apiUpdateDevice(id, { name }));
    },
    [mutate]
  );

  const setModel = useCallback(
    async (id: string, model: string | null) => {
      await mutate(() => apiUpdateDevice(id, { model }));
    },
    [mutate]
  );

  const remove = useCallback(
    async (id: string) => {
      await mutate(() => apiRemoveDevice(id));
    },
    [mutate]
  );

  const types = useCallback(() => fetchDeviceTypes(), []);

  const readSettings = useCallback(
    async (device: DeviceView): Promise<DeviceSettings> => {
      if (editable) return fetchDeviceSettings(device.id);
      // No server to ask, so the values come off the link and the schema off the
      // device package — the same two halves the server would have joined.
      return {
        schema: device.settings?.schema ?? null,
        dangerous: [...(device.settings?.dangerous ?? [])],
        values: settings ? settingsToValues(settings) : {},
      };
    },
    [editable, settings]
  );

  const writeSettings = useCallback(
    async (device: DeviceView, patch: ConfigValues): Promise<ConfigValues> => {
      if (editable) return patchDeviceSettings(device.id, patch);
      await updateSettings(valuesToSettings(patch) as never);
      return patch;
    },
    [editable, updateSettings]
  );

  /**
   * Invokes a control.
   *
   * Through a server this is one call and the gateway decides whether it may.
   * On a direct link there is no gateway — and no capability the app could
   * honour anyway — so only the station's own ports are switchable, which is
   * exactly what the app can already reach over Bluetooth.
   */
  const invoke = useCallback(
    async (
      device: DeviceView,
      controlId: string,
      value: boolean | number | string,
      confirmation?: string
    ) => {
      if (editable) {
        await invokeDeviceControl(device.id, controlId, value, confirmation);
        await load();
        return;
      }

      const control = device.controls.find((candidate) => candidate.id === controlId);
      if (control?.capability !== 'station.ports') {
        throw new Error('That control needs the server; this app is holding the link itself.');
      }
      await togglePort(controlId as PortId, value === true);
    },
    [editable, load, togglePort]
  );

  /**
   * The one device a direct link owns.
   *
   * Composed from the same declarations the server would have used — the device
   * package is where they live, and both sides read it. `id` is the station's
   * MAC rather than a catalog id because there is no catalog: nothing persists,
   * so nothing needs a persistent name for it.
   */
  const linked = useMemo<DeviceView | null>(() => {
    if (editable || !status) return null;
    const id = `station:${status.link.mac ?? 'direct'}`;

    return {
      ...stationDescriptor(id, status.name, status.model),
      id,
      record: {
        id,
        type: 'power-station',
        model: null,
        driver: 'core.station',
        name: status.name,
        config: {},
        addedAt: status.lastUpdated,
      },
      online: connection === 'online',
      detail: connection === 'online' ? undefined : 'This app is not connected to the station',
      readings: stationReadings(status),
    };
  }, [connection, editable, status]);

  const devices = useMemo(
    () => (editable ? served : linked ? [linked] : []),
    [editable, linked, served]
  );

  const station = useMemo(
    () => devices.find((device) => device.record.type === 'power-station') ?? null,
    [devices]
  );

  const value = useMemo<DevicesContextValue>(
    () => ({
      editable,
      devices,
      station,
      loading: editable ? loading : false,
      error,
      refresh: () => load(),
      types,
      add,
      rename,
      setModel,
      remove,
      readSettings,
      writeSettings,
      invoke,
    }),
    [
      add,
      devices,
      editable,
      error,
      invoke,
      load,
      loading,
      readSettings,
      remove,
      rename,
      setModel,
      station,
      types,
      writeSettings,
    ]
  );

  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

export function useDevices(): DevicesContextValue {
  const context = useContext(DevicesContext);
  if (!context) {
    throw new Error('useDevices must be used inside <DevicesProvider>');
  }
  return context;
}

/** One device by catalog id, from the list already being polled. */
export function useDevice(id: string | undefined): DeviceView | null {
  const { devices } = useDevices();
  return useMemo(
    () => (id ? (devices.find((device) => device.id === id) ?? null) : null),
    [devices, id]
  );
}
