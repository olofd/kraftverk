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
import { AppState, Platform } from 'react-native';

import {
  describeRegisters,
  StationClient,
  type DiscoveredDevice,
  type RegisterDump,
} from '@kraftverk/protocol';

import {
  API_BASE_URL,
  describeError,
  fetchSettings,
  fetchStatus,
  fetchVersion,
  patchSettings,
  setPort as apiSetPort,
} from '../lib/api';
import {
  forgetRememberedStation,
  readPreference,
  readRememberedStation,
  writePreference,
  writeRememberedStation,
  type RememberedStation,
} from '../lib/preferences';
import type {
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
  VersionInfo,
} from '../lib/types';
import {
  ChooserCancelled,
  createDirectTransport,
  directSupport,
  NativeBleTransport,
  probeDirectSupport,
  WebBluetoothTransport,
  type DirectSupport,
  type DirectTransport,
} from '../link';

const POLL_MS = 2000;
/**
 * Bluetooth is slower and more fragile than HTTP-to-a-server, and every poll is
 * two round trips over a link that drops frames when hurried, so a direct
 * connection asks less often.
 */
const DIRECT_POLL_MS = 3000;

const SOURCE_KEY = 'kraftverk.link.source';

/**
 * `idle` is not a degraded `offline`: it means nothing is connected and nothing
 * is trying, which is the normal resting state of a direct link before you pick
 * a station. Without it the app sat on "Connecting" forever, and on a phone the
 * pull-to-refresh spinner span for as long as you looked at it.
 */
export type Connection = 'connecting' | 'online' | 'offline' | 'idle';

/** Where the app gets its telemetry: through the server, or from the station itself. */
export type LinkSource = 'server' | 'direct';

