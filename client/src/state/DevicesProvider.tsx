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
  SavedDeviceView,
  PortId,
} from '@kraftverk/api-client';
import {
  descriptor as stationDescriptor,
  readings as stationReadings,
  settingsToValues,
  valuesToSettings,
} from '@kraftverk/device-aferiy-p280';

import { useDirectLink, type Connection } from './DirectLinkProvider';

/**
 * The things you own.
 *
 * Separate from `DirectLinkProvider` on purpose. That one owns a *link* — a socket
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
  /**
   * Whether the app can reach the thing that holds the catalog.
   *
   * On a server link this is the server; on a direct link it is the station the
   * app is holding itself. It lives here rather than in a station provider
   * because it is a fact about the *link*, and the catalog is the one thing
   * polled on every screen — so it is what notices first.
   */
  connection: Connection;
  devices: SavedDeviceView[];
  /** The station, if one has been added. The app's dashboard follows it. */
  station: SavedDeviceView | null;
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
  }) => Promise<SavedDeviceView>;
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
  readSettings: (device: SavedDeviceView) => Promise<DeviceSettings>;
  writeSettings: (device: SavedDeviceView, patch: ConfigValues) => Promise<ConfigValues>;
  /** Invokes a control. Anything physical still passes the server's gateway. */
  invoke: (
    device: SavedDeviceView,
    controlId: string,
    value: boolean | number | string,
    confirmation?: string
  ) => Promise<void>;
};

const DevicesContext = createContext<DevicesContextValue | null>(null);

export function DevicesProvider({ children }: { children: ReactNode }) {
  const { source, status, connection, settings, updateSettings, togglePort } = useDirectLink();
  const editable = source === 'server';

  const [served, setServed] = useState<SavedDeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set only by the poll, never by an action.
   *
   * "The server refused what you asked" and "the server is not there" are
   * different facts, and conflating them put the whole app behind a *Can't
   * reach the API server* banner whenever a rename collided or a second station
   * was refused — while the server was answering perfectly well.
   */
  const [unreachable, setUnreachable] = useState(false);

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
        setUnreachable(false);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (!message) return; // aborted
        setUnreachable(true);
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
    async (device: SavedDeviceView): Promise<DeviceSettings> => {
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
    async (device: SavedDeviceView, patch: ConfigValues): Promise<ConfigValues> => {
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
      device: SavedDeviceView,
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
  const linked = useMemo<SavedDeviceView | null>(() => {
    if (editable || !status) return null;
    const mac = status.link.mac;
    const id = `station:${mac ?? 'direct'}`;
    const { id: _providerId, name: _providerName, ...descriptor } = stationDescriptor(
      id,
      status.name,
      status.model
    );

    return {
      ...descriptor,
      id,
      // The station's MAC *is* the provider identity here, and with no catalog
      // it is also standing in as the saved id — which is exactly the conflation
      // the two fields exist to make visible rather than hide.
      providerDeviceId: mac,
      name: status.name,
      providerName: null,
      record: {
        id,
        type: 'power-station',
        model: null,
        driver: 'core.station',
        name: status.name,
        config: {},
        addedAt: status.lastUpdated,
      },
      health: {
        status: connection === 'online' ? 'connected' : connection === 'connecting' ? 'connecting' : 'offline',
        detail:
          connection === 'online'
            ? 'Connected over Bluetooth'
            : connection === 'connecting'
              ? 'Connecting over Bluetooth'
              : 'This app is not connected to the station',
        // The app in your hand holds this one, which is the whole distinction:
        // it cannot survive the screen locking, and it records no history.
        owner: 'client',
        transport: status.link.transport ?? null,
        lastReadingAt: status.lastUpdated,
      },
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

  /*
    The catalog is polled on every screen, so its last answer is the honest
    report of whether the server is there. On a direct link there is no server
    in the path at all, and the station's own link is the only thing to report.
  */
  const reachability: Connection = !editable
    ? connection
    : unreachable
      ? 'offline'
      : loading
        ? 'connecting'
        : 'online';

  const value = useMemo<DevicesContextValue>(
    () => ({
      editable,
      connection: reachability,
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
      reachability,
      remove,
      rename,
      setModel,
      station,
      types,
      unreachable,
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
export function useDevice(id: string | undefined): SavedDeviceView | null {
  const { devices } = useDevices();
  return useMemo(
    () => (id ? (devices.find((device) => device.id === id) ?? null) : null),
    [devices, id]
  );
}
