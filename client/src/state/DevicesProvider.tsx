import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import axios from 'axios';

import {
  addLink as apiAddLink,
  CONFIRMATION_TOKEN,
  deleteDeviceHistory,
  describeError,
  fetchDeviceHistory,
  fetchDeviceList,
  fetchRemovedDevices,
  fetchTransportDiagnostic,
  fetchVersion,
  preferConnection,
  removeConnection as apiRemoveConnection,
  removeDevice,
  removeLink as apiRemoveLink,
  renameDevice,
  runDeviceTool,
  sendCommand,
  setConnectionSecrets,
  writeDeviceAttributes,
  type CommandInput,
  type ConnectionView,
  type DeviceActions,
  type DeviceScreenProps,
  type DeviceView,
  type GatewayResult,
  type LinkView,
  type SavedDeviceId,
  type VersionInfo,
} from '@kraftverk/api-client';
import { CATEGORIES, deviceCapabilities, savedDeviceId, type DeviceType } from '@kraftverk/device-sdk';
import { toHold, withInUse } from '@kraftverk/holder';

import { confirmAction } from '../lib/confirm';
import type { LocalDevice } from '../runtime/local';
import { AppRuntime } from '../runtime/runtime';
import type { HeldDevice } from '../runtime/sessions';
import { useAuth } from './AuthProvider';
import { useServers, type Mode } from './ServersProvider';

/**
 * The things you have, whoever holds them.
 *
 * In server mode the list is the server's, and the connections this app holds
 * run here — their readings replace what the server last heard, because this
 * app has them first. In local mode the list is this app's own. Either way a
 * device is one `DeviceView`, and its screens get actions that reach whoever
 * holds its connection in use: the server over HTTP, or this app's own session.
 * No screen asks which.
 */

/** Readings move slower than a device's own screens poll; the list is for cards. */
const POLL_MS = 5000;

/** How reachable the thing holding the list is. */
export type Connection = 'connecting' | 'online' | 'offline' | 'idle';

type DevicesContextValue = {
  mode: Mode;
  runtime: AppRuntime;
  connection: Connection;
  devices: DeviceView[];
  /** Removed devices, with their history: server mode only. */
  removed: DeviceView[];
  loading: boolean;
  error: string | null;
  /** The server, when there is one. */
  version: VersionInfo | null;
  refresh: () => Promise<void>;
  /** Who holds the connection a device is using right now. */
  holderOf: (device: DeviceView) => DeviceScreenProps['holder'];
  /** What a device's screens can do, through whoever holds it. */
  actionsFor: (device: DeviceView) => DeviceActions;
  /** Everything a device's own screens are handed. */
  screenProps: (device: DeviceView) => DeviceScreenProps;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  deleteHistory: (id: string, name: string) => Promise<void>;
  prefer: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  removeConnection: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  setSecrets: (device: DeviceView, connection: ConnectionView, secrets: Record<string, string>) => Promise<void>;
  addLink: (kind: string, sourceId: string, targetId: string) => Promise<void>;
  removeLink: (link: LinkView) => Promise<void>;
  history: typeof fetchDeviceHistory | null;
};

const DevicesContext = createContext<DevicesContextValue | null>(null);

