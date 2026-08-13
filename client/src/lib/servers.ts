import { DEFAULT_API_BASE_URL } from '@kraftverk/api-client';

import { readPreference, writePreference, clearPreference } from './preferences';

/**
 * The kraftverk servers this app knows about.
 *
 * The app is a browser app first: it can hold a station's Bluetooth link itself
 * and needs no server at all. A server is therefore something you *add* — an
 * address you type in — and not an assumption baked into the build. One
 * artefact, pointed at whichever machine you self-host on, or at none.
 *
 * Stored client-side, because this is the app's own configuration rather than
 * anything a server owns. It has to survive a reload, so it lives in
 * `localStorage` where there is one, and in memory where there is not.
 *
 * Full CRUD on purpose: people run more than one — a Raspberry Pi at home and a
 * laptop while developing — and an address you cannot edit or delete is an
 * address you have to clear the site data to be rid of.
 */

const LIST_KEY = 'kraftverk.servers';
const ACTIVE_KEY = 'kraftverk.servers.active';

export type SavedServer = {
  id: string;
  /** Yours. Defaults to the host, because that is what distinguishes them. */
  name: string;
  /** Fully qualified, including `/api`. Stored without a trailing slash. */
  url: string;
  addedAt: string;
};

/** Enough entropy for a local list; these never leave the browser. */
const newId = (): string => `srv_${Math.random().toString(36).slice(2, 10)}`;

export const normaliseUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * Turns what someone typed into an address that can actually be called.
 *
 * People type `192.168.1.5`, or `http://pi.local:3333`, and mean the API on it.
 * Requiring the scheme and the `/api` suffix would be a quiz rather than a
 * setup step, so both are filled in when they are missing.
 */
export function completeUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;

  url = normaliseUrl(url);
  if (!/\/api$/i.test(url)) {
    // A bare host means the default port too, since that is where a kraftverk
    // server listens unless its owner moved it.
    const hasPort = /^https?:\/\/[^/]+:\d+/i.test(url);
    const port = new URL(DEFAULT_API_BASE_URL).port;
    if (!hasPort && port) url = `${url}:${port}`;
    url = `${url}/api`;
  }
  return url;
}

/** A readable default name: the host, which is what tells two servers apart. */
export function suggestName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Kraftverk server';
  }
}

export function readServers(): SavedServer[] {
  const raw = readPreference(LIST_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const value = entry as Partial<SavedServer>;
      if (typeof value.id !== 'string' || typeof value.url !== 'string') return [];
      return [
        {
          id: value.id,
          url: normaliseUrl(value.url),
          name: typeof value.name === 'string' && value.name ? value.name : suggestName(value.url),
          addedAt: typeof value.addedAt === 'string' ? value.addedAt : new Date().toISOString(),
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeServers(servers: SavedServer[]): void {
  writePreference(LIST_KEY, JSON.stringify(servers));
}

export function addServer(input: { name?: string; url: string }): SavedServer {
  const url = completeUrl(input.url);
  const existing = readServers().find((server) => server.url === url);
  if (existing) return existing;

  const server: SavedServer = {
    id: newId(),
    url,
    name: input.name?.trim() || suggestName(url),
    addedAt: new Date().toISOString(),
  };
  writeServers([...readServers(), server]);
  return server;
}

export function updateServer(
  id: string,
  changes: { name?: string; url?: string }
): SavedServer | null {
  const servers = readServers();
  const found = servers.find((server) => server.id === id);
  if (!found) return null;

  const next: SavedServer = {
    ...found,
    name: changes.name?.trim() || found.name,
    url: changes.url ? completeUrl(changes.url) : found.url,
  };
  writeServers(servers.map((server) => (server.id === id ? next : server)));
  return next;
}

/** Forgets a server. If it was the one in use, the app falls back to local. */
export function removeServer(id: string): void {
  writeServers(readServers().filter((server) => server.id !== id));
  if (readActiveServerId() === id) writeActiveServerId(null);
}

export function readActiveServerId(): string | null {
  return readPreference(ACTIVE_KEY);
}

export function writeActiveServerId(id: string | null): void {
  if (id) writePreference(ACTIVE_KEY, id);
  else clearPreference(ACTIVE_KEY);
}

export function readActiveServer(): SavedServer | null {
  const id = readActiveServerId();
  if (!id) return null;
  return readServers().find((server) => server.id === id) ?? null;
}

/**
 * Whether the app has ever been told what to do about servers.
 *
 * Distinguishes "this user has chosen local mode" from "this is the first run",
 * which is the difference between leaving someone in local mode and adopting
 * the server that is obviously running beside them.
 */
export function serversConfigured(): boolean {
  return readPreference(LIST_KEY) !== null;
}

/** Records that the question has been answered, even when the answer is none. */
export function markServersConfigured(): void {
  if (!serversConfigured()) writeServers(readServers());
}
