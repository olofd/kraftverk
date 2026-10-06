import { router, useLocalSearchParams } from 'expo-router';
import { Button, Text, YStack } from 'tamagui';

import type { ConnectionView, DeviceView } from '@kraftverk/api-client';
import { Card, SectionLabel } from '@kraftverk/ui';

import { secretWords } from '../../components/ProblemList';
import { Screen } from '../../components/Screen';
import { useDevice, useDevices } from '../../state/DevicesProvider';
import { deviceStatus } from '../devices/DeviceShell';
import { Manage } from '../devices/Manage';
import { Members } from '../devices/Members';
import { integrationScreens } from './registry';

/**
 * Signing in again: each of the account's own ways, set up again through
 * the same steps as adding it — its credentials, a code it asks for, then a
 * check that it is the same account. Where another node keeps them, said,
 * since only that node may change them.
 */
function SignIn({ account }: { account: DeviceView }) {
  const ways = account.connections.filter((connection) => connection.through === null && connection.secrets.length > 0);
  if (!ways.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>Signing in</SectionLabel>
      {ways.map((way) => (
        <SignInWay key={way.id} account={account} way={way} />
      ))}
    </YStack>
  );
}

function SignInWay({ account, way }: { account: DeviceView; way: ConnectionView }) {
  const kept = way.heldBy.kind === 'node' ? way.heldBy.name : null;
  const waits = account.health.status === 'needs-you';
  return (
    <Card>
      <YStack gap="$3">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {`${way.methodLabel}, kept by ${way.heldBy.name}: its ${secretWords(way.secrets)} never leaves it, and is never shown.`}
        </Text>
        {kept ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {`${kept} keeps it: sign in again there.`}
          </Text>
        ) : (
          <Button
            size="$3"
            minHeight={44}
            alignSelf="flex-start"
            {...(waits ? { backgroundColor: '$accent', color: '$background' } : {})}
            onPress={() => router.push(`/add-device?again=${encodeURIComponent(account.id)}&connection=${encodeURIComponent(way.id)}`)}
          >
            Sign in again
          </Button>
        )}
      </YStack>
    </Card>
  );
}

/**
 * An account's page, under its integration (docs/PLAN-INTEGRATIONS.md §1.1):
 * how it is doing, its integration's own panel, what is reached through it,
 * signing in again, and renaming or removing it. Not a device page: the
 * devices behind it have theirs.
 */
export function AccountScreen() {
  const { id, account: accountId } = useLocalSearchParams<{ id: string; account: string }>();
  const account = useDevice(accountId);
  const { loading, screenProps } = useDevices();
  const integration = account?.integration ?? null;
  const Panel = integrationScreens(integration?.id ?? id)?.account;

  if (!account) {
    return (
      <Screen back="Integration" backTo={`/integration/${encodeURIComponent(id ?? '')}`} title="Account">
        <Card>
          <Text fontSize={13} color="$muted" textAlign="center" lineHeight={19}>
            {loading ? 'Reading it…' : 'That account is no longer here. It may have been removed.'}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen back={integration?.name ?? 'Integration'} backTo={`/integration/${encodeURIComponent(integration?.id ?? id ?? '')}`} title={account.name} subtitle={account.meta.name} status={deviceStatus(account)}>
      {Panel ? <Panel {...screenProps(account)} /> : null}
      <Members device={account} />
      <SignIn account={account} />
      <Manage device={account} />
    </Screen>
  );
}
