import Constants from 'expo-constants';
import { Platform } from 'react-native';
import axios from 'axios';

// The dump the server returns is built by the shared package, so its shape is
// declared there rather than described a second time here.
import { ACTUATOR_CONFIRMATION, type CapabilityName, type ConfigValues, type SetupActionResult } from '@kraftverk/plugin-sdk';
import type { RegisterDump } from '@kraftverk/protocol';

import type {
  Account,
  AccountDetail,
  AuthState,
  BrokerJournalEntry,
  DeviceHistory,
  DeviceSettings,
  DeviceTypeOption,
  SavedDeviceView,
  GridStatus,
  LegacyStationOffer,
  PluginConfig,
  PluginList,
  RelayCommandResult,
  LinkDiagnostics,
  PortId,
  StationSettings,
  StationDeviceState,
  StationSettingsPatch,
  StationStatus,
  StationTransports,
  TrafficEntry,
  VersionInfo,
} from './types';

export const API_PORT = Number(process.env.EXPO_PUBLIC_API_PORT ?? 3333);

/**
 * Work out where the Hono API lives.
 *
 * Web and the iOS Simulator can both reach `localhost`, but Expo Go on a
 * physical iPhone cannot — there `localhost` is the phone itself. Expo hands us
 * the dev machine's LAN address in `hostUri` (e.g. `192.168.1.42:8081`), so we
 * reuse that host and swap in the API port.
 */
function resolveApiBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;

  /*
    `same-origin`: the app is served by the same host that proxies `/api` to a
    server — the web container. Resolved at runtime rather than baked in, so
    one build works at a LAN address and at a public name alike, and over
    HTTPS without a mixed-content refusal.
  */
  if (explicit === 'same-origin' && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api`;
  }
  if (explicit && explicit !== 'same-origin') return explicit.replace(/\/$/, '');

  if (Platform.OS === 'web') {
    // Served from the same machine that runs Metro, so its hostname is correct
    // whether that's localhost or a LAN IP opened from another device.
    const host =
      typeof window !== 'undefined' && window.location?.hostname
        ? window.location.hostname
        : 'localhost';
    return `http://${host}:${API_PORT}/api`;
  }

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split('/')[0]?.split(':')[0];

  return `http://${host ?? 'localhost'}:${API_PORT}/api`;
}

/**
 * Where a kraftverk server *would* be, if one is running beside this app.
 *
 * A suggestion, not a fact. The app is usable in a browser with no server at
 * all, so this is the address offered when someone chooses to add one — not an
 * assumption that it answers.
 */
export const DEFAULT_API_BASE_URL = resolveApiBaseUrl();

export const api = axios.create({
  baseURL: DEFAULT_API_BASE_URL,
  timeout: 6000,
  /*
    `X-Kraftverk-Client` on every request: the server refuses writes without
    it, because a page on another website cannot add it without asking the
    server first — and the server says no. It is what stops any site you visit
    from switching the relay through your browser.
  */
  headers: { Accept: 'application/json', 'X-Kraftverk-Client': 'app' },
  // The session is an httpOnly cookie; it only travels if asked to.
  withCredentials: true,
});

/**
 * Told when a server answers "log in first" — a session that expired while
 * the app was open, or a server that stopped trusting this network. The app
 * listens once, and shows the login rather than a screen full of errors.
 */
const loginListeners = new Set<(detail: { setupRequired: boolean }) => void>();

export function onLoginRequired(listener: (detail: { setupRequired: boolean }) => void): () => void {
  loginListeners.add(listener);
  return () => loginListeners.delete(listener);
}

api.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401) {
    const data = error.response.data as { loginRequired?: boolean; setupRequired?: boolean } | undefined;
    if (data?.loginRequired) for (const listener of loginListeners) listener({ setupRequired: Boolean(data.setupRequired) });
  }
  return Promise.reject(error);
});

