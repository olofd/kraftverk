import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ServerApi } from '@kraftverk/api-contract';
import { serverApi } from '@kraftverk/api-client/http';

import { SERVER_BESIDE_THIS_APP } from '../platform/server-address';

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
} from '../platform/servers';

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
  /** The active server's own calls — signing in, accounts, its log — or null in local mode. */
  server: ServerApi | null;
  /** Hears when the active server asks to sign in: a session that ended while the app was open. Returns how to stop. */
  onLoginRequired: (listener: () => void) => () => void;
};

const ServersContext = createContext<Servers | null>(null);

export function ServersProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<SavedServer[]>(readServers);
  const [active, setActive] = useState<SavedServer | null>(readActiveServer);
  const [deciding, setDeciding] = useState(() => !serversConfigured());

  const use = useCallback((id: string | null) => {
    markServersConfigured();
    const chosen = id ? (readServers().find((server) => server.id === id) ?? null) : null;
    writeActiveServerId(chosen?.id ?? null);
    setActive(chosen);
  }, []);

  // Who hears that the server wants a sign-in: whoever holds the session (AuthProvider).
  const loginListeners = useRef(new Set<() => void>());
  const onLoginRequired = useCallback((listener: () => void) => {
    loginListeners.current.add(listener);
    return () => void loginListeners.current.delete(listener);
  }, []);
  const server = useMemo(
    () => (active ? serverApi({ baseUrl: active.url, onLoginRequired: () => loginListeners.current.forEach((listener) => listener()) }) : null),
    [active]
  );

  /*
    The first run looks for a server beside the app — the web container serves
    both — rather than assuming one. Found: it is added and used. Not found:
    local mode, and a server is something to add later.
  */
  useEffect(() => {
    if (!deciding) return;
    let live = true;
    void (async () => {
      const found = await serverApi({ baseUrl: SERVER_BESIDE_THIS_APP }).probe();
      if (!live) return;
      if (found) {
        const saved = storeAddServer({ url: SERVER_BESIDE_THIS_APP });
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
        if (next && next.id === active?.id) setActive(next);
      },
      remove: (id) => {
        const wasActive = active?.id === id;
        storeRemoveServer(id);
        setAll(readServers());
        if (wasActive) use(null);
      },
      use,
      test: (url) => serverApi({ baseUrl: url }).probe(),
      server,
      onLoginRequired,
    }),
    [active, all, deciding, onLoginRequired, server, use]
  );

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}

/** The active server's own calls, for a screen that only shows with one: accounts, its log, its reset. */
export function useServer(): ServerApi {
  const { server } = useServers();
  if (!server) throw new Error('useServer is for a screen shown only with a server');
  return server;
}

export function useServers(): Servers {
  const context = useContext(ServersContext);
  if (!context) throw new Error('useServers must be used inside <ServersProvider>');
  return context;
}
