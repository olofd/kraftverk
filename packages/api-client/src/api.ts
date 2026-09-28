import Constants from 'expo-constants';
import { Platform } from 'react-native';
import axios from 'axios';

import type { ConfigValues, Reading, SetupActionResult } from '@kraftverk/device-sdk';
import type { GatewayResult } from '@kraftverk/gateway';

import type {
  Account,
  AccountDetail,
  AuditEntry,
  AuthState,
  CheckOutcome,
  ClientRecord,
  DeviceHistory,
  DeviceSettings,
  DeviceTypeList,
  DeviceView,
  DraftView,
  FoundView,
  HeldSetupInput,
  LinkRecord,
  SaveInput,
  ServerLogLine,
  SightingView,
  TransportList,
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

export async function fetchVersion(signal?: AbortSignal) {
  const { data } = await api.get<VersionInfo>('/version', { signal });
  return data;
}

// --- devices ------------------------------------------------------------------
//
// One list of the things you have, each described the same way, whatever it
// is and however it is reached. Nothing here names a device type.

/** Catalog ids may carry a `:` from before they were opaque, so they are always escaped. */
const devicePath = (id: string, suffix = '') => `/devices/${encodeURIComponent(id)}${suffix}`;

export async function fetchDeviceList(signal?: AbortSignal) {
  const { data } = await api.get<{ devices: DeviceView[] }>('/devices', { signal });
  return data.devices;
}

/** Removed devices, kept with their history: to bring back by adding again, or to delete. */
export async function fetchRemovedDevices(signal?: AbortSignal) {
  const { data } = await api.get<{ devices: DeviceView[] }>('/devices/removed', { signal });
  return data.devices;
}

export async function fetchDevice(id: string, signal?: AbortSignal) {
  const { data } = await api.get<DeviceView>(devicePath(id), { signal });
  return data;
}

/** What can be added: every installed type, by category, with whether this server can hold each method. */
export async function fetchDeviceTypes(signal?: AbortSignal) {
  const { data } = await api.get<DeviceTypeList>('/device-types', { signal });
  return data;
}

export async function renameDevice(id: string, name: string, signal?: AbortSignal) {
  const { data } = await api.patch<DeviceView>(devicePath(id), { name }, { signal });
  return data;
}

/** Removes a device, keeping its history: adding it again offers to bring it back. */
export async function removeDevice(id: string, signal?: AbortSignal) {
  await api.delete(devicePath(id), { signal });
}

/** Deletes a removed device and everything it recorded. Its name, typed back, is the confirmation. */
export async function deleteDeviceHistory(id: string, name: string, signal?: AbortSignal) {
  const { data } = await api.post<{ ok: true; samples: number }>(devicePath(id, '/delete-history'), { name }, { signal });
  return data;
}

export async function fetchDeviceSettings(id: string, signal?: AbortSignal) {
  const { data } = await api.get<DeviceSettings>(devicePath(id, '/settings'), { signal });
  return data;
}

/**
 * Writes a device's own settings. Only the changed keys are sent, and the
 * reply is a readback rather than an echo: writing one setting can move another.
 */
export async function patchDeviceSettings(id: string, patch: ConfigValues, signal?: AbortSignal) {
  const { data } = await api.patch<{ values: ConfigValues }>(devicePath(id, '/settings'), patch, { signal, timeout: 20_000 });
  return data.values;
}

/** One measurement over a window, already thinned to something a chart can draw. */
export async function fetchDeviceHistory(id: string, key: string, options: { hours?: number; points?: number } = {}, signal?: AbortSignal) {
  const { data } = await api.get<DeviceHistory>(devicePath(id, '/history'), {
    params: { key, hours: options.hours ?? 24, points: options.points ?? 240 },
    signal,
  });
  return data;
}

/**
 * A capability command, through the server's action gateway.
 *
 * A refusal is an answer, not an error: the gateway's verdict comes back
 * either way, and `needsConfirmation` says when a person only has to confirm.
 */
export async function sendCommand(
  id: string,
  command: { capability: string; command?: string; target?: string; value: boolean; confirmation?: string; reason?: string }
): Promise<GatewayResult> {
  const { capability, command: name = 'set', ...rest } = command;
  const response = await api.post<GatewayResult>(devicePath(id, `/capabilities/${encodeURIComponent(capability)}/${encodeURIComponent(name)}`), rest, {
    // Verification waits for the device, and the station a plug feeds, to agree.
    timeout: 45_000,
    validateStatus: (status) => status === 200 || status === 409,
  });
  return response.data;
}

/**
 * One of a device type's own tools: a register dump, a raw frame. Reads are a
 * GET, anything that writes a POST — the server refuses and audits accordingly.
 */
export async function runDeviceTool<T = unknown>(id: string, name: string, options: { input?: Record<string, unknown>; writes?: boolean } = {}, signal?: AbortSignal): Promise<T> {
  const path = devicePath(id, `/advanced/${encodeURIComponent(name)}`);
  if (options.writes) {
    const { data } = await api.post<T>(path, options.input ?? {}, { signal, timeout: 30_000 });
    return data;
  }
  const { data } = await api.get<T>(path, { params: options.input, signal, timeout: 30_000 });
  return data;
}

// --- connections and links ------------------------------------------------------

export async function preferConnection(deviceId: string, connectionId: string) {
  const { data } = await api.post<DeviceView>(devicePath(deviceId, `/connections/${connectionId}/prefer`), {});
  return data;
}

/** Removes one way to reach a device. Not the last one: that is removing the device. */
export async function removeConnection(deviceId: string, connectionId: string) {
  const { data } = await api.delete<DeviceView>(devicePath(deviceId, `/connections/${connectionId}`));
  return data;
}

/** Replaces a server-held connection's secrets — a plug's new local key. Write-only. */
export async function setConnectionSecrets(deviceId: string, connectionId: string, secrets: Record<string, string>) {
  const { data } = await api.put<DeviceView>(devicePath(deviceId, `/connections/${connectionId}/secrets`), secrets);
  return data;
}

/** Records a fact about the house: this plug feeds that station. */
export async function addLink(kind: string, sourceId: string, targetId: string) {
  const { data } = await api.post<LinkRecord>('/links', { kind, sourceId, targetId });
  return data;
}

export async function removeLink(id: string) {
  await api.delete(`/links/${encodeURIComponent(id)}`);
}

// --- adding a device, held by the server ----------------------------------------

export async function startSetup(typeId: string, methodId: string) {
  const { data } = await api.post<DraftView>('/setup', { typeId, methodId });
  return data;
}

export async function fetchSetup(id: string, signal?: AbortSignal) {
  const { data } = await api.get<DraftView>(`/setup/${id}`, { signal });
  return data;
}

export async function discardSetup(id: string) {
  await api.delete(`/setup/${id}`).catch(() => undefined);
}

export async function fetchSightings(id: string, signal?: AbortSignal) {
  const { data } = await api.get<{ sightings: SightingView[] }>(`/setup/${id}/sightings`, { signal });
  return data.sightings;
}

/** The physical device: one the transport saw, or an address typed by hand. */
export async function chooseInSetup(id: string, choice: { address: string } | { manual: string }) {
  const { data } = await api.post<DraftView>(`/setup/${id}/choose`, choice);
  return data;
}

/** Values from a form step. Secrets stay on the server; placeholders it handed out stand for them. */
export async function updateSetup(id: string, values: { device?: ConfigValues; connection?: ConfigValues }) {
  const { data } = await api.patch<DraftView>(`/setup/${id}`, values);
  return data;
}

/** A step's helper, run on the server: "Fetch it with my Tuya account". Slow by nature. */
export async function runSetupAction(id: string, stepId: string, actionId: string, input: ConfigValues = {}) {
  const { data } = await api.post<SetupActionResult>(`/setup/${id}/steps/${stepId}/actions/${actionId}`, { input }, { timeout: 95_000 });
  return data;
}

export async function runSetupDiscover(id: string, stepId: string) {
  const { data } = await api.post<SetupActionResult>(`/setup/${id}/steps/${stepId}/discover`, {}, { timeout: 95_000 });
  return data;
}

/** Reads the device once, and says what it is against the devices you have. */
export async function checkSetup(id: string) {
  const { data } = await api.post<CheckOutcome>(`/setup/${id}/check`, {}, { timeout: 30_000 });
  return data;
}

export async function saveSetup(id: string, input: SaveInput) {
  const { data } = await api.post<DeviceView>(`/setup/${id}/save`, input, { timeout: 30_000 });
  return data;
}

/** A connection this app will hold: what it learnt reading the device itself, never a secret. */
export async function startHeldSetup(input: HeldSetupInput) {
  const { data } = await api.post<DraftView>('/setup/app', input);
  return data;
}

// --- what this app sends for connections it holds -------------------------------

/** Says who this app is and what it can reach devices over. Every start. */
export async function registerClient(input: { id?: string; name: string; platform: 'web' | 'native'; transports: string[] }) {
  const { data } = await api.post<ClientRecord>('/clients', input);
  return data;
}

export async function fetchClients(signal?: AbortSignal) {
  const { data } = await api.get<{ clients: ClientRecord[] }>('/clients', { signal });
  return data.clients;
}

/** Forgets a phone or browser, and every connection it held. */
export async function forgetClient(id: string) {
  await api.delete(`/clients/${encodeURIComponent(id)}`);
}

export async function uploadReadings(deviceId: string, input: { clientId: string; connectionId: string; identity?: string | null; readings: readonly Reading[] }) {
  const { data } = await api.post<{ live: number; history: number; refused: number }>(devicePath(deviceId, '/readings'), input);
  return data;
}

export async function fetchDeviceStore(deviceId: string, signal?: AbortSignal) {
  const { data } = await api.get<{ values: Record<string, unknown> }>(devicePath(deviceId, '/store'), { signal });
  return data.values;
}

export async function putDeviceStore(deviceId: string, key: string, input: { clientId: string; connectionId: string; value: unknown }) {
  await api.put(devicePath(deviceId, `/store/${encodeURIComponent(key)}`), input);
}

export async function uploadAudit(clientId: string, entries: readonly Omit<AuditEntry, 'actor' | 'id'>[]) {
  const { data } = await api.post<{ recorded: number }>(`/clients/${encodeURIComponent(clientId)}/audit`, { entries });
  return data;
}

// --- transports and the server ------------------------------------------------

export async function fetchTransports(signal?: AbortSignal) {
  const { data } = await api.get<TransportList>('/transports', { signal });
  return data;
}

/** "Found near you": what the server's transports see that nothing you have is reached by. */
export async function fetchFound(signal?: AbortSignal) {
  const { data } = await api.get<{ found: FoundView[] }>('/found', { signal });
  return data.found;
}

/** One of a transport's read-only diagnostics: the broker's journal, its traffic. */
export async function fetchTransportDiagnostic<T = unknown>(transport: string, name: string, query: Record<string, string | number> = {}, signal?: AbortSignal) {
  const { data } = await api.get<T>(`/transports/${encodeURIComponent(transport)}/diagnostics/${encodeURIComponent(name)}`, { params: query, signal });
  return data;
}

/** What the server has said lately, and where its full log files are. */
export async function fetchServerLog(options: { limit?: number; level?: ServerLogLine['level'] } = {}, signal?: AbortSignal) {
  const { data } = await api.get<{ dir: string | null; lines: ServerLogLine[] }>('/diagnostics/log', { params: options, signal });
  return data;
}

export async function fetchAudit(limit = 100, signal?: AbortSignal) {
  const { data } = await api.get<AuditEntry[]>('/audit', { params: { limit }, signal });
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
 * Empties the database: devices, their connections and secrets, links, history
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

/*
  Managing accounts needs your own password as well as your session: a
  borrowed session must not be able to add an account it keeps, or set a
  password it knows.
*/

export async function addAccount(username: string, password: string, yourPassword: string) {
  const { data } = await api.post<{ user: AccountDetail }>('/users', { username, password, yourPassword });
  return data.user;
}

export async function removeAccount(id: string, yourPassword: string) {
  await api.delete(`/users/${encodeURIComponent(id)}`, { data: { yourPassword } });
}

/** Someone else's password. Signs them out everywhere. */
export async function resetAccountPassword(id: string, password: string, yourPassword: string) {
  await api.post(`/users/${encodeURIComponent(id)}/password`, { password, yourPassword });
}
