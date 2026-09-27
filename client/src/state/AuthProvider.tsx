import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import axios from 'axios';

import {
  fetchAuthState,
  logIn as apiLogIn,
  logOut as apiLogOut,
  onLoginRequired,
  setupAdministrator,
} from '@kraftverk/api-client';
import type { AuthState } from '@kraftverk/api-client';

import { useDirectLink } from './DirectLinkProvider';

/**
 * Who this app is to the server it is pointed at.
 *
 * Only meaningful with a server: local mode holds its own Bluetooth links and
 * has nobody to log in to. The session itself is an httpOnly cookie the server
 * sets — the app never touches it, only asks the server what it thinks.
 */
type AuthContextValue = {
  /** A server is chosen, so accounts apply. */
  applies: boolean;
  state: AuthState | null;
  /** The first answer has not arrived yet. */
  loading: boolean;
  /**
   * The server predates accounts, or could not be asked. Either way this is
   * not the place to say so: the connection banner already does, and an old
   * server has no login to show.
   */
  unknown: boolean;
  /** This device may use the app: signed in — or talking to a server from before accounts. */
  allowed: boolean;
  refresh: () => Promise<void>;
  logIn: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { source, servers } = useDirectLink();
  const applies = source === 'server' && Boolean(servers.active);
  const serverUrl = servers.active?.url ?? null;

  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(applies);
  const [unknown, setUnknown] = useState(false);
  // Which server an answer is about: switching servers mid-request must not
  // leave one server's answer describing another.
  const asked = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!applies || !serverUrl) {
      setState(null);
      setLoading(false);
      return;
    }
    asked.current = serverUrl;
    try {
      const next = await fetchAuthState();
      if (asked.current !== serverUrl) return;
      setState(next);
      setUnknown(false);
    } catch (error) {
      if (asked.current !== serverUrl) return;
      // 404: a server from before accounts existed. Anything else: unreachable.
      // Neither is a login problem, and neither should lock the app.
      setState(null);
      setUnknown(true);
      if (!axios.isAxiosError(error)) throw error;
    } finally {
      if (asked.current === serverUrl) setLoading(false);
    }
  }, [applies, serverUrl]);

  useEffect(() => {
    setLoading(applies);
    setState(null);
    void refresh();
  }, [applies, serverUrl, refresh]);

  // A session that expires while the app is open shows up as a 401 somewhere;
  // asking again is what turns that into the login screen.
  useEffect(() => onLoginRequired(() => void refresh()), [refresh]);

  const logIn = useCallback(
    async (username: string, password: string) => {
      await apiLogIn(username, password);
      await refresh();
    },
    [refresh]
  );

  const setup = useCallback(
    async (username: string, password: string) => {
      await setupAdministrator(username, password);
      await refresh();
    },
    [refresh]
  );

  const logOut = useCallback(async () => {
    await apiLogOut().catch(() => undefined);
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      applies,
      state,
      loading,
      unknown,
      allowed: !applies || unknown || Boolean(state?.user),
      refresh,
      logIn,
      setup,
      logOut,
    }),
    [applies, state, loading, unknown, refresh, logIn, setup, logOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
