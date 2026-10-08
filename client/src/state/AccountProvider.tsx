import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import type { AccountView, PersonalApi } from '@kraftverk/api-contract';

import { NotOpen, Waiting } from '../components/FamilyOpening';
import { Welcome } from '../features/account/Welcome';
import { HomeOpenElsewhere, type OpenDevice } from '../platform/home/home';
import { openDevice } from '../platform/home/open';
import { useServers } from './ServersProvider';

/**
 * This device, and who uses it (docs/PLAN-WORLD-MODEL.md §10.6): the
 * accounts it keeps, and the one it opens as. Opened before anything else —
 * a browser's files are one tab's at a time, and a family opens inside
 * them — and with no account opened as, the app is sign-up, or the
 * accounts on this device to choose from. An account works with no server.
 *
 * A page a browser does not trust — plain HTTP on the home network,
 * http://kraftverk.local — is given neither the key store nor the files an
 * account needs. There the app keeps no account: it is its server's, signed
 * in with a password, as before people were (`keepsAccounts`).
 */

type AccountValue = {
  /** This device: the families it opens, as the account opened as. */
  device: OpenDevice;
  personal: PersonalApi;
  /** The account this device opens as now. */
  account: AccountView;
  /** Every account on this device. */
  accounts: AccountView[];
  /** The accounts read again: after a change to one. */
  reload: () => Promise<void>;
  /** Back to the accounts on this device, the key kept. */
  signOut: () => Promise<void>;
};

const AccountContext = createContext<AccountValue | null>(null);

export type Opening = { status: 'opening' } | { status: 'open'; device: OpenDevice } | { status: 'elsewhere' } | { status: 'handed-over' } | { status: 'failed'; message: string };

/** Opens this device, and keeps what became of it: open, held by another tab, handed over, or why it failed. */
function useDevice(): { state: Opening; open: (takeOver: boolean) => void } {
  const [state, setState] = useState<Opening>({ status: 'opening' });
  const latest = useRef(0);
  const open = useCallback((takeOver: boolean) => {
    const mine = ++latest.current;
    const live = () => latest.current === mine;
    setState({ status: 'opening' });
    openDevice({ takeOver }).then(
      (device) => {
        if (!live()) return void device.close();
        setState({ status: 'open', device });
        void device.ended.then(() => live() && setState({ status: 'handed-over' }));
      },
      (error: unknown) => {
        if (live()) setState(error instanceof HomeOpenElsewhere ? { status: 'elsewhere' } : { status: 'failed', message: (error as Error).message });
      }
    );
  }, []);
  useEffect(() => {
    open(false);
    return () => void (latest.current += 1);
  }, [open]);
  const device = state.status === 'open' ? state.device : null;
  useEffect(() => () => void device?.close(), [device]);
  return { state, open };
}

/**
 * Whether this page can keep an account: a browser keeps keys and files only
 * on a secure page — HTTPS, or this computer itself. A phone always can.
 */
export const keepsAccounts = (): boolean => Platform.OS !== 'web' || (globalThis as { isSecureContext?: boolean }).isSecureContext !== false;

export function AccountProvider({ children }: { children: ReactNode }) {
  // Known when the page loads, and never changes while it is open.
  if (!keepsAccounts()) return <>{children}</>;
  return <DeviceAccounts>{children}</DeviceAccounts>;
}

function DeviceAccounts({ children }: { children: ReactNode }) {
  const { state, open } = useDevice();
  const device = state.status === 'open' ? state.device : null;
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const reload = useCallback(async () => {
    if (device) setAccounts(await device.personal.accounts());
  }, [device]);
  useEffect(() => {
    setAccounts(null);
    void reload();
  }, [reload]);

  if (!device) return <NotOpen state={state} onTakeOver={() => open(true)} onRetry={() => open(false)} />;
  if (!accounts) return <Waiting what="Reading the accounts on this device" />;
  const account = accounts.find((each) => each.active) ?? null;
  // No one opened as: sign up, or choose an account this device keeps.
  if (!account) return <Welcome personal={device.personal} accounts={accounts} onChanged={reload} />;
  const value: AccountValue = {
    device,
    personal: device.personal,
    account,
    accounts,
    reload,
    signOut: async () => {
      await device.personal.activate(null);
      await reload();
    },
  };
  // A new account, or another one: everything inside starts again as them.
  return (
    <AccountContext.Provider key={account.personId} value={value}>
      <ItsServer />
      {children}
    </AccountContext.Provider>
  );
}

/**
 * The family an account opens as it is opened: one it is in, on a server —
 * that server — or, in none there, its own on this device. One in no family
 * yet keeps what this device chose: a server beside the app, to sign in to
 * and claim, or none. Chosen once per opening; choosing another server after
 * is the person's.
 */
function ItsServer() {
  const { account } = useAccount();
  const servers = useServers();
  const chosen = useRef(false);
  useEffect(() => {
    if (chosen.current || servers.deciding) return;
    chosen.current = true;
    if (!account.families.length) return;
    const onServer = account.families.find((family) => family.master === 'server' && family.serverUrl === servers.active?.url) ?? account.families.find((family) => family.master === 'server');
    if (onServer?.serverUrl === servers.active?.url && onServer) return;
    const saved = onServer ? servers.all.find((server) => server.url === onServer.serverUrl) : null;
    if (onServer && saved) servers.use(saved.id);
    else if (!onServer && servers.active) servers.use(null);
  }, [account.families, servers]);
  return null;
}

/** The account this device opens as — or none, on a page that keeps none (`keepsAccounts`): the app is its server's alone there. */
export function useAccountIfAny(): AccountValue | null {
  return useContext(AccountContext);
}

/** This device, and the account it opens as. */
export function useAccount(): AccountValue {
  const context = useContext(AccountContext);
  if (!context) throw new Error('useAccount must be used inside <AccountProvider>');
  return context;
}
