import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { httpApi } from '@kraftverk/api-client/http';
import type { KraftverkApi } from '@kraftverk/api-contract';

import { NotOpen, Waiting } from '../components/HomeOpening';
import { HomeOpenElsewhere, type OpenHome, type OpenOptions } from '../platform/home/home';
import { openHome } from '../platform/home/open';
import { keepNodeId, thisNode } from '../platform/node';
import { readLastServerId } from '../platform/servers';
import { useAuth } from './AuthProvider';
import { useServers } from './ServersProvider';

/**
 * The home the app shows (docs/PLAN-SHARED-CORE.md, phase 6): the app's own,
 * running where the app runs — or a server's, with what this app holds for
 * it wrapped in (`createFollower`: its own Bluetooth, beside the server's
 * ways). Either way it is opened where the app runs (`platform/home/`: a
 * phone's in its process, a browser's in its worker), and either way it is
 * one interface, `KraftverkApi`, and no screen asks which.
 */

type HomeValue = {
  /** Everything the home answers. */
  api: KraftverkApi;
  /** This node's role in the home it shows: its master — the app's own home — or following one, a server's. For words — "through your server" — never for what a screen does. */
  role: 'master' | 'follower';
  /** Whether it asks for your account's password again before a secret leaves it: a server's, which has accounts; the app's own has none. */
  asksYourPassword: boolean;
  /** Whether writes to hardware are allowed from this app: refused every launch, until someone says. */
  writesAllowed: boolean;
  allowWrites: (allowed: boolean) => Promise<void>;
  /** This app, as a node of the home: its own id, in its own home and a server’s alike — known even while its own ways have not opened here, so nothing offers to forget it. */
  nodeId: string;
  /**
   * With a server, when this app cannot hold its own ways now — another tab
   * of this browser holds them, or they could not open here — why, and how
   * to try again. The server's home is shown either way.
   */
  holding: { problem: string; takeOver: (() => void) | null } | null;
  /**
   * With a server: it did not answer the last time it was asked. What is
   * shown is what it last said — read only — and what this app reaches
   * itself goes on.
   */
  away: boolean;
};

const HomeContext = createContext<HomeValue | null>(null);

export type Opening =
  | { status: 'opening' }
  | { status: 'open'; home: OpenHome }
  | { status: 'elsewhere' }
  | { status: 'handed-over' }
  | { status: 'failed'; message: string };

/** Opens the home where the app runs, and keeps what became of it: open, held by another tab, handed over, or why it failed. */
function useOpened(server: OpenOptions['server'], copyOf: string | null = null): { state: Opening; open: (takeOver: boolean) => () => void } {
  const [state, setState] = useState<Opening>({ status: 'opening' });
  // Only the latest opening counts: one asked again — "use it here" — or let go of, outruns any before it.
  const latest = useRef(0);
  const open = useCallback(
    (takeOver: boolean) => {
      const mine = ++latest.current;
      const live = () => latest.current === mine;
      setState({ status: 'opening' });
      openHome({ takeOver, server, node: thisNode(), copyOf }).then(
        (home) => {
          if (!live()) return void home.close();
          keepNodeId(home.nodeId);
          setState({ status: 'open', home });
          void home.ended.then(() => live() && setState({ status: 'handed-over' }));
        },
        (error: unknown) => {
          if (!live()) return;
          setState(error instanceof HomeOpenElsewhere ? { status: 'elsewhere' } : { status: 'failed', message: (error as Error).message });
        }
      );
      return () => {
        if (live()) latest.current += 1;
      };
    },
    [copyOf, server]
  );
  useEffect(() => open(false), [open]);
  const home = state.status === 'open' ? state.home : null;
  useEffect(() => () => void home?.close(), [home]);
  return { state, open };
}

/**
 * Whether writes are allowed, for the home opened now: one opened again —
 * taken back from another tab, tried again — starts with them off, as every
 * opening does, and the switch says so rather than what the last one was.
 */
function useWritesFor(home: OpenHome | null): [boolean, (allowed: boolean) => void] {
  const [allowedFor, setAllowedFor] = useState<OpenHome | null>(null);
  return [home !== null && allowedFor === home, (allowed) => setAllowedFor(allowed ? home : null)];
}

export function HomeProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const { generation } = useAuth();
  // Not yet known whether a server stands beside this app: nothing is opened until it is.
  if (servers.deciding) return <Waiting />;
  // What this app holds is held for one server, as one person: switching either lets go of it.
  return servers.active ? (
    <ServerHome key={`${servers.active.id} ${generation}`} serverKey={servers.active.id} url={servers.active.url}>
      {children}
    </ServerHome>
  ) : (
    <OwnHome>{children}</OwnHome>
  );
}

/** A server's home, over HTTP — with what this app holds for it wrapped in, once that is open here. */
function ServerHome({ serverKey, url, children }: { serverKey: string; url: string; children: ReactNode }) {
  const { refresh } = useAuth();
  // Whether the server answered the last time it was asked: said by every request, whoever made it.
  const [away, setAway] = useState(false);
  const server = useMemo(
    () => ({ key: serverKey, api: httpApi({ baseUrl: url, onLoginRequired: () => void refresh(), onReach: (reached) => setAway(!reached) }) }),
    [refresh, serverKey, url]
  );
  const { state, open } = useOpened(server);
  const home = state.status === 'open' ? state.home : null;
  const [writesAllowed, setWritesAllowed] = useWritesFor(home);

  const value = useMemo<HomeValue | null>(() => {
    if (state.status === 'opening') return null;
    // Not held here: the server's home alone, and why — its own ways can be taken back from the tab that has them.
    const holding =
      state.status === 'open'
        ? null
        : state.status === 'failed'
          ? { problem: `This app’s own ways could not open here: ${state.message}`, takeOver: () => open(false) }
          : { problem: 'Another tab of this browser holds this app’s own ways, such as its Bluetooth', takeOver: () => open(true) };
    return {
      api: home?.api ?? server.api,
      role: 'follower',
      asksYourPassword: true,
      writesAllowed,
      allowWrites: async (allowed) => {
        await home?.allowWrites(allowed);
        setWritesAllowed(allowed);
      },
      nodeId: home?.nodeId ?? thisNode().id,
      holding,
      away,
    };
  }, [away, home, open, server, state, writesAllowed]);

  if (!value) return <Waiting />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** The app's own home: opened where the app runs, and shown once it is — with the copy it kept of the server it used last beside it. */
function OwnHome({ children }: { children: ReactNode }) {
  const { state, open } = useOpened(undefined, readLastServerId());
  const home = state.status === 'open' ? state.home : null;
  const [writesAllowed, setWritesAllowed] = useWritesFor(home);

  const value = useMemo<HomeValue | null>(
    () =>
      home
        ? {
            api: home.api,
            role: 'master',
            asksYourPassword: false,
            writesAllowed,
            allowWrites: async (allowed) => {
              await home.allowWrites(allowed);
              setWritesAllowed(allowed);
            },
            nodeId: home.nodeId,
            holding: null,
            away: false,
          }
        : null,
    [home, writesAllowed]
  );

  if (!value) return <NotOpen state={state} onTakeOver={() => open(true)} onRetry={() => open(false)} />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** The home the app shows, and what goes with it. */
export function useHome(): HomeValue {
  const context = useContext(HomeContext);
  if (!context) throw new Error('useHome must be used inside <HomeProvider>');
  return context;
}
