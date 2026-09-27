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
import axios from 'axios';

import { useWriteGate } from '../lib/useWriteGate';
import { useAuth } from './AuthProvider';

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
  providerDeviceId,
  savedDeviceId,
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
  /**
   * The value a control was asked for, while its write is unconfirmed.
   *
   * `undefined` when nothing is in flight. While something is, the control
   * shows this value and stays locked: the device has not said it happened.
   */
  pendingControl: (deviceId: string, controlId: string) => { value: unknown } | undefined;
};

/** One control on one device, as the write gate knows it. */
const controlKey = (deviceId: string, controlId: string) => `${deviceId}\u0000${controlId}`;

const DevicesContext = createContext<DevicesContextValue | null>(null);

export function DevicesProvider({ children }: { children: ReactNode }) {
  const {
    source,
    status,
    connection,
    settings,
    updateSettings,
    togglePort,
    pending: linkPending,
  } = useDirectLink();
  const editable = source === 'server';
  // Polls only once the server will answer: a list fetched before signing in
  // is a stream of 401s, which is not news, and not the server being down.
  const { allowed } = useAuth();
  const polling = editable && allowed;

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

  /*
    Changes in flight: a control being written, or a device being added,
    renamed or forgotten. A list asked for before one finished shows things as
    they were before it — the relay back in the position it was just switched
    from, the device just added missing — so it is not shown. See
    `writeGate.ts` in `@kraftverk/ui`.
  */
  const [gate, writes] = useWriteGate<string>();
  /** Each catalog change is its own write: two of them never wait on each other. */
  const changes = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!polling) {
        // Signed out, or another server: what the last one said is not kept.
        // (The direct link's device is composed below, not fetched.)
        setServed([]);
        setLoading(false);
        return;
      }
      const askedAt = gate.epoch;
      try {
        const next = await fetchDeviceList(signal);
        if (gate.fresh(askedAt)) setServed(next);
        setUnreachable(false);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (!message) return; // aborted
        // "Log in first" is an answer, not an absence: the sign-in screen is
        // already on its way, and a "can't reach the server" banner would lie.
        if (axios.isAxiosError(err) && err.response?.status === 401) return;
        setUnreachable(true);
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [gate, polling]
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer || !polling) return;
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
  }, [polling, load]);

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
      try {
        changes.current += 1;
        const result = await gate.run({ [`catalog:${changes.current}`]: true }, work);
        setError(null);
        return result;
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
        throw err;
      } finally {
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
        try {
          await gate.run({ [controlKey(device.id, controlId)]: value }, async () => {
            // Answered once the device has confirmed it — or refused, or failed.
            await invokeDeviceControl(device.id, controlId, value, confirmation);
            /*
              Then the list as the device reports it now, read *inside* the
              write: the control stays on the value asked for until this lands.
              Reading it afterwards left a moment in which the control showed
              the reading from before the write.
            */
            const next = await fetchDeviceList().catch(() => null);
            if (next) setServed(next);
          });
        } catch (error) {
          // Refused or failed: show the device as it is, not as it was asked to be.
          await load();
          throw error;
        }
        return;
      }

      const control = device.controls.find((candidate) => candidate.id === controlId);
      if (control?.capability !== 'outlets') {
        throw new Error('That control needs the server; this app is holding the link itself.');
      }
      // The direct link holds its own writes, so its switch is locked the same way.
      await togglePort(controlId as PortId, value === true);
    },
    [editable, gate, load, togglePort]
  );

  const pendingControl = useCallback<DevicesContextValue['pendingControl']>(
    (deviceId, controlId) => {
      if (!editable) {
        // The one device a direct link owns is its station, and its switches are
        // held by the link itself, which already shows the asked-for state.
        const port = status?.ports.find((candidate) => candidate.id === controlId);
        return port && linkPending.ports.has(port.id) ? { value: port.enabled } : undefined;
      }
      const key = controlKey(deviceId, controlId);
      return writes.pending.has(key) ? { value: writes.pending.get(key) } : undefined;
    },
    [editable, linkPending, status, writes.pending]
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
    // A direct link has no catalog behind it, so this is the one place the app
    // mints an identity of its own rather than receiving one from the server.
    const mac = status.link.mac ? providerDeviceId(status.link.mac) : null;
    const id = savedDeviceId(`station:${mac ?? 'direct'}`);
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
        // Nothing was ever added: it is here for as long as the link is.
        addedAt: status.lastUpdated ?? status.link.lastSeen ?? new Date().toISOString(),
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
      pendingControl,
    }),
    [
      add,
      devices,
      editable,
      error,
      invoke,
      load,
      loading,
      pendingControl,
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
