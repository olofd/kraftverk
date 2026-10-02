import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSegments } from 'expo-router';

import {
  applyLive,
  createViews,
  describeError,
  deviceActions,
  holderOf,
  type ConnectionView,
  type DeviceActions,
  type DeviceScreenProps,
  type DeviceView,
  type PictureRef,
  type LinkView,
  type LiveState,
  type LiveStream,
  type LiveUpdate,
  type NewLink,
  type VersionInfo,
  type Views,
} from '@kraftverk/api-client';
import { ApiError } from '@kraftverk/api-contract';
import { savedDeviceId, type ConnectionId, type LinkId } from '@kraftverk/device-sdk';

import { ask } from '../platform/confirm';
import { useAuth } from './AuthProvider';
import { useHome } from './HomeProvider';
import { useServers } from './ServersProvider';
import { useReach } from './useReach';

/**
 * The things you have, whoever holds them.
 *
 * The list is the home's (`useHome`): a server's, with what this app holds
 * for it wrapped in, or the app's own — one interface either way, so
 * nothing here asks which. A device is one `DeviceView`, and its screens
 * get actions that the home sends to whoever holds its connection in use:
 * the server, or this app's own gateway. No screen asks which.
 */

/**
 * The list is read when the live stream opens, and kept current by it after
 * that. Only while the stream is down is it read every few seconds; while it
 * is up, rarely, in case anything was missed.
 */
const POLL_MS = 5000;

const POLL_WHILE_LIVE_MS = 60_000;

/** Updates from the stream are applied together, this often at most: one redraw for a burst. */
const APPLY_MS = 100;

/** Whether the home answers: being reached, answering, or out of reach. */
export type HomeReach = 'connecting' | 'online' | 'offline';

type DevicesContextValue = {
  homeReach: HomeReach;
  /** Whether the home's live stream is up: when it is not, the list is polled. */
  live: LiveState;
  devices: DeviceView[];
  /** Removed devices, with their history. */
  removed: DeviceView[];
  loading: boolean;
  error: string | null;
  /** The server, when there is one. */
  version: VersionInfo | null;
  refresh: () => Promise<void>;
  /** What a device's screens can do, through whoever holds it. */
  actionsFor: (device: DeviceView) => DeviceActions;
  /** Everything a device's own screens are handed. */
  screenProps: (device: DeviceView) => DeviceScreenProps;
  rename: (id: string, name: string) => Promise<void>;
  /** Its name in configuration (docs/CONFIG.md). */
  setKey: (id: string, key: string) => Promise<void>;
  /** Whether a home-held connection's secrets may leave in an export as plain text. */
  setExportable: (device: DeviceView, connection: ConnectionView, exportable: boolean) => Promise<void>;
  /** Shows another picture (`type:N`), kept by the home. */
  setPicture: (id: string, picture: PictureRef) => Promise<void>;
  remove: (id: string) => Promise<void>;
  deleteHistory: (id: string, name: string) => Promise<void>;
  prefer: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  removeConnection: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  addLink: (link: NewLink) => Promise<void>;
  removeLink: (link: LinkView) => Promise<void>;
  /** The last event the live stream carried, counted, so a list of events knows to read again. */
  heard: { deviceId: string; count: number } | null;
  /**
   * Hears, from the live stream, that an automation moved — a run started,
   * took a step or ended — for as long as a screen showing it is open. Returns
   * how to stop hearing.
   */
  onAutomation: (listener: (id: string) => void) => () => void;
  /** What the screen shows, told to the home (`useShowing`, `views.ts`). */
  views: Views;
};

const DevicesContext = createContext<DevicesContextValue | null>(null);