export type DirectLink = {
  support: DirectSupport;
  scanning: boolean;
  devices: DiscoveredDevice[];
  boundId: string | null;
  connected: boolean;
  /** The station this app last held a link to, if any. */
  remembered: RememberedStation | null;
  /** A reconnect is in flight — on load, or after a tap on Reconnect. */
  resuming: boolean;
  /** Direct connections start read-only, like the server's hardware modes. */
  readOnly: boolean;
  busy: boolean;
  error: string | null;
  /**
   * Choose a station. In a browser this opens the device chooser, so it has to
   * be called straight from a tap; on a phone it starts a scan.
   */
  pick: (showAll?: boolean) => void;
  connect: (id: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Go back to the remembered station: silently if allowed, else one tap. */
  reconnect: () => void;
  /** Drop the remembered station, so the app stops offering it. */
  forget: () => void;
  stopScan: () => void;
  setReadOnly: (value: boolean) => void;
  /** Reads every register, diffed against the last snapshot. */
  dump: () => Promise<RegisterDump>;
  /** Captures the baseline the next dump is diffed against. */
  snapshot: () => Promise<RegisterDump>;
};

type StationContextValue = {
  status: StationStatus | null;
  settings: StationSettings | null;
  version: VersionInfo | null;
  connection: Connection;
  error: string | null;
  apiBaseUrl: string;
  source: LinkSource;
  setSource: (source: LinkSource) => void;
  direct: DirectLink;
  refresh: () => Promise<void>;
  updateSettings: (patch: StationSettingsPatch) => Promise<void>;
  togglePort: (id: PortId, enabled: boolean) => Promise<void>;
};

const StationContext = createContext<StationContextValue | null>(null);

const initialSource = (): LinkSource => (readPreference(SOURCE_KEY) === 'direct' ? 'direct' : 'server');

/** Polls a condition, because a scan reports devices whenever it feels like it. */
function waitFor(test: () => boolean, timeoutMs: number): Promise<boolean> {
  if (test()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (test()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
}

export function StationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [settings, setSettings] = useState<StationSettings | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [connection, setConnection] = useState<Connection>(() =>
    initialSource() === 'direct' ? 'idle' : 'connecting'
  );
  const [error, setError] = useState<string | null>(null);
  const [source, setSourceState] = useState<LinkSource>(initialSource);

  const [support, setSupport] = useState<DirectSupport>(directSupport);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [boundId, setBoundId] = useState<string | null>(null);
  const [directConnected, setDirectConnected] = useState(false);
  const [directReadOnly, setDirectReadOnly] = useState(true);
  const [directBusy, setDirectBusy] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<RememberedStation | null>(readRememberedStation);
  const [resuming, setResuming] = useState(false);

  // Settings edits are optimistic; this guards the poll loop from stomping on
  // a value the user is still dragging.
  const pendingSettings = useRef(0);

  const transportRef = useRef<DirectTransport | null>(null);
  const clientRef = useRef<StationClient | null>(null);
  const baselineRef = useRef<{ at: string; input: number[]; holding: number[] } | null>(null);
  /** Read inside callbacks, so remembering a station doesn't re-create them. */
  const rememberedRef = useRef<RememberedStation | null>(remembered);
  /** One automatic reconnect per visit; after that it is the user's move. */
  const resumeTried = useRef(false);
  const pollingRef = useRef(false);
  const startedAt = useRef(new Date());

  // --- direct link ---------------------------------------------------------

  const syncDirect = useCallback(() => {
    const transport = transportRef.current;
    if (!transport) return;
    setDevices(transport.discovered());
    setBoundId(transport.boundId);
    setDirectConnected(transport.connected);
    setScanning(transport instanceof WebBluetoothTransport ? false : transport.scanning);
  }, []);

  /**
   * Builds the direct link on first use, and never rebuilds it.
   *
   * Synchronous on purpose: in a browser the caller is inside a tap handler and
   * awaiting anything before `requestDevice` spends the user gesture, after
   * which the chooser refuses to open.
   */
  const ensureDirect = useCallback(() => {
    if (!transportRef.current) {
      const transport = createDirectTransport();
      transport.onDiscovery(() => syncDirect());

      clientRef.current = new StationClient({
        transport,
        pollMs: DIRECT_POLL_MS,
        readOnly: true,
        onUpdate: (nextStatus, nextSettings) => {
          setStatus(nextStatus);
          if (pendingSettings.current === 0) setSettings(nextSettings);
          setConnection('online');
          setError(null);
          syncDirect();
        },
        onError: (err) => {
          setConnection('offline');
          setError(describeError(err));
          syncDirect();
        },
      });

      transportRef.current = transport;
    }

    return { transport: transportRef.current, client: clientRef.current! };
  }, [syncDirect]);

  /** Stores (or clears) which station this app last held a link to. */
  const remember = useCallback((record: RememberedStation | null) => {
    rememberedRef.current = record;
    setRemembered(record);
    if (record) writeRememberedStation(record);
    else forgetRememberedStation();
  }, []);

  const connectDirect = useCallback(
    async (id: string) => {
      const { transport, client } = ensureDirect();
      setDirectBusy(true);
      setDirectError(null);
      setConnection('connecting');
      try {
        await transport.bind(id);
        client.reset();
        if (!pollingRef.current) {
          await client.start();
          pollingRef.current = true;
        } else {
          await client.poll();
        }

        // Remembered by name as well as id: the id is an opaque per-origin
        // handle, so the advertised name is the only part worth showing a user.
        const found = transport.discovered().find((device) => device.id === id);
        remember({
          id,
          name: found?.name ?? rememberedRef.current?.name ?? id,
          kind: transport.kind,
          at: new Date().toISOString(),
          autoConnect: true,
        });
      } catch (err) {
        setDirectError(describeError(err));
        // Not "offline": nothing is connected and nothing is trying, which is
        // a resting state rather than a lost link.
        setConnection('idle');
      } finally {
        setDirectBusy(false);
        syncDirect();
      }
    },
    [ensureDirect, remember, syncDirect]
  );

  /**
   * Reconnects to a remembered station without asking anything of the user.
   *
   * Whether that is possible is entirely the platform's call. In a browser it
   * works only when the Bluetooth permission persisted, which `getDevices()`
   * tells us; on a phone we can simply scan for the id. When it isn't possible
   * this stays quiet and leaves the station on screen as a one-tap Reconnect,
   * rather than reporting a failure the user did not cause.
   */
  const resumeDirect = useCallback(
    async (target: RememberedStation) => {
      const { transport } = ensureDirect();
      setResuming(true);
      setConnection('connecting');
      try {
        await transport.start();
        const knows = () => transport.discovered().some((device) => device.id === target.id);
        let known = knows();

        if (!known && transport instanceof NativeBleTransport) {
          transport.scan(10);
          known = await waitFor(knows, 10_000);
          transport.stopScan();
        }

        if (known) await connectDirect(target.id);
        // Not found: the station is asleep, out of range, or this browser no
        // longer holds permission. Leave it on screen as a one-tap Reconnect
        // rather than raising an error nobody caused.
        else setConnection('idle');
      } catch (err) {
        setDirectError(describeError(err));
        setConnection('idle');
      } finally {
        setResuming(false);
        syncDirect();
      }
    },
    [connectDirect, ensureDirect, syncDirect]
  );

  const pickDirect = useCallback(
    (showAll = false) => {
      const { transport } = ensureDirect();
      setDirectError(null);

      if (transport instanceof WebBluetoothTransport) {
        setDirectBusy(true);
        // Not awaited before the call: the chooser needs the live gesture.
        transport
          .requestDevice(showAll)
          .then((device) => connectDirect(device.id))
          .catch((err) => {
            // Closing the chooser rejects too; that is a choice, not a fault.
            if (err instanceof ChooserCancelled) return;
            setDirectError(describeError(err));
            // A browser that refuses the chooser will refuse the next one too,
            // so stop offering it as though it might work.
            void probeDirectSupport().then((reason) => {
              if (reason) setSupport((current) => ({ ...current, supported: false, reason }));
            });
          })
          .finally(() => {
            setDirectBusy(false);
            syncDirect();
          });
        return;
      }

      setDirectBusy(true);
      void transport
        .start()
        .then(() => {
          transport.scan();
          syncDirect();
        })
        .catch((err) => setDirectError(describeError(err)))
        .finally(() => {
          setDirectBusy(false);
          syncDirect();
        });
    },
    [connectDirect, ensureDirect, syncDirect]
  );

  /**
   * Back to the remembered station, by whichever route this platform allows.
   *
   * Called from a tap, so the browser branch must reach `requestDevice`
   * without awaiting anything first — the gesture is spent otherwise.
   */
  const reconnectDirect = useCallback(() => {
    const target = rememberedRef.current;
    if (!target) return;
    const { transport } = ensureDirect();
    setDirectError(null);

    if (transport instanceof WebBluetoothTransport) {
      // Already permitted: no chooser at all, just connect.
      if (transport.discovered().some((device) => device.id === target.id)) {
        void connectDirect(target.id);
        return;
      }

      // Otherwise the chooser is the only way back — narrowed to this one
      // station, so it is a single click rather than a second hunt.
      setDirectBusy(true);
      transport
        .requestDevice(false, target.name)
        .then((device) => connectDirect(device.id))
        .catch((err) => {
          if (err instanceof ChooserCancelled) return;
          setDirectError(describeError(err));
        })
        .finally(() => {
          setDirectBusy(false);
          syncDirect();
        });
      return;
    }

    void resumeDirect(target);
  }, [connectDirect, ensureDirect, resumeDirect, syncDirect]);

  const disconnectDirect = useCallback(async () => {
    const transport = transportRef.current;
    const client = clientRef.current;
    if (!transport || !client) return;

    setDirectBusy(true);
    try {
      await client.stop();
      pollingRef.current = false;
      await transport.unbind();
      client.reset();
      setStatus(null);
      setSettings(null);
      setConnection('idle');

      /*
        Deliberate disconnect: keep the station on file so it is one tap away,
        but stop reconnecting on load. A refreshed tab that grabbed the link
        back would take the station's single Bluetooth slot off whoever the
        user just handed it to — the server, or the vendor app.
      */
      const current = rememberedRef.current;
      if (current) remember({ ...current, autoConnect: false });
    } finally {
      setDirectBusy(false);
      syncDirect();
    }
  }, [remember, syncDirect]);

  const forgetDirect = useCallback(() => remember(null), [remember]);

  const stopScan = useCallback(() => {
    const transport = transportRef.current;
    if (transport && !(transport instanceof WebBluetoothTransport)) transport.stopScan();
    syncDirect();
  }, [syncDirect]);

  /**
   * Writes stay refused until this is turned on deliberately, matching the
   * server's hardware modes. The guard itself lives in `StationClient`.
   */
  const setReadOnly = useCallback((value: boolean) => {
    setDirectReadOnly(value);
    if (clientRef.current) clientRef.current.readOnly = value;
  }, []);

  /**
   * The register dump and its baseline diff, over the app's own link.
   *
   * The baseline is kept in memory here, not on disk as the server keeps it, so
   * a reload starts a fresh comparison. Both build their rows with the same
   * `describeRegisters`, so a dump reads the same on either link.
   */
  const dumpDirect = useCallback(async (): Promise<RegisterDump> => {
    const client = clientRef.current;
    if (!client) throw new Error('No station connected');

    const input = await client.readAllInput();
    const holding = await client.readAllHolding();
    const baseline = baselineRef.current;

    return {
      mac: client.mac,
      readOnly: client.readOnly,
      baselineAt: baseline?.at ?? null,
      input: describeRegisters(input, 'input', baseline?.input),
      holding: describeRegisters(holding, 'holding', baseline?.holding),
    };
  }, []);

  const snapshotDirect = useCallback(async (): Promise<RegisterDump> => {
    const client = clientRef.current;
    if (!client) throw new Error('No station connected');

    const input = await client.readAllInput();
    const holding = await client.readAllHolding();
    baselineRef.current = { at: new Date().toISOString(), input, holding };

    return dumpDirect();
  }, [dumpDirect]);

  // --- server link ---------------------------------------------------------

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
    if (source !== 'server') return;

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
  }, [load, poll, source]);

  /**
   * Switching source resets the view rather than leaving the previous link's
   * numbers on screen, and drops the Bluetooth connection on the way out —
   * these stations accept one connection at a time, so holding it would lock
   * the server out of the station the user just switched to.
   */
  const setSource = useCallback(
    (next: LinkSource) => {
      if (next === source) return;
      writePreference(SOURCE_KEY, next);
      setStatus(null);
      setSettings(null);
      setVersion(null);
      setError(null);
      setConnection(next === 'server' ? 'connecting' : 'idle');
      if (next === 'server') void disconnectDirect();
      setSourceState(next);
    },
    [disconnectDirect, source]
  );

  /**
   * Pick up where the last session left off.
   *
   * Starting the transport adopts whatever this origin already has permission
   * for, which is also what makes a silent reconnect possible; if the station
   * we were last on is in there, go straight back to it. A station remembered
   * on another platform is ignored — a browser's device ids mean nothing to a
   * phone.
   */
  useEffect(() => {
    if (source !== 'direct' || !support.supported) return;

    const { transport } = ensureDirect();
    let live = true;

    void (async () => {
      await transport.start().catch(() => {});
      if (!live) return;
      syncDirect();

      const target = rememberedRef.current;
      if (!target || !target.autoConnect || target.kind !== support.kind) return;
      if (resumeTried.current || transport.boundId) return;

      resumeTried.current = true;
      await resumeDirect(target);
    })();

    return () => {
      live = false;
    };
  }, [ensureDirect, resumeDirect, source, support.kind, support.supported, syncDirect]);

  /**
   * Ask the browser whether it would actually open a chooser. It can have the
   * whole API present and still refuse — Brave ships it switched off, and an
   * enterprise policy can do the same to Chrome — and finding that out at the
   * tap makes it look like this app broke.
   */
  useEffect(() => {
    if (source !== 'direct') return;
    let live = true;
    void probeDirectSupport().then((reason) => {
      if (live && reason) setSupport((current) => ({ ...current, supported: false, reason }));
    });
    return () => {
      live = false;
    };
  }, [source]);

  // The link can drop without any traffic to notice it, so keep the badge honest.
  useEffect(() => {
    if (source !== 'direct') return;
    const timer = setInterval(syncDirect, 1000);
    return () => clearInterval(timer);
  }, [source, syncDirect]);

  useEffect(() => () => void clientRef.current?.stop(), []);

  // --- actions -------------------------------------------------------------

  const refresh = useCallback(async () => {
    setConnection((current) => (current === 'online' ? current : 'connecting'));
    if (source === 'direct') {
      await clientRef.current?.poll();
      return;
    }
    await load();
  }, [load, source]);

  const updateSettings = useCallback(
    async (patch: StationSettingsPatch) => {
      setSettings((current) => (current ? { ...current, ...patch } : current));
      pendingSettings.current += 1;
      try {
        if (source === 'direct') {
          const client = clientRef.current;
          if (!client) throw new Error('No station connected');
          setSettings(await client.applySettings(patch));
        } else {
          setSettings(await patchSettings(patch));
        }
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
        // Rejected or unreachable — resync so the UI stops lying.
        try {
          setSettings(
            source === 'direct' ? (clientRef.current?.settings() ?? null) : await fetchSettings()
          );
        } catch {
          /* leave the optimistic value; the banner already says we're offline */
        }
      } finally {
        pendingSettings.current -= 1;
      }
    },
    [source]
  );

  const togglePort = useCallback(
    async (id: PortId, enabled: boolean) => {
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
        if (source === 'direct') {
          const client = clientRef.current;
          if (!client) throw new Error('No station connected');
          setStatus(await client.setPort(id, enabled));
        } else {
          setStatus(await apiSetPort(id, enabled));
        }
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
        if (source === 'direct') setStatus(clientRef.current?.status() ?? null);
      }
    },
    [source]
  );

  /**
   * On a direct link there is no server to ask for a version, but the screens
   * that report read-only mode and runtime read this, so describe the link the
   * app is actually holding.
   */
  const directVersion = useMemo<VersionInfo | null>(() => {
    if (source !== 'direct') return null;
    return {
      name: 'kraftverk',
      version: 'direct',
      runtime: `${support.label} · ${Platform.OS}`,
      startedAt: startedAt.current.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.current.getTime()) / 1000),
      link: 'device',
      transport: support.kind,
      readOnly: directReadOnly,
    };
  }, [directReadOnly, source, support.kind, support.label]);

  const direct = useMemo<DirectLink>(
    () => ({
      support,
      scanning,
      devices,
      boundId,
      connected: directConnected,
      readOnly: directReadOnly,
      busy: directBusy,
      error: directError,
      remembered,
      resuming,
      pick: pickDirect,
      connect: connectDirect,
      disconnect: disconnectDirect,
      reconnect: reconnectDirect,
      forget: forgetDirect,
      stopScan,
      setReadOnly,
      dump: dumpDirect,
      snapshot: snapshotDirect,
    }),
    [
      boundId,
      connectDirect,
      devices,
      dumpDirect,
      forgetDirect,
      reconnectDirect,
      remembered,
      resuming,
      snapshotDirect,
      directBusy,
      directConnected,
      directError,
      directReadOnly,
      disconnectDirect,
      pickDirect,
      scanning,
      setReadOnly,
      stopScan,
      support,
    ]
  );

  const value = useMemo<StationContextValue>(
    () => ({
      status,
      settings,
      version: source === 'direct' ? directVersion : version,
      connection,
      error,
      apiBaseUrl: API_BASE_URL,
      source,
      setSource,
      direct,
      refresh,
      updateSettings,
      togglePort,
    }),
    [
      connection,
      direct,
      directVersion,
      error,
      refresh,
      setSource,
      settings,
      source,
      status,
      togglePort,
      updateSettings,
      version,
    ]
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