/**
 * Points the client at a server the user chose.
 *
 * The address is a runtime setting rather than a build-time constant, because
 * a browser build is one artefact that different people point at different
 * machines — and because someone with no server should not be stuck with an
 * address that will never answer.
 */
export function setApiBaseUrl(url: string): void {
  api.defaults.baseURL = url.replace(/\/$/, '');
}

export function getApiBaseUrl(): string {
  return api.defaults.baseURL ?? DEFAULT_API_BASE_URL;
}

/** Is a kraftverk server actually there? Used before trusting an address. */
export async function probeServer(url?: string, signal?: AbortSignal): Promise<boolean> {
  const base = (url ?? getApiBaseUrl()).replace(/\/$/, '');
  /*
    `/auth/state`, not `/health`: the health check answers only the server's
    own machine now, and the sign-in state is the one thing a server tells
    anyone. A server from before accounts has no such route, and is still asked
    the old way.
  */
  try {
    const { data } = await axios.get<{ setupRequired?: unknown }>(`${base}/auth/state`, { timeout: 3000, signal, withCredentials: true });
    return typeof data?.setupRequired === 'boolean';
  } catch (error) {
    if (!(axios.isAxiosError(error) && error.response?.status === 404)) return false;
  }
  try {
    const { data } = await axios.get<{ ok: boolean }>(`${base}/health`, { timeout: 3000, signal });
    return data?.ok === true;
  } catch {
    return false;
  }
}

export async function fetchStatus(signal?: AbortSignal) {
  const { data } = await api.get<StationStatus>('/status', { signal });
  return data;
}

export async function fetchVersion(signal?: AbortSignal) {
  const { data } = await api.get<VersionInfo>('/version', { signal });
  return data;
}

export async function fetchSettings(signal?: AbortSignal) {
  const { data } = await api.get<StationSettings>('/settings', { signal });
  return data;
}

export async function patchSettings(patch: StationSettingsPatch, signal?: AbortSignal) {
  const { data } = await api.patch<StationSettings>('/settings', patch, { signal });
  return data;
}

export async function setPort(id: PortId, enabled: boolean, signal?: AbortSignal) {
  const { data } = await api.post<StationStatus>(`/ports/${id}`, { enabled }, { signal });
  return data;
}

export async function setGridConnected(connected: boolean, signal?: AbortSignal) {
  const { data } = await api.post<StationStatus>('/grid', { connected }, { signal });
  return data;
}

// --- the station's link -----------------------------------------------------
//
// Which stations the server's radio can see, and which one it is bound to.
// Deliberately not `/devices`: that name belongs to the catalog of things you
// own, and a peripheral a radio noticed is not yet one of them.

export async function fetchStationTransports(signal?: AbortSignal) {
  const { data } = await api.get<StationTransports>('/station/transports', { signal });
  return data;
}

/**
 * Binds one saved device to one station.
 *
 * Both ids are required. The server used to infer the device when only one was
 * saved, which is the kind of convenience that works until the day it silently
 * picks the wrong machine.
 */
export async function bindStation(deviceId: string, stationId: string, signal?: AbortSignal) {
  const { data } = await api.post<{ deviceId: string; boundId: string | null; connected: boolean }>(
    '/station/bind',
    { deviceId, id: stationId },
    { signal }
  );
  return data;
}

export async function unbindStation(deviceId: string, signal?: AbortSignal) {
  const { data } = await api.post<{ deviceId: string; boundId: null; connected: false }>(
    '/station/unbind',
    { deviceId },
    { signal }
  );
  return data;
}

export async function fetchLinkDiagnostics(signal?: AbortSignal) {
  const { data } = await api.get<LinkDiagnostics>('/diagnostics/link', { signal });
  return data;
}

export async function fetchTraffic(signal?: AbortSignal) {
  const { data } = await api.get<TrafficEntry[]>('/diagnostics/traffic', { signal });
  return data;
}

/**
 * The MQTT broker's journal: connections, subscriptions, writes and every
 * disconnect with its reason. `level: 'debug'` adds each poll and frame.
 */
