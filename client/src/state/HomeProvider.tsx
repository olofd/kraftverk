import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Spinner, Text, YStack } from 'tamagui';

import type { KraftverkApi } from '@kraftverk/api-contract';
import { getApiBaseUrl } from '@kraftverk/api-client';
import { httpApi } from '@kraftverk/api-client/http';
import { Card, Row, haptic } from '@kraftverk/ui';

import { Pressable } from '../components/Pressable';
import { HomeOpenElsewhere, type OwnHome } from '../platform/home/home';
import { openOwnHome } from '../platform/home/own';
import { AppRuntime } from '../runtime/runtime';
import { useAuth } from './AuthProvider';
import { useServers } from './ServersProvider';

/**
 * The home the app shows (docs/PLAN-SHARED-CORE.md, principle 4 and phase
 * 6e): a server's, asked over HTTP — or, with no server, the app's own,
 * running where the app runs (`platform/home/`: a phone's in its process, a
 * browser's in its worker). Either way one interface, `KraftverkApi`, and
 * no screen asks which.
 *
 * With a server the app may hold connections of its own as well — its own
 * Bluetooth, beside the server's — which `holding` keeps until the hub's
 * `createHolding` takes its place (6f).
 */

type HomeValue = {
  /** Everything the home answers. */
  api: KraftverkApi;
  /** A server's, or the app's own. */
  kind: 'server' | 'own';
  /** Whether writes to hardware are allowed from this app: refused every launch, until someone says. */
  writesAllowed: boolean;
  allowWrites: (allowed: boolean) => Promise<void>;
  /** With a server: the connections this app holds itself. */
  holding: AppRuntime | null;
};

const HomeContext = createContext<HomeValue | null>(null);

type OwnState =
  | { status: 'opening' }
  | { status: 'open'; home: OwnHome }
  | { status: 'elsewhere' }
  | { status: 'handed-over' }
  | { status: 'failed'; message: string };

export function HomeProvider({ children }: { children: ReactNode }) {
  const servers = useServers();
  // One holding per server: switching servers lets go of what the last one held.
  return servers.mode === 'server' && servers.active ? (
    <ServerHome key={servers.active.url} url={servers.active.url}>
      {children}
    </ServerHome>
  ) : (
    <OwnHomeProvider>{children}</OwnHomeProvider>
  );
}

/** A server's home, over HTTP; and what this app holds for it. */
function ServerHome({ url, children }: { url: string; children: ReactNode }) {
  const { refresh } = useAuth();
  const api = useMemo(() => httpApi({ baseUrl: getApiBaseUrl(), onLoginRequired: () => void refresh() }), [refresh, url]);
  const [holding] = useState(() => new AppRuntime({ server: url }));
  useEffect(() => () => void holding.stop(), [holding]);
  const [writesAllowed, setWritesAllowed] = useState(holding.allowWrites);
  useEffect(() => holding.subscribe(() => setWritesAllowed(holding.allowWrites)), [holding]);

  const value = useMemo<HomeValue>(
    () => ({ api, kind: 'server', writesAllowed, allowWrites: async (allowed) => holding.setAllowWrites(allowed), holding }),
    [api, holding, writesAllowed]
  );
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** The app's own home: opened where the app runs, and shown once it is. */
function OwnHomeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OwnState>({ status: 'opening' });
  const [writesAllowed, setWritesAllowed] = useState(false);

  const open = useCallback((takeOver: boolean) => {
    let live = true;
    setState({ status: 'opening' });
    openOwnHome({ takeOver }).then(
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
  }, []);

  useEffect(() => open(false), [open]);
  const home = state.status === 'open' ? state.home : null;
  useEffect(() => () => void home?.close(), [home]);

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
            holding: null,
          }
        : null,
    [home, writesAllowed]
  );

  if (!value) return <NotOpen state={state} onTakeOver={() => open(true)} onRetry={() => open(false)} />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** What stands in for the app while its own home is not open here: opening, held by another tab, or why it cannot be. */
function NotOpen({ state, onTakeOver, onRetry }: { state: OwnState; onTakeOver: () => void; onRetry: () => void }) {
  const servers = useServers();
  if (state.status === 'opening' || state.status === 'open') {
    return (
      <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor="$background">
        <Spinner color="$accent" />
      </YStack>
    );
  }
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
