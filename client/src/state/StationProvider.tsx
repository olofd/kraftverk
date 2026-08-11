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
  API_BASE_URL,
  describeError,
  fetchSettings,
  fetchStatus,
  fetchVersion,
  patchSettings,
  setGridConnected as apiSetGrid,
  setPort as apiSetPort,
} from '../lib/api';
import type {
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
  VersionInfo,
} from '../lib/types';

const POLL_MS = 2000;

export type Connection = 'connecting' | 'online' | 'offline';

type StationContextValue = {
  status: StationStatus | null;
  settings: StationSettings | null;
  version: VersionInfo | null;
  connection: Connection;
  error: string | null;
  apiBaseUrl: string;
  refresh: () => Promise<void>;
  updateSettings: (patch: StationSettingsPatch) => Promise<void>;
  togglePort: (id: PortId, enabled: boolean) => Promise<void>;
  setGridConnected: (connected: boolean) => Promise<void>;
};

const StationContext = createContext<StationContextValue | null>(null);

export function StationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [settings, setSettings] = useState<StationSettings | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);

  // Settings edits are optimistic; this guards the poll loop from stomping on
  // a value the user is still dragging.
  const pendingSettings = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nextStatus, nextVersion, nextSettings] = await Promise.all([
        fetchStatus(signal),
        fetchVersion(signal),
        fetchSettings(signal),
      ]);
      setStatus(nextStatus);
      setVersion(nextVersion);
      if (pendingSettings.current === 0) setSettings(nextSettings);
      setConnection('online');
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (!message) return; // aborted
      setConnection('offline');
      setError(message);
    }
  }, []);

  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await fetchStatus(signal));
      setConnection('online');
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (!message) return;
      setConnection('offline');
      setError(message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        void poll(controller.signal);
      }, POLL_MS);
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
  }, [load, poll]);

  const refresh = useCallback(async () => {
    setConnection((current) => (current === 'online' ? current : 'connecting'));
    await load();
  }, [load]);

  const updateSettings = useCallback(async (patch: StationSettingsPatch) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    pendingSettings.current += 1;
    try {
      setSettings(await patchSettings(patch));
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
      // Server rejected or is unreachable — resync so the UI stops lying.
      try {
        setSettings(await fetchSettings());
      } catch {
        /* leave the optimistic value; the banner already says we're offline */
      }
    } finally {
      pendingSettings.current -= 1;
    }
  }, []);

  const togglePort = useCallback(async (id: PortId, enabled: boolean) => {
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
      setStatus(await apiSetPort(id, enabled));
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, []);

  const setGridConnected = useCallback(async (connected: boolean) => {
    try {
      setStatus(await apiSetGrid(connected));
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, []);

  const value = useMemo<StationContextValue>(
    () => ({
      status,
      settings,
      version,
      connection,
      error,
      apiBaseUrl: API_BASE_URL,
      refresh,
      updateSettings,
      togglePort,
      setGridConnected,
    }),
    [status, settings, version, connection, error, refresh, updateSettings, togglePort, setGridConnected]
  );

  return <StationContext.Provider value={value}>{children}</StationContext.Provider>;
}

export function useStation(): StationContextValue {
  const context = useContext(StationContext);
  if (!context) {
    throw new Error('useStation must be used inside <StationProvider>');
  }
  return context;
}