export async function fetchBrokerJournal(
  options: { after?: number; limit?: number; level?: BrokerJournalEntry['level']; station?: string } = {},
  signal?: AbortSignal
) {
  const { data } = await api.get<{ lastSeq: number; entries: BrokerJournalEntry[] }>('/diagnostics/broker/journal', {
    params: options,
    signal,
  });
  return data;
}

/**
 * A register dump, from one station.
 *
 * `deviceId` is optional only because a server holding exactly one station can
 * still answer without it. With several the server refuses to guess, which is
 * the right answer: a register dump names a machine, and writing to the wrong
 * one is how hardware dies.
 */
export async function fetchRegisters(deviceId?: string, signal?: AbortSignal) {
  const { data } = await api.get<RegisterDump>('/diagnostics/registers', {
    params: deviceId ? { deviceId } : undefined,
    signal,
  });
  return data;
}

/** Captures a baseline so the next dump can show what moved. */
export async function snapshotRegisters(deviceId?: string, signal?: AbortSignal) {
  const { data } = await api.post<{ at: string }>(
    '/diagnostics/snapshot',
    {},
    { params: deviceId ? { deviceId } : undefined, signal }
  );
  return data;
}

// --- extensions -------------------------------------------------------------

export async function fetchPlugins(signal?: AbortSignal) {
  const { data } = await api.get<PluginList>('/plugins', { signal });
  return data;
}

export async function fetchPluginConfig(id: string, signal?: AbortSignal) {
  const { data } = await api.get<PluginConfig>(`/plugins/${id}/config`, { signal });
  return data;
}

export async function patchPluginConfig(id: string, values: ConfigValues) {
  const { data } = await api.patch<{ ok: boolean }>(`/plugins/${id}/config`, values);
  return data;
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  const { data } = await api.post<{ ok: boolean }>(`/plugins/${id}/enable`, { enabled });
  return data;
}

export async function testPlugin(id: string) {
  const { data } = await api.post<{ ok: boolean; detail: string; data?: Record<string, unknown> }>(
    `/plugins/${id}/test`,
    {}
  );
  return data;
}

/** Runs a commissioning helper the plugin declared. Slow by nature — a LAN scan takes seconds. */
export async function runSetupAction(id: string, actionId: string, input: ConfigValues) {
  const { data } = await api.post<SetupActionResult>(`/plugins/${id}/setup/${actionId}`, input, {
    timeout: 95_000,
  });
  return data;
}

export async function setPluginGrant(
  id: string,
  capability: CapabilityName,
  granted: boolean,
  confirmation?: string
) {
  const { data } = await api.post<{ ok: boolean; grants: CapabilityName[] }>(
    `/plugins/${id}/grants`,
    { capability, granted, confirmation }
  );
  return data;
}

export async function setPluginProvider(id: string) {
  const { data } = await api.post<{ ok: boolean }>(`/plugins/${id}/provider`, {});
  return data;
}

export async function fetchGrid(signal?: AbortSignal) {
  const { data } = await api.get<GridStatus>('/grid', { signal });
  return data;
}

/** Asks the core to switch mains. The gateway decides whether it may. */
export async function switchGridRelay(on: boolean, reason: string) {
  const { data } = await api.post<RelayCommandResult>('/grid/relay', {
    on,
    reason,
    confirmation: ACTUATOR_CONFIRMATION,
    // Verification waits for the station to agree, which is deliberately slow.
    }, { timeout: 45_000 });
  return data;
}

// --- devices ----------------------------------------------------------------
//
// One list of the things you own, described identically whether the core
// provides them or a plugin does. Every call here is device-shaped rather than
// station-shaped, which is what lets one screen serve a device nobody has
// written yet.

/** Catalog ids carry a `:` — `power-station:ab12cd34` — so they must be escaped. */
const devicePath = (id: string, suffix = '') => `/devices/${encodeURIComponent(id)}${suffix}`;

