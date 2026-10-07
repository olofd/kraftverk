import { useCallback, useEffect, useState } from 'react';
import { Button, Text, useTheme, YStack } from 'tamagui';

import { type AccountDetail, describeError, PATHS } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAuth } from '../../state/AuthProvider';
import { useServer } from '../../state/ServersProvider';
import { AccountRow } from './AccountRow';
import { AddAccount } from './AddAccount';
import { ChangeOwnPassword } from './ChangeOwnPassword';

/**
 * Who may use this server.
 *
 * Reached only signed in: the sign-in gate stands in front of the whole app,
 * so the cases below the first two are the signed-in one. Every account is an
 * administrator for now.
 */
export function Accounts() {
  const { applies, state } = useAuth();

  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Accounts" subtitle="Who may use this server">
      {!applies ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Accounts belong to a server. With none, this app keeps your home itself, and there is nobody to
            log in to.
          </Text>
        </Card>
      ) : !state?.user ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Who may use this server is shown once it can be reached.
          </Text>
        </Card>
      ) : (
        <SignedIn />
      )}
    </Screen>
  );
}

function SignedIn() {
  const server = useServer();
  const { state, logOut } = useAuth();
  const theme = useTheme();
  const [accounts, setAccounts] = useState<AccountDetail[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await server.accounts.list());
      setProblem(null);
    } catch (error) {
      setProblem(describeError(error));
    }
  }, [server]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state?.user) return null;
  const me = state.user;

  return (
    <>
      <YStack gap="$2">
        <SectionLabel>You</SectionLabel>
        <Card inset>
          <Row
            title={me.username}
            subtitle="Signed in on this device"
            accessory={
              <Button
                size="$2"
                icon={<Icon name="log-out" size={12} color={theme.color?.val} />}
                onPress={() => {
                  haptic();
                  void logOut();
                }}
              >
                Sign out
              </Button>
            }
          />
        </Card>
        <ChangeOwnPassword />
      </YStack>


      <YStack gap="$2">
        <SectionLabel>Accounts</SectionLabel>
        <Card inset>
          {accounts.map((account, index) => (
            <YStack key={account.id}>
              {index > 0 ? <RowSeparator /> : null}
              <AccountRow account={account} isMe={account.id === me.id} onlyOne={accounts.length === 1} onChanged={load} />
            </YStack>
          ))}
        </Card>
        {problem ? (
          <ErrorText paddingHorizontal="$1">
            {problem}
          </ErrorText>
        ) : null}
        <AddAccount onAdded={load} />
      </YStack>
    </>
  );
}
