import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError } from '@kraftverk/api-contract';
import type { AuthState } from '@kraftverk/api-client';

import { useServers } from './ServersProvider';

/**
 * Who this app is to the server it is pointed at.
 *
 * Only meaningful with a server: with none, this app keeps its own home and
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
   * The server could not be asked who you are: out of reach, or not answering
   * as a kraftverk server does. This is not the place to say so — the
   * connection banner does — and meanwhile the app shows what the server
   * last said.
   */
  unreachable: boolean;
  /** This device may use the app: signed in — or its server out of reach, showing what it last said. */
  allowed: boolean;
  /** A sign-in the server accepted and the browser then dropped, explained. */
  notice: string | null;
  /**
   * Moves when the person using the app changes — a sign-out, or a different
   * account signing in — and never when a session merely expires. The app
   * underneath is rebuilt on it, so nothing of one account outlives it.
   */
  generation: number;
  refresh: () => Promise<AuthState | null>;
  logIn: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const applies = Boolean(servers.active);
  const serverUrl = servers.active?.url ?? null;
  const { server, onLoginRequired } = servers;

  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(applies);
  const [unreachable, setUnreachable] = useState(false);
  // Which server an answer is about: switching servers mid-request must not
  // leave one server's answer describing another.
  const asked = useRef<string | null>(null);

  const [generation, setGeneration] = useState(0);
  /** Server and account last signed in, whatever has happened since. */
  const lastSignedIn = useRef<string | null>(null);
  const signedInAs = state?.user && serverUrl ? `${serverUrl} ${state.user.id}` : null;
  useEffect(() => {
    if (!signedInAs) return;
    if (lastSignedIn.current && lastSignedIn.current !== signedInAs) setGeneration((n) => n + 1);
    lastSignedIn.current = signedInAs;
  }, [signedInAs]);

  const refresh = useCallback(async (): Promise<AuthState | null> => {
    if (!applies || !serverUrl || !server) {
      setState(null);
      setLoading(false);
      return null;
    }
    asked.current = serverUrl;
    try {
      const next = await server.auth.state();
      if (asked.current !== serverUrl) return null;
      setState(next);
      setUnreachable(false);
      return next;
    } catch (error) {
      if (asked.current !== serverUrl) return null;
      // Not a login problem, and not one to lock the app over.
      setState(null);
      setUnreachable(true);
      if (!(error instanceof ApiError)) throw error;
      return null;
    } finally {
      if (asked.current === serverUrl) setLoading(false);
    }
  }, [applies, server, serverUrl]);

  useEffect(() => {
    setLoading(applies);
    setState(null);
    setNotice(null);
    // Another server: whether the last one answered says nothing of this one.
    setUnreachable(false);
    void refresh();
  }, [applies, serverUrl, refresh]);

  // A session that expires while the app is open shows up as a 401 somewhere;
  // asking again is what turns that into the login screen.
  useEffect(() => onLoginRequired(() => void refresh()), [onLoginRequired, refresh]);

  /*
    Held here rather than thrown to the form alone: after a first-account
    setup the setup form is replaced by the login form, and an error thrown to
    the one that is gone would never be seen.
  */
  const [notice, setNotice] = useState<string | null>(null);

  const signedIn = useCallback(
    async () => {
      const next = await refresh();
      const problem = notKept(next);
      setNotice(problem);
      if (problem) throw new Error(problem);
      /*
        Signed in from the form — the first account just made, or after a
        sign-out: what was asked before it was refused, so the home is opened
        again and everything read afresh. Opening with a session kept from
        before needs none of this.
      */
      if (next?.user && serverUrl) lastSignedIn.current = `${serverUrl} ${next.user.id}`;
      setGeneration((n) => n + 1);
    },
    [refresh, serverUrl]
  );

  const logIn = useCallback(
    async (username: string, password: string) => {
      await server?.auth.logIn(username, password);
      await signedIn();
    },
    [server, signedIn]
  );

  const setup = useCallback(
    async (username: string, password: string) => {
      await server?.auth.setup(username, password);
      await signedIn();
    },
    [server, signedIn]
  );

  const logOut = useCallback(async () => {
    await server?.auth.logOut().catch(() => undefined);
    lastSignedIn.current = null;
    setGeneration((n) => n + 1);
    await refresh();
  }, [refresh, server]);

  const value = useMemo<AuthContextValue>(
    () => ({
      applies,
      state,
      loading,
      unreachable,
      allowed: !applies || unreachable || Boolean(state?.user),
      notice,
      generation,
      refresh,
      logIn,
      setup,
      logOut,
    }),
    [applies, state, loading, unreachable, notice, generation, refresh, logIn, setup, logOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The server said yes, but the browser did not keep the cookie that says so.
 *
 * Browsers keep a sign-in only for requests to the same site as the page. The
 * app opened from one address and pointed at a server on another — two
 * different IP addresses, say — gets a successful login that is forgotten on
 * the very next request. Without this, the login form would simply come back,
 * with no clue why.
 */
function notKept(state: AuthState | null): string | null {
  if (!state || state.user) return null;
  const here = typeof window !== 'undefined' ? window.location?.host : null;
  return (
    'The server accepted the login, but this browser would not keep it' +
    (here ? ` — the app is open at ${here}, and the server is somewhere else` : '') +
    '. Open the app from the server’s own address instead.'
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