export async function fetchDeviceList(signal?: AbortSignal) {
  const { data } = await api.get<{ devices: SavedDeviceView[] }>('/devices', { signal });
  return data.devices;
}

export async function fetchDevice(id: string, signal?: AbortSignal) {
  const { data } = await api.get<SavedDeviceView>(devicePath(id), { signal });
  return data;
}

/** What can be added, and what each one needs. */
export async function fetchDeviceTypes(signal?: AbortSignal) {
  const { data } = await api.get<{ types: DeviceTypeOption[] }>('/device-types', { signal });
  return data.types;
}

export async function addDevice(
  input: {
    type: 'power-station' | 'smart-plug';
    driver: string;
    name: string;
    model?: string | null;
    config?: Record<string, unknown>;
  },
  signal?: AbortSignal
) {
  const { data } = await api.post<SavedDeviceView>('/devices', input, { signal });
  return data;
}

export async function updateDevice(
  id: string,
  changes: { name?: string; model?: string | null; config?: Record<string, unknown> },
  signal?: AbortSignal
) {
  const { data } = await api.patch<SavedDeviceView>(devicePath(id), changes, { signal });
  return data;
}

/** Forgets a device. Its samples go with it — see the server's note on why. */
export async function removeDevice(id: string, signal?: AbortSignal) {
  const { data } = await api.delete<{ ok: boolean }>(devicePath(id), { signal });
  return data;
}

// --- one P280, by device id -------------------------------------------------
//
// The model-specific half of the device surface. A P280 panel calls these with
// the id of the device it is drawing, so it cannot accidentally read or write
// whichever station the server happens to be holding.

export async function fetchStationDevice(id: string, signal?: AbortSignal) {
  const { data } = await api.get<StationDeviceState>(devicePath(id, '/p280/state'), { signal });
  return data;
}

/** Writes the station's own settings. The reply is a readback, not an echo. */
export async function patchStationDevice(
  id: string,
  patch: StationSettingsPatch,
  signal?: AbortSignal
) {
  const { data } = await api.patch<StationSettings>(devicePath(id, '/p280/settings'), patch, {
    signal,
  });
  return data;
}

// --- the legacy station import ---------------------------------------------
//
// The server no longer adopts a station at startup, so a binding made before
// the catalog existed is offered to the user instead of acted on. Three calls:
// what is on offer, take it, or wave it away for good.

export async function fetchStationImport(signal?: AbortSignal) {
  const { data } = await api.get<LegacyStationOffer>('/migration/station', { signal });
  return data;
}

export async function importLegacyStation(name?: string, signal?: AbortSignal) {
  const { data } = await api.post<SavedDeviceView>('/migration/station/import', { name }, { signal });
  return data;
}

export async function dismissStationImport(signal?: AbortSignal) {
  const { data } = await api.post<{ ok: boolean }>('/migration/station/dismiss', {}, { signal });
  return data;
}

export async function fetchDeviceSettings(id: string, signal?: AbortSignal) {
  const { data } = await api.get<DeviceSettings>(devicePath(id, '/settings'), { signal });
  return data;
}

/**
 * Writes a device's own settings.
 *
 * Only the changed keys are sent. The reply is a readback rather than an echo —
 * writing one setting can move another on this hardware — so callers should
 * take the values it returns over the ones they asked for.
 */
export async function patchDeviceSettings(id: string, patch: ConfigValues, signal?: AbortSignal) {
  const { data } = await api.patch<{ values: ConfigValues }>(devicePath(id, '/settings'), patch, {
    signal,
  });
  return data.values;
}

/** One measurement over a window, already thinned to something a chart can draw. */
export async function fetchDeviceHistory(
  id: string,
  key: string,
  options: { hours?: number; points?: number } = {},
  signal?: AbortSignal
) {
  const { data } = await api.get<DeviceHistory>(devicePath(id, '/history'), {
    params: { key, hours: options.hours ?? 24, points: options.points ?? 240 },
    signal,
  });
  return data;
}

