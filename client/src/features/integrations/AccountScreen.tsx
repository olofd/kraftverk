import { router, useLocalSearchParams } from 'expo-router';
import { Button, Text, YStack } from 'tamagui';

import { PATHS, type ConnectionView, type DeviceView } from '@kraftverk/api-client';
import { Card, SectionLabel } from '@kraftverk/ui';

import { secretWords } from '../../components/ProblemList';
import { Screen } from '../../components/Screen';
import { useDevice, useDevices } from '../../state/DevicesProvider';
import { deviceStatus } from '../devices/DeviceShell';
import { Manage } from '../devices/Manage';
import { Joining } from '../devices/Joining';
import { Members } from '../devices/Members';
import { Readings } from '../devices/Readings';
import { Tools } from '../devices/Tools';
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
      <SectionLabel>{account.kind === 'account' ? 'Signing in' : 'Its key'}</SectionLabel>
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
            onPress={() => router.push(PATHS.devices.again(account.id, way.id))}
          >
            {account.kind === 'account' ? 'Sign in again' : 'Set up again'}
          </Button>
        )}
      </YStack>
    </Card>
  );
}

/**
 * An integration's own, on a page under it (docs/PLAN-INTEGRATIONS.md §1.1)
 * — an account, or a gateway: how it is doing, its integration's own panel,
 * what is reached through it, each to be added, setting it up again, and
 * renaming or removing it. Not a device page: the devices behind it have
 * theirs.
 */
export function OwnScreen() {
  const { id, account: accountId, gateway: gatewayId } = useLocalSearchParams<{ id: string; account?: string; gateway?: string }>();
  const account = useDevice(accountId ?? gatewayId ?? '');
  const { loading, screenProps } = useDevices();
  const integration = account?.integration ?? null;
  const Panel = integrationScreens(integration?.id ?? id)?.account;

  if (!account) {
    return (
      <Screen back="Integration" backTo={PATHS.integrations.one(id ?? '')} title={gatewayId ? 'Gateway' : 'Account'}>
        <Card>
          <Text fontSize={13} color="$muted" textAlign="center" lineHeight={19}>
            {loading ? 'Reading it…' : `That ${gatewayId ? 'gateway' : 'account'} is no longer here. It may have been removed.`}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen back={integration?.name ?? 'Integration'} backTo={PATHS.integrations.one(integration?.id ?? id ?? '')} title={account.name} subtitle={account.meta.name} status={deviceStatus(account)}>
      {Panel ? <Panel {...screenProps(account)} /> : null}
      <Joining device={account} />
      <Members device={account} />
      <Readings device={account} />
      <Tools device={account} />
      <SignIn account={account} />
      <Manage device={account} />
    </Screen>
  );
}