/** A device in local mode, described the way the server describes one. */
function describeLocal(runtime: AppRuntime, device: LocalDevice, names: Map<string, string>): DeviceView {
  const type: DeviceType<any> | undefined = runtime.registry.types.get(device.typeId);
  const held = runtime.sessions.held(device.id);
  const session = runtime.sessions.get(device.id);
  // What it is: its open session's word, or its type's for its config.
  const description = runtime.sessions.description(device.id) ?? type?.describe(device.config as never) ?? { attributes: [] };
  const connections = runtime.local.connections(device.id).map(
    (connection): ConnectionView => ({
      id: connection.id,
      method: connection.method,
      methodLabel: type?.connections.find((method) => method.id === connection.method)?.label ?? connection.method,
      transport: connection.transport,
      heldBy: { kind: 'client', id: 'this-app', name: 'This app' },
      address: connection.address,
      priority: connection.priority,
      reachable: held?.connection.id === connection.id ? runtime.sessions.health(device.id)?.status === 'connected' : null,
      inUse: held?.connection.id === connection.id,
      lastConnectedAt: connection.lastConnectedAt,
      secrets: Object.keys(runtime.local.secrets(connection.id)),
      config: connection.config,
    })
  );
  const links = runtime.local.links(device.id).map((link): LinkView => {
    const role = link.sourceId === device.id ? 'source' : 'target';
    const other = role === 'source' ? link.targetId : link.sourceId;
    return { id: link.id, kind: link.kind, role, other: { id: savedDeviceId(other), name: names.get(other) ?? 'A removed device' } };
  });
  return {
    id: savedDeviceId(device.id),
    typeId: device.typeId,
    installed: Boolean(type),
    name: device.name,
    identity: device.identity,
    addedAt: device.addedAt,
    removedAt: null,
    kind: type?.kind ?? 'hardware',
    meta: type
      ? { name: type.meta.name, brand: type.meta.brand, icon: type.meta.icon, support: type.meta.support, category: type.meta.category }
      : { name: device.typeId, icon: 'help-circle', support: 'experimental', category: 'unknown' },
    description,
    capabilities: deviceCapabilities(description),
    info: runtime.sessions.info(device.id),
    config: device.config,
    connections,
    links,
    advanced: Object.entries(session?.advanced ?? {}).map(([name, action]) => ({ name, writes: action.writes })),
    readings: session?.readings() ?? [],
    health: runtime.sessions.health(device.id) ?? {
      status: connections.length ? 'connecting' : 'unconfigured',
      detail: connections.length ? 'Connecting from this app…' : 'Nothing can reach this device yet: add a way to reach it',
      owner: 'client',
      transport: null,
      lastReadingAt: null,
    },
  };
}

