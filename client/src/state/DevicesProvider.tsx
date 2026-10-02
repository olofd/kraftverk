import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSegments } from 'expo-router';

import { ApiError } from '@kraftverk/api-contract';
import {
  describeError,
  type CommandInput,
  type ConnectionView,
  type DeviceActions,
  type DeviceScreenProps,
  type DeviceView,
  type PictureRef,
  type GatewayResult,
  type LinkView,
  type LiveState,
  type LiveStream,
  type LiveUpdate,
  type NewLink,
  type SavedDeviceId,
  type VersionInfo,
} from '@kraftverk/api-client';
import { CATEGORIES, savedDeviceId, SIMULATED_METHOD_ID, type ConnectionId, type LinkId } from '@kraftverk/device-sdk';

import { ASKED_AGAIN, confirmAction, withConfirmation, type ConfirmTone } from '../lib/confirm';
import { HERE } from '../platform/here';
import { useAuth } from './AuthProvider';
import { useHome } from './HomeProvider';
import { applyLive } from './live';
import { useServers, type Mode } from './ServersProvider';
import { createViews, type Views } from './views';

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
/** The longest a write is held for its dwell: a person's is two seconds. */
const MAX_SETTLE_MS = 10_000;

/**
 * A write, answered once the setting may be written again: the gateway
 * refuses a second write to it within its dwell, so the control that wrote it
 * stays busy that long rather than let the next nudge be refused.
 */
async function settled<R extends { settlingMs?: number }>(result: R): Promise<R> {
  if (result.settlingMs) await new Promise((resolve) => setTimeout(resolve, Math.min(result.settlingMs!, MAX_SETTLE_MS)));
  return result;
}

/** How reachable the thing holding the list is. */
export type Connection = 'connecting' | 'online' | 'offline' | 'idle';

