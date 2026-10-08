import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { httpApi } from '@kraftverk/api-client/http';
import type { KraftverkApi } from '@kraftverk/api-contract';
import { newId } from '@kraftverk/device-sdk';

import { Waiting } from '../components/FamilyOpening';
import { FoundFamily } from '../features/account/FoundFamily';
import { FamilyFailed } from '../features/account/FamilyFailed';
import type { OpenHome, OpenOptions } from '../platform/home/home';
import { keepNodeId, thisNode } from '../platform/node';
import { readLastServerId } from '../platform/servers';
import { useAccount } from './AccountProvider';
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

type FamilyValue = {
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

const HomeContext = createContext<FamilyValue | null>(null);

type Opening = { status: 'opening' } | { status: 'open'; home: OpenHome } | { status: 'failed'; message: string };

/** Opens a family in this device, as the account opened as, and keeps what became of it: open, or why it failed. */
function useOpened(options: Omit<OpenOptions, 'person' | 'node'> | null): { state: Opening; open: () => () => void } {
  const { device, account } = useAccount();
  const [state, setState] = useState<Opening>({ status: 'opening' });
  // Only the latest opening counts: one asked again, or let go of, outruns any before it.
  const latest = useRef(0);
  const open = useCallback(() => {
    const mine = ++latest.current;
    const live = () => latest.current === mine;
    setState({ status: 'opening' });
    if (!options) return () => undefined;
    device.openHome({ ...options, person: { id: account.personId, name: account.name }, node: thisNode() }).then(
      (home) => {
        if (!live()) return void home.close();
        keepNodeId(home.nodeId);
        setState({ status: 'open', home });
      },
      (error: unknown) => {
        if (live()) setState({ status: 'failed', message: (error as Error).message });
      }
    );
    return () => {
      if (live()) latest.current += 1;
    };
  }, [account.name, account.personId, device, options]);
  useEffect(() => open(), [open]);
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

export function FamilyProvider({ children }: { children: ReactNode }) {
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
  const { refresh, state: auth } = useAuth();
  const servers = useServers();
  const { account, personal, reload } = useAccount();
  // The account's own family, kept here: offered to the server.
  const ownId = account.families.find((family) => family.master === 'here')?.familyId ?? null;
  // Whether the server answered the last time it was asked: said by every request, whoever made it.
  const [away, setAway] = useState(false);
  const server = useMemo(
    () => ({ key: serverKey, api: httpApi({ baseUrl: url, onLoginRequired: () => void refresh(), onReach: (reached) => setAway(!reached) }) }),
    [refresh, serverKey, url]
  );
  const options = useMemo(() => ({ server, own: ownId ? { id: ownId } : null }), [ownId, server]);
  const { state, open } = useOpened(options);
  const home = state.status === 'open' ? state.home : null;
  // Signed in as this account: the server's family is one it is in — recorded, so its key signs in from now.
  const signedInAs = auth?.user?.id ?? null;
  useEffect(() => {
    if (signedInAs !== account.personId) return;
    const api = home?.api ?? server.api;
    // Known there without a key — its family started again, from a file that predates its chain — it is shown who this account is again.
    void api.people
      .me()
      .then(async (me) => {
        if (me && me.keys.length === 0) await servers.server?.auth.claim(await personal.chain(account.personId));
      })
      .catch(() => undefined);
    void api
      .family()
      .then((family) => {
        const kept = account.families.find((each) => each.familyId === family.id);
        if (kept?.master === 'server' && kept.serverUrl === url && kept.name === family.name) return;
        return personal.keepFamily(account.personId, { familyId: family.id, name: family.name, master: 'server', serverUrl: url, joinedAt: kept?.joinedAt ?? new Date().toISOString() }).then(reload);
      })
      .catch(() => undefined);
  }, [account.families, account.personId, home, personal, reload, server, servers.server, signedInAs, url]);
  const [writesAllowed, setWritesAllowed] = useWritesFor(home);

  const value = useMemo<FamilyValue | null>(() => {
    if (state.status === 'opening') return null;
    // Not held here: the server's home alone, and why — and trying again.
    const holding = state.status === 'open' ? null : { problem: `This app’s own ways could not open here: ${state.status === 'failed' ? state.message : 'they are opening'}`, takeOver: () => void open() };
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

/**
 * The account's own family: opened where the app runs, and shown once it is
 * — with the copy it kept of the server it used last beside it. An account
 * with none has one made here, named in its personal store at once; one
 * with nobody in it yet is founded first.
 */
function OwnHome({ children }: { children: ReactNode }) {
  const { personal, account, reload } = useAccount();
  const own = account.families.find((family) => family.master === 'here') ?? null;
  useEffect(() => {
    if (own) return;
    void personal.keepFamily(account.personId, { familyId: newId('f'), name: 'Family', master: 'here', serverUrl: null, joinedAt: new Date().toISOString() }).then(reload);
  }, [account.personId, own, personal, reload]);
  const ownId = own?.familyId ?? null;
  // Opened again only for another family: its name changing is not a reason.
  const options = useMemo(() => (ownId ? { family: { id: ownId }, copyOf: readLastServerId() } : null), [ownId]);
  const { state, open } = useOpened(options);
  const home = state.status === 'open' ? state.home : null;
  const [writesAllowed, setWritesAllowed] = useWritesFor(home);
  // Whether anyone is in it yet: a family made here is founded by its first person.
  const [founded, setFounded] = useState<boolean | null>(null);
  useEffect(() => {
    setFounded(null);
    if (home) void home.api.people.list().then((people) => setFounded(people.length > 0));
  }, [home]);

  const value = useMemo<FamilyValue | null>(
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

  if (state.status === 'failed') return <FamilyFailed message={state.message} onRetry={() => void open()} />;
  if (!value || founded === null) return <Waiting />;
  if (!founded) return <FoundFamily api={value.api} onFounded={() => setFounded(true)} />;
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** The family's interface, where one is open: none while one is being founded. */
export const useFamilyApi = (): KraftverkApi | null => useContext(HomeContext)?.api ?? null;

/** The home the app shows, and what goes with it. */
export function useFamily(): FamilyValue {
  const context = useContext(HomeContext);
  if (!context) throw new Error('useFamily must be used inside <FamilyProvider>');
  return context;
}
