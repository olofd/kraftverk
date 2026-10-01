import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSegments } from 'expo-router';
import axios from 'axios';

import {
  addLink as apiAddLink,
  deleteDeviceHistory,
  describeError,
  fetchDeviceHistory,
  fetchDeviceList,
  fetchRemovedDevices,
  fetchTransportDiagnostic,
  fetchDeviceEvents,
  fetchPolicy,
  fetchProblems,
  fetchVersion,
  openLive,
  preferConnection,
  removeConnection as apiRemoveConnection,
  removeDevice,
  removeLink as apiRemoveLink,
  renameDevice,
  setDeviceKey,
  setSecretsExportable,
  setDevicePicture,
  runDeviceTool,
  sendCommand,
  setConnectionSecrets,
  writeDeviceAttributes,
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
import { CATEGORIES, clientId, connectionId, deviceCapabilities, linkId, MAIN_PART, methodOf, partsOf, savedDeviceId, SIMULATED_METHOD_ID, type DeviceType } from '@kraftverk/device-sdk';
import { runTool, toHold, toolsOf, withInUse } from '@kraftverk/holder';

import { ASKED_AGAIN, confirmAction, withConfirmation, type ConfirmTone } from '../lib/confirm';
import type { LocalDevice } from '../runtime/local';
import { AppRuntime } from '../runtime/runtime';
import type { HeldDevice } from '../runtime/sessions';
import { useAuth } from './AuthProvider';
import { applyLive } from './live';
import { useServers, type Mode } from './ServersProvider';
import { createViews, type Views } from './views';

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

/**
 * The list is read when the live stream opens, and kept current by it after
 * that (`GET /api/live`). Only while the stream is down is it read every few
 * seconds, as it always was; while it is up, rarely, in case anything was missed.
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
  mode: Mode;
  runtime: AppRuntime;
  connection: Connection;
  /** Whether the server's live stream is up: when it is not, the list is polled. */
  live: LiveState;
  devices: DeviceView[];
  /** Removed devices, with their history: server mode only. */
  removed: DeviceView[];
  loading: boolean;
  error: string | null;
  /** The server, when there is one. */
  version: VersionInfo | null;
  refresh: () => Promise<void>;
  /** Who holds the connection a device is using right now. */
  /** Who holds the connection in use: the app's own business, never a device screen's. */
  holderOf: (device: DeviceView) => Holder;
  /** What a device's screens can do, through whoever holds it. */
  actionsFor: (device: DeviceView) => DeviceActions;
  /** Everything a device's own screens are handed. */
  screenProps: (device: DeviceView) => DeviceScreenProps;
  rename: (id: string, name: string) => Promise<void>;
  /** Its name in configuration (docs/CONFIG.md): server mode only. */
  setKey: (id: string, key: string) => Promise<void>;
  /** Whether a server-held connection's secrets may leave in an export as plain text: server mode only. */
  setExportable: (device: DeviceView, connection: ConnectionView, exportable: boolean) => Promise<void>;
  /** Shows another picture (`type:N`): kept by the server, or this app in local mode. */
  setPicture: (id: string, picture: PictureRef) => Promise<void>;
  remove: (id: string) => Promise<void>;
  deleteHistory: (id: string, name: string) => Promise<void>;
  prefer: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  removeConnection: (device: DeviceView, connection: ConnectionView) => Promise<void>;
  setSecrets: (device: DeviceView, connection: ConnectionView, secrets: Record<string, string>) => Promise<void>;
  addLink: (link: NewLink) => Promise<void>;
  removeLink: (link: LinkView) => Promise<void>;
  history: typeof fetchDeviceHistory | null;
  /** What a device said happened, and every device's warnings and errors: server mode only. */
  events: typeof fetchDeviceEvents | null;
  problems: typeof fetchProblems | null;
  /** The last event the live stream carried, counted, so a list of events knows to read again. */
  heard: { deviceId: string; count: number } | null;
  /**
   * Hears, from the live stream, that an automation moved — a run started,
   * took a step or ended — for as long as a screen showing it is open. Returns
   * how to stop hearing.
   */
  onAutomation: (listener: (id: string) => void) => () => void;
  /** What the screen shows, told to the server (`useShowing`, `views.ts`). */
  views: Views;
};

