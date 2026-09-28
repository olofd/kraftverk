import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_API_BASE_URL, probeServer, setApiBaseUrl } from '@kraftverk/api-client';

import {
  addServer as storeAddServer,
  markServersConfigured,
  readActiveServer,
  readServers,
  removeServer as storeRemoveServer,
  serversConfigured,
  updateServer as storeUpdateServer,
  writeActiveServerId,
  type SavedServer,
} from '../lib/servers';

/**
 * Which kraftverk server this app uses — or none, which is local mode
 * (docs/DATA-MODEL.md §6).
 *
 * Server configuration belongs to the app rather than to any server. A server
 * is something you add, so having one selected is what puts the app in server
 * mode; forgetting the active one returns it to local mode, where the app keeps
 * its own devices and holds every connection itself.
 */

/** `server`: a server holds the devices. `local`: this app does. */
export type Mode = 'server' | 'local';

export type Servers = {
  mode: Mode;
  all: SavedServer[];
  active: SavedServer | null;
  /** True while the first-run probe is deciding; the UI waits rather than lies. */
  deciding: boolean;
  add: (input: { name?: string; url: string }) => Promise<SavedServer>;
  update: (id: string, changes: { name?: string; url?: string }) => void;
  remove: (id: string) => void;
  /** `null` means local mode. */
  use: (id: string | null) => void;
  test: (url: string) => Promise<boolean>;
};

const ServersContext = createContext<Servers | null>(null);

/*
  Point the HTTP client at the selected server on import, before any screen has
  had a chance to call it. Doing this in a render or an effect would let the
  first request go to the build-time default instead.
*/
const selectedAtStartup = readActiveServer();
if (selectedAtStartup) setApiBaseUrl(selectedAtStartup.url);

export function ServersProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<SavedServer[]>(readServers);
  const [active, setActive] = useState<SavedServer | null>(readActiveServer);
  const [deciding, setDeciding] = useState(() => !serversConfigured());

  const use = useCallback((id: string | null) => {
    markServersConfigured();
    const chosen = id ? (readServers().find((server) => server.id === id) ?? null) : null;
    writeActiveServerId(chosen?.id ?? null);
    setActive(chosen);
    if (chosen) setApiBaseUrl(chosen.url);
  }, []);

  /*
    The first run looks for a server beside the app — the web container serves
    both — rather than assuming one. Found: it is added and used. Not found:
    local mode, and a server is something to add later.
  */
  useEffect(() => {
    if (!deciding) return;
    let live = true;
    void (async () => {
      const found = await probeServer(DEFAULT_API_BASE_URL);
      if (!live) return;
      if (found) {
        const saved = storeAddServer({ url: DEFAULT_API_BASE_URL });
        setAll(readServers());
        use(saved.id);
      } else {
        markServersConfigured();
      }
      setDeciding(false);
    })();
    return () => {
      live = false;
    };
  }, [deciding, use]);

  const value = useMemo<Servers>(
    () => ({
      mode: active ? 'server' : 'local',
      all,
      active,
      deciding,
      add: async (input) => {
        const saved = storeAddServer(input);
        setAll(readServers());
        if (!active) use(saved.id);
        return saved;
      },
      update: (id, changes) => {
        const next = storeUpdateServer(id, changes);
        setAll(readServers());
        if (next && next.id === active?.id) {
          setActive(next);
          setApiBaseUrl(next.url);
        }
      },
      remove: (id) => {
        const wasActive = active?.id === id;
        storeRemoveServer(id);
        setAll(readServers());
        if (wasActive) use(null);
      },
      use,
      test: (url) => probeServer(url),
    }),
    [active, all, deciding, use]
  );

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

export function useServers(): Servers {
  const context = useContext(ServersContext);
  if (!context) throw new Error('useServers must be used inside <ServersProvider>');
  return context;
}
