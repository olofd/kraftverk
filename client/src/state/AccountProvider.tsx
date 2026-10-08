import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import type { AccountView, PersonalApi } from '@kraftverk/api-contract';

import { NotOpen, Waiting } from '../components/FamilyOpening';
import { Welcome } from '../features/account/Welcome';
import { HomeOpenElsewhere, type OpenDevice } from '../platform/home/home';
import { openDevice } from '../platform/home/open';

/**
 * This device, and who uses it (docs/PLAN-WORLD-MODEL.md §10.6): the
 * accounts it keeps, and the one it opens as. Opened before anything else —
 * a browser's files are one tab's at a time, and a family opens inside
 * them — and with no account opened as, the app is sign-up, or the
 * accounts on this device to choose from. An account works with no server.
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

export function AccountProvider({ children }: { children: ReactNode }) {
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
  if (!accounts) return <Waiting />;
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
      {children}
    </AccountContext.Provider>
  );
}

/** This device, and the account it opens as. */
export function useAccount(): AccountValue {
  const context = useContext(AccountContext);
  if (!context) throw new Error('useAccount must be used inside <AccountProvider>');
  return context;
}