/** Who holds a device's connection in use: the server, this app, another app, or nobody right now. */
export type Holder = 'server' | 'this-app' | 'other-app' | 'none';

const DevicesContext = createContext<DevicesContextValue | null>(null);

/** A device in local mode, described the way the server describes one. */
function describeLocal(runtime: AppRuntime, device: LocalDevice, local: Map<string, LocalDevice>): DeviceView {
  const type: DeviceType<any> | undefined = runtime.registry.types.get(device.typeId);
  const held = runtime.sessions.held(device.id);
  const session = runtime.sessions.get(device.id);
  // What it is: its open session's word, or its type's for its config.
  const description = runtime.sessions.description(device.id) ?? type?.describe(device.config as never) ?? { attributes: [] };
  const connections = runtime.local.connections(device.id).map(
    (connection): ConnectionView => ({
      id: connectionId(connection.id),
      method: connection.method,
      methodLabel: (type ? methodOf(type, connection.method)?.label : null) ?? connection.method,
      transport: connection.transport,
      heldBy: { kind: 'client', id: clientId('this-app'), name: 'This app' },
      address: connection.address,
      priority: connection.priority,
      reachable: held?.connection.id === connection.id ? runtime.sessions.health(device.id)?.status === 'connected' : null,
      inUse: held?.connection.id === connection.id,
      lastConnectedAt: connection.lastConnectedAt,
      secrets: Object.keys(runtime.local.secrets(connection.id)),
      // A phone's own: never in a server's export.
      secretsExportable: false,
      config: connection.config,
    })
  );
  const links = runtime.local.links(device.id).map((link): LinkView => {
    const role = link.source.device === device.id ? 'source' : 'target';
    const [mine, other] = role === 'source' ? [link.source, link.target] : [link.target, link.source];
    const otherDevice = local.get(other.device);
    const otherType = otherDevice ? runtime.registry.types.get(otherDevice.typeId) : undefined;
    const otherDescription = otherDevice ? (runtime.sessions.description(otherDevice.id) ?? otherType?.describe(otherDevice.config as never)) : undefined;
    const partLabel = other.part === MAIN_PART ? '' : ((otherDescription ? partsOf(otherDescription).find((part) => part.id === other.part)?.label : undefined) ?? other.part);
    return {
      id: linkId(link.id),
      kind: link.kind,
      role,
      part: mine.part,
      other: { id: savedDeviceId(other.device), name: otherDevice?.name ?? 'A removed device', part: other.part, partLabel },
    };
  });
  return {
    id: savedDeviceId(device.id),
    // Held by this phone alone, it is in no configuration: known by its id.
    key: device.id,
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
    descriptionSource: runtime.sessions.describedBy(device.id) ?? 'type',
    capabilities: deviceCapabilities(description),
    info: runtime.sessions.info(device.id),
    config: device.config,
    connections,
    links,
    tools: toolsOf(type?.tools, session ?? null).map(({ name, spec }) => ({ name, ...spec })),
    readings: session?.readings() ?? [],
    health: runtime.sessions.health(device.id) ?? {
      status: connections.length ? 'connecting' : 'unconfigured',
      detail: connections.length ? 'Connecting from this app…' : 'Nothing can reach this device yet: add a way to reach it',
      owner: 'client',
      transport: null,
      lastReadingAt: null,
    },
    picture: device.picture ?? 'type:0',
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
  /** Who hears that an automation moved: the screens showing one, while they are open. */
  const automationListeners = useRef(new Set<(id: string) => void>());
  const onAutomation = useCallback((listener: (id: string) => void) => {
    automationListeners.current.add(listener);
    return () => void automationListeners.current.delete(listener);
  }, []);
  // Opening at first: the stream reads the list when it opens, and says so if it cannot.
  const [live, setLive] = useState<LiveState>('connecting');
  const [heard, setHeard] = useState<{ deviceId: string; count: number } | null>(null);
  const polling = mode === 'server' && allowed;

  /*
    What the screen shows, said to the server over the live stream: the
    screen by its route, and the things its parts show (`useShowing`). The
    server judges what follows — a device looked at is read more often.
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

  // Any change in what this app holds is something a card shows.
  useEffect(() => runtime.subscribe(() => setTick((n) => n + 1)), [runtime]);
  useEffect(() => runtime.local.subscribe(() => setTick((n) => n + 1)), [runtime]);

  // Who this app is, to the server it is signed in to.
  useEffect(() => {
    if (!polling) return;
    void runtime.register().catch(() => undefined);
    void fetchVersion().then(setVersion).catch(() => undefined);
    // How much is a load, as the home has set it: the gateway here uses the server's word for devices this app holds.
    void fetchPolicy()
      .then((values) => runtime.setPolicyValues(Object.fromEntries(values.map((value) => [value.name, value.value]))))
      .catch(() => undefined);
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

  // The live stream: while it is up, what changed arrives as it changes, and the list is not polled.
  useEffect(() => {
    if (!polling) return;
    let pending: LiveUpdate[] = [];
    let applying: ReturnType<typeof setTimeout> | null = null;
    let reading: ReturnType<typeof setTimeout> | null = null;

    const apply = () => {
      applying = null;
      const batch = pending;
      pending = [];
      setServed((devices) => applyLive(devices, batch));
    };
    // Read the list again, once for a burst of "changed".
    const readAgain = () => {
      reading ??= setTimeout(() => {
        reading = null;
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
      // Each time it opens, it says what the screen shows: the server keeps that only while it is open.
      stream.current ??= openLive({ onUpdate, onState: setLive, view: () => views.current() });
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
      if (reading) clearTimeout(reading);
    };
  }, [load, polling, views]);

  /*
    The list read without the stream: every few seconds while it is down, and
    now and then while it is up, in case a change was missed. While it is
    opening, nothing — its hello reads the list, and a stream that fails says
    so and is down. Reading here as well was the list read twice, or three
    times, every time the app opened. Signed out, the list is emptied.
  */
  useEffect(() => {
    if (!polling) {
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
  }, [live, load, polling]);

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
      const local = new Map((localDevices ?? []).map((device) => [device.id, device]));
      return (localDevices ?? []).map((device) => describeLocal(runtime, device, local));
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
        tools: session ? toolsOf(runtime.registry.types.get(device.typeId)?.tools, session).map(({ name, spec }) => ({ name, ...spec })) : device.tools,
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
    (device: DeviceView): Holder => {
      if (runtime.sessions.get(device.id)) return 'this-app';
      const inUse = device.connections.find((connection) => connection.inUse);
      if (inUse?.heldBy.kind === 'client') return inUse.heldBy.id === runtime.clientId ? 'this-app' : 'other-app';
      if (mode === 'server' && device.connections.some((connection) => connection.heldBy.kind === 'server')) return 'server';
      return 'none';
    },
    [mode, runtime]
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

  /** A tool this app runs itself that says what it cannot undo is asked about first, as the server does for its own; no, and it does not run. */
  const confirmedTool = useCallback(async (spec: { label: string; confirm?: string } | undefined) => {
    if (!spec?.confirm) return;
    // A tool asks only when it declares what it cannot undo.
    if (!(await confirmAction(`${spec.label}?`, spec.confirm, spec.label, 'dangerous'))) throw new Error('Not confirmed');
  }, []);

  const actionsFor = useCallback(
    (device: DeviceView): DeviceActions => {
      const holder = holderOf(device);
      /** A write is dangerous when it touches a setting its device declares so: one that can harm the hardware. */
      const toneOf = (patch: Record<string, unknown>): ConfirmTone =>
        device.description.attributes.some((attribute) => attribute.dangerous && attribute.key in patch) ? 'dangerous' : 'careful';
      if (holder === 'this-app') {
        const session = () => {
          const open = runtime.sessions.get(device.id);
          if (!open) throw new Error(runtime.sessions.health(device.id)?.detail ?? 'This app is not connected to it yet');
          return open;
        };
        return {
          // The holder's own check, as on the server: the input the tool asks for, the answer it declares.
          tool: async <T,>(name: string, input: Record<string, unknown> = {}) => {
            const spec = runtime.registry.types.get(device.typeId)?.tools?.[name];
            await confirmedTool(spec);
            try {
              const answer = await runTool({ deviceName: device.name, name, spec, session: session(), input, readOnly: !runtime.allowWrites });
              if (spec?.writes) runtime.uplink?.audit({ at: new Date().toISOString(), kind: 'device.tool', resourceKind: 'device', resource: device.id, summary: `Ran ${spec.label.toLowerCase()} on "${device.name}"`, detail: { tool: name, input } });
              // Checked against its declaration above: T is that declaration's shape.
              return answer as T;
            } catch (error) {
              if (spec?.writes) runtime.uplink?.audit({ at: new Date().toISOString(), kind: 'device.tool-refused', resourceKind: 'device', resource: device.id, summary: `${spec.label} on "${device.name}" was refused: ${(error as Error).message}`, detail: { tool: name, input } });
              throw error;
            }
          },
          // The gateway's write, here as on the server: types, confirmation, read-back, audit.
          write: (patch) =>
            confirmed(
              (confirmation) =>
                runtime.gateway.write({
                  deviceId: device.id as SavedDeviceId,
                  patch,
                  actor: 'user',
                  by: runtime.clientId ? `app:${runtime.clientId}` : 'this app',
                  confirmation,
                }),
              toneOf(patch)
            ).then(settled),
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
          // The server asks, for a tool that cannot be undone: its question, with a token for the yes.
          tool: async <T,>(name: string, input?: Record<string, unknown>) => {
            const spec = device.tools.find((tool) => tool.name === name);
            const label = spec?.label ?? name;
            const { answer, declined } = await withConfirmation(
              (confirmation) => runDeviceTool<T>(device.id, name, { input, writes: spec?.writes ?? false, confirmation }),
              (result) => ('needsConfirmation' in result ? { token: result.needsConfirmation, reason: result.reason } : null),
              (reason, again) => confirmAction(`${label}?`, again ? `${ASKED_AGAIN}\n\n${reason}` : reason, label, 'dangerous')
            );
            if (declined || !('answer' in answer)) throw new Error('Not confirmed');
            return answer.answer;
          },
          write: (patch) => confirmed((confirmation) => writeDeviceAttributes(device.id, { patch, confirmation }), toneOf(patch)).then(settled),
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
    [confirmed, confirmedTool, holderOf, runtime]
  );

  const screenProps = useCallback(
    (device: DeviceView): DeviceScreenProps => {
      const holder = holderOf(device);
      const inUse = device.connections.find((connection) => connection.inUse) ?? null;
      const via = inUse
        ? `${inUse.methodLabel}, ${inUse.heldBy.kind === 'server' ? 'through the server' : holder === 'this-app' ? 'from this app' : `from ${inUse.heldBy.name}`}`
        : null;
      return {
        device,
        actions: actionsFor(device),
        // Whether it can be reached, and what to say while it cannot — never by whom.
        reach: {
          now: holder === 'server' || holder === 'this-app',
          waiting: holder === 'this-app' ? 'Connecting from this app…' : holder === 'server' ? 'Waiting for the server…' : device.health.detail,
          via,
        },
        // A simulated device has no hardware to protect, and the gateway writes to it whatever the mode.
        readOnly: inUse?.method === SIMULATED_METHOD_ID ? false : holder === 'this-app' ? !runtime.allowWrites : (version?.readOnly ?? false),
        version: holder === 'server' ? version : null,
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
      live: mode === 'local' ? 'down' : live,
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
      setKey: (id, key) => (mode === 'local' ? Promise.reject(new Error('Configuration is the server’s')) : mutate(() => setDeviceKey(id, key))),
      setExportable: (device, connection, exportable) => (mode === 'local' ? Promise.reject(new Error('Configuration is the server’s')) : mutate(() => setSecretsExportable(device.id, connection.id, exportable))),
      setPicture: (id, picture) => (mode === 'local' ? Promise.resolve(runtime.local.setPicture(id, picture)) : mutate(() => setDevicePicture(id, picture))),
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
      addLink: async (link) => {
        if (mode === 'local') runtime.local.addLink(link.kind, link.source, link.target);
        else await mutate(() => apiAddLink(link));
      },
      removeLink: async (link) => {
        if (mode === 'local') runtime.local.removeLink(link.id);
        else await mutate(() => apiRemoveLink(link.id));
      },
      history: mode === 'server' ? fetchDeviceHistory : null,
      events: mode === 'server' ? fetchDeviceEvents : null,
      problems: mode === 'server' ? fetchProblems : null,
      heard,
      onAutomation,
      views,
    }),
    [actionsFor, devices, error, heard, holderOf, live, load, loading, mode, mutate, onAutomation, removed, runtime, screenProps, unreachable, version, views]
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