type DevicesContextValue = {
  /** Where the home is: a server, or this app (`local`). */
  mode: Mode;
  connection: Connection;
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
  /** Who holds the connection in use: the app's own business, never a device screen's. */
  holderOf: (device: DeviceView) => InUseBy;
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
  setSecrets: (device: DeviceView, connection: ConnectionView, secrets: Record<string, string>) => Promise<void>;
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

/** Who holds a device's connection in use: the home, this app for a server, another app, or nobody right now. */
export type InUseBy = 'home' | 'this-app' | 'other-app' | 'none';

const DevicesContext = createContext<DevicesContextValue | null>(null);

export function DevicesProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const { allowed } = useAuth();
  const { api, kind, writesAllowed, away } = useHome();
  const mode = servers.mode;
  // A server's list is read once signed in; the app's own, always.
  const reading = kind === 'own' || allowed;

  const [served, setServed] = useState<DeviceView[]>([]);
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
      setServed([]);
      setRemoved([]);
      setLoading(false);
      return;
    }
    try {
      const [next, gone] = await Promise.all([api.devices.list(), api.devices.removed().catch(() => [])]);
      setServed(next);
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
    if (kind === 'server' && reading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setServed((devices) => applyLive(devices, batch));
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
      setLoading((was) => was || served.length === 0);
      void load().then(start);
    } else start();
    // Back in front, the stream opens again and its hello reads the list; this only picks up its clock again.
    const subscription = AppState.addEventListener('change', (next) => (next === 'active' ? start() : stop()));
    return () => {
      done = true;
      stop();
      subscription.remove();
    };
    // `served`: only whether there is anything yet, for the first spinner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, load, reading]);

  // --- one list: the home says, of a device this app holds, what this app hears ------

  const devices = served;

  // --- what a device's screens can do -------------------------------------------

  const holderOf = useCallback(
    (device: DeviceView): InUseBy => {
      const inUse = device.connections.find((connection) => connection.inUse);
      if (inUse?.heldBy.kind === 'this-app') return 'this-app';
      if (inUse?.heldBy.kind === 'client') return 'other-app';
      if (device.connections.some((connection) => connection.heldBy.kind === 'home')) return 'home';
      return 'none';
    },
    []
  );

  /**
   * Sends a command or a settings write, and when the gateway only wants a
   * person to confirm, asks them — as dangerous when what it touches is
   * declared so, as careful otherwise.
   */
  const confirmed = useCallback(
    async <R extends { outcome: GatewayResult['outcome']; detail: string; needsConfirmation?: string }>(send: (confirmation?: string) => Promise<R>, tone: ConfirmTone = 'careful'): Promise<R> => {
      // The token a refusal hands out: good for this intent, from this person, once, for a minute.
      const { answer, declined } = await withConfirmation(
        send,
        (result) => (result.needsConfirmation ? { token: result.needsConfirmation, reason: result.detail.replace(/^This (action )?needs explicit confirmation\. /, '') } : null),
        (reason, again) => confirmAction('Confirm', again ? `${ASKED_AGAIN}\n\n${reason}` : reason, 'Do it', tone)
      );
      return declined ? { ...answer, detail: 'Not confirmed', needsConfirmation: undefined } : answer;
    },
    []
  );

  const actionsFor = useCallback(
    (device: DeviceView): DeviceActions => {
      const holder = holderOf(device);
      /** A write is dangerous when it touches a setting its device declares so: one that can harm the hardware. */
      const toneOf = (patch: Record<string, unknown>): ConfirmTone =>
        device.description.attributes.some((attribute) => attribute.dangerous && attribute.key in patch) ? 'dangerous' : 'careful';
      // The home sends each to whoever holds the device: the server, or this app's own gateway and session.
      if (holder === 'home' || holder === 'this-app') {
        const inUse = device.connections.find((connection) => connection.inUse) ?? device.connections.find((connection) => connection.heldBy.kind === 'home');
        return {
          // The home asks, for a tool that cannot be undone: its question, with a token for the yes.
          tool: async <T,>(name: string, input?: Record<string, unknown>) => {
            const spec = device.tools.find((tool) => tool.name === name);
            const label = spec?.label ?? name;
            const run = async (confirmation?: string): Promise<{ answer: T } | { needsConfirmation: string; reason: string }> => {
              try {
                return { answer: (await api.devices.tool(device.id, name, { input: input as never, reading: !spec?.writes, ...(confirmation ? { confirmation } : {}) })) as T };
              } catch (error) {
                if (error instanceof ApiError && error.kind === 'needs-yes' && error.needsConfirmation) return { needsConfirmation: error.needsConfirmation, reason: error.message };
                throw error;
              }
            };
            const { answer, declined } = await withConfirmation(
              run,
              (result) => ('needsConfirmation' in result ? { token: result.needsConfirmation, reason: result.reason } : null),
              (reason, again) => confirmAction(`${label}?`, again ? `${ASKED_AGAIN}\n\n${reason}` : reason, label, 'dangerous')
            );
            if (declined || !('answer' in answer)) throw new Error('Not confirmed');
            return answer.answer;
          },
          write: (patch) => confirmed((confirmation) => api.devices.write(device.id, { patch: patch as never, ...(confirmation ? { confirmation } : {}) }), toneOf(patch)).then(settled),
          command: (input) =>
            confirmed((confirmation) =>
              api.devices.command(device.id, input.part, input.capability, input.command, { args: input.args, ...(input.reason ? { reason: input.reason } : {}), ...(confirmation ? { confirmation } : {}) })
            ),
          // A transport's diagnostics are the home's: this app's own have none to show.
          diagnostic: inUse && holder === 'home'
            ? <T,>(name: string, query?: Record<string, string | number>) =>
                api.transports.diagnostic(inUse.transport, name, Object.fromEntries(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]))) as Promise<T>
            : null,
        };
      }
      const why = async (): Promise<never> => {
        throw new Error(device.health.detail);
      };
      return {
        tool: why,
        write: async () => ({ outcome: 'refused', detail: device.health.detail }),
        command: async () => ({ outcome: 'refused', detail: device.health.detail }),
        diagnostic: null,
      };
    },
    [api, confirmed, holderOf]
  );

  const screenProps = useCallback(
    (device: DeviceView): DeviceScreenProps => {
      const holder = holderOf(device);
      const inUse = device.connections.find((connection) => connection.inUse) ?? null;
      const byHome = kind === 'server' ? 'through the server' : `from ${HERE}`;
      const via = inUse ? `${inUse.methodLabel}, ${inUse.heldBy.kind === 'home' ? byHome : holder === 'this-app' ? 'from this app' : `from ${inUse.heldBy.name}`}` : null;
      return {
        device,
        actions: actionsFor(device),
        // Whether it can be reached, and what to say while it cannot — never by whom.
        reach: {
          now: holder === 'home' || holder === 'this-app',
          waiting: holder === 'this-app' ? 'Connecting from this app…' : holder === 'home' ? (kind === 'server' ? 'Waiting for the server…' : `Connecting from ${HERE}…`) : device.health.detail,
          via,
        },
        // A simulated device has no hardware to protect, and the gateway writes to it whatever the mode.
        readOnly:
          inUse?.method === SIMULATED_METHOD_ID
            ? false
            : holder === 'this-app' || kind === 'own'
              ? !writesAllowed
              : (version?.readOnly ?? false),
        version: holder === 'home' && kind === 'server' ? version : null,
      };
    },
    [actionsFor, holderOf, kind, version, writesAllowed]
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
      mode,
      // A server that did not answer is offline, whether the list failed or is shown as it last said it.
      connection: unreachable || away ? 'offline' : loading ? 'connecting' : 'online',
      live,
      devices,
      removed,
      loading,
      error,
      version,
      refresh: load,
      holderOf,
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
      setSecrets: async (device, connection, secrets) => {
        // A way another app holds keeps its secrets in that app (§4.3); this app's own, the home keeps here.
        if (connection.heldBy.kind === 'client') throw new Error(`Its secrets are kept by ${connection.heldBy.name}: change them there`);
        await mutate(() => api.connections.setSecrets(device.id, connection.id as ConnectionId, secrets));
      },
      addLink: (link) => mutate(() => api.links.add(link)),
      removeLink: (link) => mutate(() => api.links.remove(link.id as LinkId)),
      heard,
      onAutomation,
      views,
    }),
    [actionsFor, api, away, devices, error, heard, holderOf, live, load, loading, mode, mutate, onAutomation, removed, screenProps, unreachable, version, views]
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

/** The categories a device can be listed under. */
export const categoryOf = (id: string) => (CATEGORIES as Record<string, (typeof CATEGORIES)[keyof typeof CATEGORIES]>)[id] ?? null;