export function DevicesProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const { allowed } = useAuth();
  const mode = servers.mode;
  const server = servers.active?.url ?? null;

  // One runtime per server, or for local mode: switching closes everything the last one held.
  const [runtime, setRuntime] = useState(() => new AppRuntime({ mode, server }));
  const runtimeFor = useRef(`${mode} ${server}`);
  useEffect(() => {
    const key = `${mode} ${server}`;
    if (runtimeFor.current === key) return;
    runtimeFor.current = key;
    setRuntime(new AppRuntime({ mode, server }));
  }, [mode, server]);
  useEffect(() => () => void runtime.stop(), [runtime]);

  const [served, setServed] = useState<DeviceView[]>([]);
  const [removed, setRemoved] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [tick, setTick] = useState(0);
  const polling = mode === 'server' && allowed;

  // Any change in what this app holds is something a card shows.
  useEffect(() => runtime.subscribe(() => setTick((n) => n + 1)), [runtime]);
  useEffect(() => runtime.local.subscribe(() => setTick((n) => n + 1)), [runtime]);

  // Who this app is, to the server it is signed in to.
  useEffect(() => {
    if (!polling) return;
    void runtime.register().catch(() => undefined);
    void fetchVersion().then(setVersion).catch(() => undefined);
  }, [polling, runtime]);

  const load = useCallback(async () => {
    if (!polling) {
      setServed([]);
      setRemoved([]);
      setLoading(false);
      return;
    }
    try {
      const [next, gone] = await Promise.all([fetchDeviceList(), fetchRemovedDevices().catch(() => [])]);
      setServed(next);
      setRemoved(gone);
      setUnreachable(false);
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (!message) return;
      if (axios.isAxiosError(err) && err.response?.status === 401) return;
      setUnreachable(true);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [polling]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (polling) timer ??= setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    setLoading(true);
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
  }, [load, polling]);

  // --- what this app holds ----------------------------------------------------

  const localDevices = mode === 'local' ? runtime.local.devices() : null;
  const heldList = useMemo((): HeldDevice[] => {
    if (mode === 'local') {
      return (localDevices ?? []).flatMap((device): HeldDevice[] => {
        // Highest in the list, unless it has been down long enough to try the next (§4).
        const all = runtime.local.connections(device.id);
        const connection = all.find((candidate) => !runtime.avoided(candidate.id)) ?? all[0];
        if (!connection) return [];
        return [
          {
            deviceId: savedDeviceId(device.id),
            name: device.name,
            typeId: device.typeId,
            identity: device.identity,
            config: device.config,
            connection: { id: connection.id, method: connection.method, transport: connection.transport, address: connection.address, config: connection.config },
            secrets: runtime.local.secrets(connection.id),
            store: runtime.storeFor(device.id, connection.id),
          },
        ];
      });
    }
    return served.flatMap((device): HeldDevice[] => {
      const connection = toHold(device, runtime.clientId);
      if (!connection) return [];
      return [
        {
          deviceId: device.id,
          name: device.name,
          typeId: device.typeId,
          identity: device.identity,
          config: device.config,
          connection: { id: connection.id, method: connection.method, transport: connection.transport, address: connection.address, config: connection.config },
          // Secrets of a connection this app holds live here, never on the server.
          secrets: runtime.heldSecrets(connection.id),
          store: runtime.storeFor(device.id, connection.id),
        },
      ];
    });
    // `tick`: the local catalog and the client id change underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDevices, mode, runtime, served, tick]);

  const heldKey = JSON.stringify(heldList.map((held) => [held.deviceId, held.connection.id, held.config, held.connection.config]));
  const heldRef = useRef(heldList);
  heldRef.current = heldList;
  useEffect(() => {
    void (async () => {
      for (const held of heldRef.current) if (!runtime.sessions.get(held.deviceId)) await runtime.refreshStore(held.deviceId);
      await runtime.hold(heldRef.current);
    })();
  }, [heldKey, runtime]);

  // --- one list -----------------------------------------------------------------

  const devices = useMemo((): DeviceView[] => {
    if (mode === 'local') {
      const names = new Map((localDevices ?? []).map((device) => [device.id, device.name]));
      return (localDevices ?? []).map((device) => describeLocal(runtime, device, names));
    }
    // What this app holds, it knows first: its readings and health replace the server's.
    return served.map((device) => {
      const session = runtime.sessions.get(device.id);
      const health = runtime.sessions.health(device.id);
      const held = runtime.sessions.held(device.id);
      // Which secrets a connection this app holds has: the server never knows.
      const mine = (connection: ConnectionView) => connection.heldBy.kind === 'client' && connection.heldBy.id === runtime.clientId;
      const connections = device.connections.map((connection) =>
        mine(connection) ? { ...connection, secrets: Object.keys(runtime.heldSecrets(connection.id)) } : connection
      );
      if (!session && !health) return { ...device, connections };
      return {
        ...device,
        readings: session?.readings() ?? device.readings,
        health: health ?? device.health,
        advanced: session ? Object.entries(session.advanced ?? {}).map(([name, action]) => ({ name, writes: action.writes })) : device.advanced,
        connections: withInUse(
          // What this app holds, it knows first: whether its own connection reaches the device.
          connections.map((connection) => (held && connection.id === held.connection.id ? { ...connection, reachable: health?.status === 'connected' } : connection)),
          held?.connection.id ?? null
        ),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDevices, mode, runtime, served, tick]);

  useEffect(() => runtime.setView(devices), [devices, runtime]);

  // --- what a device's screens can do -------------------------------------------

  const holderOf = useCallback(
    (device: DeviceView): DeviceScreenProps['holder'] => {
      if (runtime.sessions.get(device.id)) return 'this-app';
      const inUse = device.connections.find((connection) => connection.inUse);
      if (inUse?.heldBy.kind === 'client') return inUse.heldBy.id === runtime.clientId ? 'this-app' : 'other-app';
      if (mode === 'server' && device.connections.some((connection) => connection.heldBy.kind === 'server')) return 'server';
      return 'none';
    },
    [mode, runtime]
  );

  /** Sends a command or a settings write, and when the gateway only wants a person to confirm, asks them. */
  const confirmed = useCallback(
    async <R extends { outcome: GatewayResult['outcome']; detail: string; needsConfirmation?: true }>(send: (confirmation?: string) => Promise<R>): Promise<R> => {
      const first = await send();
      if (!first.needsConfirmation) return first;
      const yes = await confirmAction('Confirm', first.detail.replace(/^This (action )?needs explicit confirmation\. /, ''), 'Do it');
      if (!yes) return { ...first, detail: 'Not confirmed', needsConfirmation: undefined };
      return send(CONFIRMATION_TOKEN);
    },
    []
  );

  const actionsFor = useCallback(
    (device: DeviceView): DeviceActions => {
      const holder = holderOf(device);
      if (holder === 'this-app') {
        const session = () => {
          const open = runtime.sessions.get(device.id);
          if (!open) throw new Error(runtime.sessions.health(device.id)?.detail ?? 'This app is not connected to it yet');
          return open;
        };
        return {
          tool: async <T,>(name: string, input: Record<string, unknown> = {}) => {
            const action = session().advanced?.[name];
            if (!action) throw new Error(`${device.name} has no tool called "${name}"`);
            if (action.writes && !action.honoursReadOnly && !runtime.allowWrites) throw new Error('Writes from this app are off: allow them in App settings');
            const result = (await action.run(input)) as T;
            if (action.writes) runtime.uplink?.audit({ at: new Date().toISOString(), kind: 'device.advanced', resource: device.id, summary: `Ran ${name} on "${device.name}"`, detail: { input } });
            return result;
          },
          // The gateway's write, here as on the server: types, confirmation, read-back, audit.
          write: (patch) =>
            confirmed((confirmation) =>
              runtime.gateway.write({
                deviceId: device.id as SavedDeviceId,
                patch,
                actor: 'user',
                by: runtime.clientId ? `app:${runtime.clientId}` : 'this app',
                confirmation,
              })
            ),
          command: (input: CommandInput) =>
            confirmed((confirmation) =>
              runtime.gateway.execute({
                deviceId: device.id as SavedDeviceId,
                part: input.part,
                capability: input.capability as never,
                command: input.command,
                args: input.args,
                reason: input.reason ?? 'From this app',
                actor: 'user',
                by: runtime.clientId ? `app:${runtime.clientId}` : 'this app',
                confirmation,
              })
            ),
          diagnostic: null,
        };
      }
      if (holder === 'server') {
        const inUse = device.connections.find((connection) => connection.inUse) ?? device.connections.find((connection) => connection.heldBy.kind === 'server');
        return {
          tool: <T,>(name: string, input?: Record<string, unknown>) =>
            runDeviceTool<T>(device.id, name, { input, writes: device.advanced.find((tool) => tool.name === name)?.writes ?? false }),
          write: (patch) => confirmed((confirmation) => writeDeviceAttributes(device.id, { patch, confirmation })),
          command: (input) => confirmed((confirmation) => sendCommand(device.id, { ...input, confirmation })),
          diagnostic: inUse ? <T,>(name: string, query?: Record<string, string | number>) => fetchTransportDiagnostic<T>(inUse.transport, name, query) : null,
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
    [confirmed, holderOf, runtime]
  );

  const screenProps = useCallback(
    (device: DeviceView): DeviceScreenProps => {
      const holder = holderOf(device);
      return {
        device,
        actions: actionsFor(device),
        holder,
        readOnly: holder === 'this-app' ? !runtime.allowWrites : (version?.readOnly ?? false),
        version,
      };
    },
    [actionsFor, holderOf, runtime, version]
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
      runtime,
      connection: mode === 'local' ? 'online' : unreachable ? 'offline' : loading ? 'connecting' : 'online',
      devices,
      removed,
      loading: mode === 'server' ? loading : false,
      error,
      version,
      refresh: load,
      holderOf,
      actionsFor,
      screenProps,
      rename: (id, name) => (mode === 'local' ? Promise.resolve(runtime.local.rename(id, name)) : mutate(() => renameDevice(id, name))),
      remove: async (id) => {
        await runtime.sessions.close(id);
        if (mode === 'local') runtime.local.remove(id);
        else await mutate(() => removeDevice(id));
      },
      deleteHistory: (id, name) => mutate(() => deleteDeviceHistory(id, name)),
      prefer: async (device, connection) => {
        if (mode === 'local') runtime.local.prefer(connection.id);
        else await mutate(() => preferConnection(device.id, connection.id));
      },
      removeConnection: async (device, connection) => {
        if (mode === 'local') {
          if (runtime.local.connections(device.id).length <= 1) throw new Error('This is the only way to reach it. Remove the device instead.');
          runtime.local.removeConnection(connection.id);
        } else await mutate(() => apiRemoveConnection(device.id, connection.id));
      },
      setSecrets: async (device, connection, secrets) => {
        // A connection an app holds keeps its secrets in that app: they are never sent (§4.3).
        if (mode === 'local' || (connection.heldBy.kind === 'client' && connection.heldBy.id === runtime.clientId)) {
          runtime.setHeldSecrets(connection.id, secrets);
          return;
        }
        if (connection.heldBy.kind === 'client') throw new Error(`Its secrets are kept by ${connection.heldBy.name}: change them there`);
        await mutate(() => setConnectionSecrets(device.id, connection.id, secrets));
      },
      addLink: async (kind, sourceId, targetId) => {
        if (mode === 'local') runtime.local.addLink(kind, sourceId, targetId);
        else await mutate(() => apiAddLink(kind, sourceId, targetId));
      },
      removeLink: async (link) => {
        if (mode === 'local') runtime.local.removeLink(link.id);
        else await mutate(() => apiRemoveLink(link.id));
      },
      history: mode === 'server' ? fetchDeviceHistory : null,
    }),
    [actionsFor, devices, error, holderOf, load, loading, mode, mutate, removed, runtime, screenProps, unreachable, version]
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