export function DevicesProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const { allowed } = useAuth();
  const { api, role, away } = useHome();
  const reach = useReach();
  // A server's list is read once signed in; the app's own, always.
  const reading = role === 'master' || allowed;

  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [removed, setRemoved] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  /** Who hears that an automation moved: the screens showing one, while they are open. */
  const automationListeners = useRef(new Set<(id: string) => void>());
  const onAutomation = useCallback((listener: (id: string) => void) => {
    automationListeners.current.add(listener);
    return () => void automationListeners.current.delete(listener);
  }, []);
  // Opening at first: the stream reads the list when it opens, and says so if it cannot.
  const [live, setLive] = useState<LiveState>('connecting');
  const [heard, setHeard] = useState<{ deviceId: string; count: number } | null>(null);

  /*
    What the screen shows, said to the home over the live stream: the screen
    by its route, and the things its parts show (`useShowing`). The home
    judges what follows — a device looked at is read more often.
  */
  const stream = useRef<LiveStream | null>(null);
  const views = useMemo(() => createViews((view) => stream.current?.say(view)), []);
  const segments = useSegments();
  const route = segments.join('/') || 'home';
  useEffect(() => views.screen(route), [route, views]);
  // Using the app says someone is there; on the web, any key, click or scroll. A phone's touches are each screen's (`Screen`).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const used = () => views.used();
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const event of events) document.addEventListener(event, used, { passive: true });
    return () => {
      for (const event of events) document.removeEventListener(event, used);
    };
  }, [views]);

  // With a server: what it is, and whether it refuses every write.
  useEffect(() => {
    if (!servers.server || !allowed) return;
    void servers.server.version().then(setVersion).catch(() => undefined);
  }, [allowed, servers.server]);

  const load = useCallback(async () => {
    if (!reading) {
      setDevices([]);
      setRemoved([]);
      setLoading(false);
      return;
    }
    try {
      const [next, gone] = await Promise.all([api.devices.list(), api.devices.removed().catch(() => [])]);
      setDevices(next);
      setRemoved(gone);
      setUnreachable(false);
      setError(null);
    } catch (err) {
      // Asked to sign in: the sign-in screen says so, not this.
      if (err instanceof ApiError && err.kind === 'forbidden') return;
      setUnreachable(true);
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [api, reading]);

  /*
    The server stopped answering, or answers again: the list is read again
    now — with it away, as it last said it, its own devices offline; back,
    as it is — rather than when the live stream next gives up trying.
  */
  useEffect(() => {
    if (role === 'follower' && reading) void load();
  }, [away]);

  // The live stream: while it is up, what changed arrives as it changes, and the list is not polled.
  useEffect(() => {
    if (!reading) return;
    let pending: LiveUpdate[] = [];
    let applying: ReturnType<typeof setTimeout> | null = null;
    let reloading: ReturnType<typeof setTimeout> | null = null;

    const apply = () => {
      applying = null;
      const batch = pending;
      pending = [];
      setDevices((devices) => applyLive(devices, batch));
    };
    // Read the list again, once for a burst of "changed".
    const readAgain = () => {
      reloading ??= setTimeout(() => {
        reloading = null;
        void load();
      }, APPLY_MS);
    };
    const onUpdate = (update: LiveUpdate) => {
      // Hello: read the list, and apply what follows on top of it.
      if (update.type === 'hello' || update.type === 'changed') return readAgain();
      if (update.type === 'event') return setHeard((last) => ({ deviceId: update.deviceId, count: (last?.count ?? 0) + 1 }));
      if (update.type === 'automation') {
        for (const listener of automationListeners.current) listener(update.id);
        return;
      }
      if (update.type !== 'readings' && update.type !== 'health') return;
      pending.push(update);
      applying ??= setTimeout(apply, APPLY_MS);
    };
    const start = () => {
      if (stream.current) return;
      stream.current = api.live(onUpdate, { onState: setLive });
      // What the screen shows, said as it opens: the home keeps it only while the stream is open.
      const shown = views.current();
      if (shown) stream.current.say(shown);
    };
    const stop = () => {
      stream.current?.close();
      stream.current = null;
      setLive('down');
    };

    start();
    // In the background it is closed, and opened again on return: a phone's battery is not spent on a screen nobody sees.
    const subscription = AppState.addEventListener('change', (next) => (next === 'active' ? start() : stop()));
    return () => {
      stop();
      subscription.remove();
      if (applying) clearTimeout(applying);
      if (reloading) clearTimeout(reloading);
    };
  }, [api, load, reading, views]);

  /*
    The list read without the stream: every few seconds while it is down, and
    now and then while it is up, in case a change was missed. While it is
    opening, nothing — its hello reads the list, and a stream that fails says
    so and is down. Signed out of a server, the list is emptied.
  */
  useEffect(() => {
    if (!reading) {
      void load();
      return;
    }
    if (live === 'connecting') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Set once this run is cleaned up: a read still in flight must not start a timer nobody will stop.
    let done = false;
    const every = live === 'live' ? POLL_WHILE_LIVE_MS : POLL_MS;
    const start = () => {
      if (!done && AppState.currentState !== 'background') timer ??= setInterval(() => void load(), every);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    if (live === 'down' && AppState.currentState !== 'background') {
      setLoading((was) => was || devices.length === 0);
      void load().then(start);
    } else start();
    // Back in front, the stream opens again and its hello reads the list; this only picks up its clock again.
    const subscription = AppState.addEventListener('change', (next) => (next === 'active' ? start() : stop()));
    return () => {
      done = true;
      stop();
      subscription.remove();
    };
    // `devices`: only whether there is anything yet, for the first spinner.
  }, [live, load, reading]);

  // --- what a device's screens can do -------------------------------------------

  const actionsFor = useCallback((device: DeviceView): DeviceActions => deviceActions(api, device, ask), [api]);

  const screenProps = useCallback(
    (device: DeviceView): DeviceScreenProps => {
      const holder = holderOf(device);
      const inUse = device.connections.find((connection) => connection.inUse) ?? null;
      const via = inUse ? `${inUse.methodLabel}, ${reach.of(inUse.heldBy)}` : null;
      return {
        device,
        actions: actionsFor(device),
        // Whether it can be reached, and what to say while it cannot — never by whom.
        reach: {
          now: holder === 'master' || holder === 'this-node',
          waiting: holder === 'master' || holder === 'this-node' ? reach.waiting(holder) : device.health.detail,
          via,
        },
        // Said by the node holding it: its own switch, never for a simulated one.
        readOnly: device.readOnly,
        version: holder === 'master' && role === 'follower' ? version : null,
      };
    },
    [actionsFor, reach, role, version]
  );

  // --- changing the list ----------------------------------------------------------

  const mutate = useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await work();
        setError(null);
      } finally {
        await load();
      }
    },
    [load]
  );

  const value = useMemo<DevicesContextValue>(
    () => ({
      // A server that did not answer is offline, whether the list failed or is shown as it last said it.
      homeReach: unreachable || away ? 'offline' : loading ? 'connecting' : 'online',
      live,
      devices,
      removed,
      loading,
      error,
      version,
      refresh: load,
      actionsFor,
      screenProps,
      rename: (id, name) => mutate(() => api.devices.update(savedDeviceId(id), { name })),
      setKey: (id, key) => mutate(() => api.devices.update(savedDeviceId(id), { key })),
      setExportable: (device, connection, exportable) => mutate(() => api.connections.setExportable(device.id, connection.id as ConnectionId, exportable)),
      setPicture: (id, picture) => mutate(() => api.devices.setPicture(savedDeviceId(id), picture)),
      remove: (id) => mutate(() => api.devices.remove(savedDeviceId(id))),
      deleteHistory: (id, name) => mutate(() => api.devices.deleteHistory(savedDeviceId(id), name)),
      prefer: (device, connection) => mutate(() => api.connections.prefer(device.id, connection.id as ConnectionId)),
      removeConnection: (device, connection) => mutate(() => api.connections.remove(device.id, connection.id as ConnectionId)),
      addLink: (link) => mutate(() => api.links.add(link)),
      removeLink: (link) => mutate(() => api.links.remove(link.id as LinkId)),
      heard,
      onAutomation,
      views,
    }),
    [actionsFor, api, away, devices, error, heard, live, load, loading, mutate, onAutomation, removed, screenProps, unreachable, version, views]
  );

  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

export function useDevices(): DevicesContextValue {
  const context = useContext(DevicesContext);
  if (!context) throw new Error('useDevices must be used inside <DevicesProvider>');
  return context;
}

/** One device by id, from the list already being kept. */
export function useDevice(id: string | undefined): DeviceView | null {
  const { devices, removed } = useDevices();
  return useMemo(() => (id ? (devices.find((device) => device.id === id) ?? removed.find((device) => device.id === id) ?? null) : null), [devices, id, removed]);
}

