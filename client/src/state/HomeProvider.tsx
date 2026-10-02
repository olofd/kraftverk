import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Spinner, Text, YStack } from 'tamagui';

import type { KraftverkApi } from '@kraftverk/api-contract';
import { getApiBaseUrl } from '@kraftverk/api-client';
import { httpApi } from '@kraftverk/api-client/http';
import { Card, Row, haptic } from '@kraftverk/ui';

import { Pressable } from '../components/Pressable';
import { appName } from '../platform/here';
import { HomeOpenElsewhere, type OpenHome, type OpenOptions } from '../platform/home/home';
import { openHome } from '../platform/home/open';
import { useAuth } from './AuthProvider';
import { useServers } from './ServersProvider';

/**
 * The home the app shows (docs/PLAN-SHARED-CORE.md, phase 6): the app's own,
 * running where the app runs — or a server's, with what this app holds for
 * it wrapped in (`createHolding`: its own Bluetooth, beside the server's
 * ways). Either way it is opened where the app runs (`platform/home/`: a
 * phone's in its process, a browser's in its worker), and either way it is
 * one interface, `KraftverkApi`, and no screen asks which.
 */

type HomeValue = {
  /** Everything the home answers. */
  api: KraftverkApi;
  /** A server's, or the app's own: for words — "through your server" — never for what a screen does. */
  kind: 'server' | 'own';
  /** Whether writes to hardware are allowed from this app: refused every launch, until someone says. */
  writesAllowed: boolean;
  allowWrites: (allowed: boolean) => Promise<void>;
  /** With a server: this app as the server knows it, or null until it has said who it is. */
  appId: string | null;
  /**
   * With a server, when this app cannot hold its own ways now — another tab
   * of this browser holds them, or they could not open here — why, and how
   * to try again. The server's home is shown either way.
   */
  holding: { problem: string; takeOver: (() => void) | null } | null;
};

const HomeContext = createContext<HomeValue | null>(null);

type Opening =
  | { status: 'opening' }
  | { status: 'open'; home: OpenHome }
  | { status: 'elsewhere' }
  | { status: 'handed-over' }
  | { status: 'failed'; message: string };

/** Opens the home where the app runs, and keeps what became of it: open, held by another tab, handed over, or why it failed. */
function useOpened(server: OpenOptions['server']): { state: Opening; open: (takeOver: boolean) => () => void } {
  const [state, setState] = useState<Opening>({ status: 'opening' });
  const open = useCallback(
    (takeOver: boolean) => {
      let live = true;
      setState({ status: 'opening' });
      openHome({ takeOver, server, name: appName() }).then(
        (home) => {
          if (!live) return void home.close();
          setState({ status: 'open', home });
          void home.ended.then(() => live && setState({ status: 'handed-over' }));
        },
        (error: unknown) => {
          if (!live) return;
          setState(error instanceof HomeOpenElsewhere ? { status: 'elsewhere' } : { status: 'failed', message: (error as Error).message });
        }
      );
      return () => {
        live = false;
      };
    },
    [server]
  );
  useEffect(() => open(false), [open]);
  const home = state.status === 'open' ? state.home : null;
  useEffect(() => () => void home?.close(), [home]);
  return { state, open };
}

export function HomeProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  const { generation } = useAuth();
  // What this app holds is held for one server, as one person: switching either lets go of it.
  return servers.mode === 'server' && servers.active ? (
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
  const server = useMemo(() => ({ key: serverKey, api: httpApi({ baseUrl: getApiBaseUrl(), onLoginRequired: () => void refresh() }) }), [refresh, serverKey, url]);
  const { state, open } = useOpened(server);
  const [writesAllowed, setWritesAllowed] = useState(false);
  const home = state.status === 'open' ? state.home : null;

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
      kind: 'server',
      writesAllowed,
      allowWrites: async (allowed) => {
        await home?.allowWrites(allowed);
        setWritesAllowed(allowed);
      },
      appId: home?.appId ?? null,
      holding,
    };
  }, [home, open, server, state, writesAllowed]);

  if (!value) return <Waiting />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** The app's own home: opened where the app runs, and shown once it is. */
function OwnHome({ children }: { children: ReactNode }) {
  const { state, open } = useOpened(undefined);
  const [writesAllowed, setWritesAllowed] = useState(false);
  const home = state.status === 'open' ? state.home : null;

  const value = useMemo<HomeValue | null>(
    () =>
      home
        ? {
            api: home.api,
            kind: 'own',
            writesAllowed,
            allowWrites: async (allowed) => {
              await home.allowWrites(allowed);
              setWritesAllowed(allowed);
            },
            appId: null,
            holding: null,
          }
        : null,
    [home, writesAllowed]
  );

  if (!value) return <NotOpen state={state} onTakeOver={() => open(true)} onRetry={() => open(false)} />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

function Waiting() {
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor="$background">
      <Spinner color="$accent" />
    </YStack>
  );
}

/** What stands in for the app while its own home is not open here: opening, held by another tab, or why it cannot be. */
function NotOpen({ state, onTakeOver, onRetry }: { state: Opening; onTakeOver: () => void; onRetry: () => void }) {
  const servers = useServers();
  if (state.status === 'opening' || state.status === 'open') return <Waiting />;
  const [title, detail, action] =
    state.status === 'elsewhere'
      ? (['Open in another tab', 'This browser keeps its home in one tab at a time, and another tab has it open now.', 'Use it here'] as const)
      : state.status === 'handed-over'
        ? (['Open in another tab now', 'Another tab of this browser asked for this home, and has it now.', 'Use it here again'] as const)
        : (['This home could not open', state.message, 'Try again'] as const);
  return (
    <YStack flex={1} backgroundColor="$background" alignItems="center" justifyContent="center" padding="$4">
      <YStack width="100%" maxWidth={420} gap="$4">
        <Card gap="$3">
          <Text role="heading" fontSize={18} fontWeight="700" color="$color">
            {title}
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {detail}
          </Text>
          <Button
            size="$3"
            backgroundColor="$accent"
            color="$background"
            onPress={() => {
              haptic();
              if (state.status === 'failed') onRetry();
              else onTakeOver();
            }}
          >
            {action}
          </Button>
        </Card>
        {servers.all.length ? (
          <Card inset>
            {servers.all.map((server) => (
              <Pressable key={server.id} onPress={() => servers.use(server.id)}>
                <Row title={`Use ${server.name}`} subtitle={server.url} />
              </Pressable>
            ))}
          </Card>
        ) : null}
      </YStack>
    </YStack>
  );
}

/** The home the app shows, and what goes with it. */
export function useHome(): HomeValue {
  const context = useContext(HomeContext);
  if (!context) throw new Error('useHome must be used inside <HomeProvider>');
  return context;
}