/**
 * Invokes a control on a device.
 *
 * What comes back depends on what was switched: the station's own ports answer
 * with its status, while anything that moves mains goes through the action
 * gateway and answers with its verdict.
 */
export async function invokeDeviceControl(
  id: string,
  controlId: string,
  value: boolean | number | string,
  confirmation?: string
) {
  const { data } = await api.post<StationStatus | RelayCommandResult>(
    devicePath(id, `/control/${encodeURIComponent(controlId)}`),
    { value, confirmation },
    // A verified switch waits for the station to agree, which is slow on purpose.
    { timeout: 45_000 }
  );
  return data;
}

/** Turns an axios/network failure into something worth showing a user. */
export function describeError(error: unknown): string {
  if (axios.isCancel(error)) return '';
  if (axios.isAxiosError(error)) {
    if (error.response) {
      // 423 Locked is the server refusing a write in read-only mode. Say so
      // plainly — a bare status code reads like a failure rather than a guard.
      if (error.response.status === 423) {
        return 'Read-only mode: the server refused that write. Restart it without --read-only to make changes.';
      }
      const data = error.response.data as { error?: string } | string | undefined;
      // A sentence from the server, as JSON or — from older servers — plain text.
      const detail = typeof data === 'string' ? data.trim() || undefined : data?.error;
      return detail ?? `Server responded ${error.response.status}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `Timed out reaching ${getApiBaseUrl()}`;
    }
    return `Can't reach ${getApiBaseUrl()}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

// --- resetting everything ---------------------------------------------------

/**
 * Whether this server will accept a reset.
 *
 * Asked before the control is offered, so nobody is shown a button that cannot
 * work. It reveals only that a passphrase exists, never any part of it.
 */
export async function fetchResetAvailability(signal?: AbortSignal) {
  const { data } = await api.get<{ available: boolean; secretFile: string }>('/admin/reset', {
    signal,
  });
  return data;
}

/**
 * Empties the database: devices, history, plugin configuration, secrets, grants
 * and the audit timeline. There is no undo, and no copy kept anywhere.
 */
export async function resetDatabase(secret: string, signal?: AbortSignal) {
  const { data } = await api.post<{ ok: true; tables: string[]; rows: number }>(
    '/admin/reset',
    { secret },
    { signal }
  );
  return data;
}

// --- accounts ---------------------------------------------------------------
//
// The session is an httpOnly cookie the server sets and reads; the app never
// sees it. These calls ask who is signed in, sign in and out, and manage
// accounts — which the server only allows with a real login.

export async function fetchAuthState(signal?: AbortSignal) {
  const { data } = await api.get<AuthState>('/auth/state', { signal });
  return data;
}

/** The first account on a fresh server. Only accepted from the home network. */
export async function setupAdministrator(username: string, password: string) {
  const { data } = await api.post<{ user: Account }>('/auth/setup', { username, password });
  return data.user;
}

export async function logIn(username: string, password: string) {
  const { data } = await api.post<{ user: Account }>('/auth/login', { username, password });
  return data.user;
}

export async function logOut() {
  await api.post('/auth/logout', {});
}

/** Your own password. Needs the current one; signs you out everywhere else. */
export async function changeOwnPassword(current: string, next: string) {
  await api.post('/auth/password', { current, next });
}

export async function fetchAccounts(signal?: AbortSignal) {
  const { data } = await api.get<{ users: AccountDetail[] }>('/users', { signal });
  return data.users;
}

export async function addAccount(username: string, password: string) {
  const { data } = await api.post<{ user: AccountDetail }>('/users', { username, password });
  return data.user;
}

export async function removeAccount(id: string) {
  await api.delete(`/users/${encodeURIComponent(id)}`);
}

/** Someone else's password. Signs them out everywhere. */
export async function resetAccountPassword(id: string, password: string) {
  await api.post(`/users/${encodeURIComponent(id)}/password`, { password });
}
