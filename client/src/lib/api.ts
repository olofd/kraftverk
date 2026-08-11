import Constants from 'expo-constants';
import { Platform } from 'react-native';
import axios from 'axios';

import type {
  DeviceList,
  LinkDiagnostics,
  PortId,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
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
  if (explicit) return explicit.replace(/\/$/, '');

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

export const API_BASE_URL = resolveApiBaseUrl();

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 6000,
  headers: { Accept: 'application/json' },
});

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

export async function fetchDevices(signal?: AbortSignal) {
  const { data } = await api.get<DeviceList>('/devices', { signal });
  return data;
}

export async function bindDevice(id: string, signal?: AbortSignal) {
  const { data } = await api.post<{ boundId: string | null; connected: boolean }>(
    '/devices/bind',
    { id },
    { signal }
  );
  return data;
}

export async function unbindDevice(signal?: AbortSignal) {
  const { data } = await api.post<{ boundId: null; connected: false }>(
    '/devices/unbind',
    {},
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

export type RegisterRow = {
  register: number;
  name: string | null;
  raw: number;
  hex: string;
  asTenths: number;
  previous: number | null;
  /** Differs from the snapshot baseline. */
  changed: boolean;
};

export type RegisterDump = {
  mac: string | null;
  readOnly: boolean;
  baselineAt: string | null;
  input: RegisterRow[];
  holding: RegisterRow[];
};

export async function fetchRegisters(signal?: AbortSignal) {
  const { data } = await api.get<RegisterDump>('/diagnostics/registers', { signal });
  return data;
}

/** Captures a baseline so the next dump can show what moved. */
export async function snapshotRegisters(signal?: AbortSignal) {
  const { data } = await api.post<{ at: string }>('/diagnostics/snapshot', {}, { signal });
  return data;
}

/** Turns an axios/network failure into something worth showing a user. */
export function describeError(error: unknown): string {
  if (axios.isCancel(error)) return '';
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `Server responded ${error.response.status}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `Timed out reaching ${API_BASE_URL}`;
    }
    return `Can't reach ${API_BASE_URL}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
