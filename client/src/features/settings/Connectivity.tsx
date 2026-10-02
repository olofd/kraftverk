import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { HERE } from '../../platform/here';
import { useHome } from '../../state/HomeProvider';
import { capitalise, Diagnostics } from './Diagnostics';
import { Nodes } from './Nodes';

/**
 * What devices are reached over, by whom (docs/ARCHITECTURE.md §4.7).
 *
 * The home's transports — a server's MQTT broker, its Bluetooth radio, the
 * home network; or, with no server, this browser's or phone's own — each with
 * whether it runs and why not, and its own read-only diagnostics. Then, with
 * a server, what this app can hold a connection over itself. Nothing here
 * names a device, and on screen this is "connectivity": the app never says
 * transport (§2).
 */
export function Connectivity() {
  const { api, role, holding } = useHome();
  const theme = useTheme();
  const { value: list, error } = useAnswer(() => api.transports.list(), [api], { failure: 'It did not say what it can reach' });
  // The home's own, and — with a server — this app's, which it holds the server's ways over.
  const theirs = list?.transports.filter((transport) => transport.holder === 'master') ?? [];
  const mine = list?.transports.filter((transport) => transport.holder === 'this-node') ?? [];

  return (
    <Screen back="App settings" backTo="/app-settings" title="Connectivity" subtitle="How devices are reached">
      <Nodes labels={Object.fromEntries((list?.transports ?? []).map((transport) => [transport.id, transport.label]))} />

      <YStack gap="$2">
        <SectionLabel>{role === 'follower' ? 'Your server' : capitalise(HERE)}</SectionLabel>
        {error ? (
          <Card borderColor="$danger">
            <ErrorText>
              {error}
            </ErrorText>
          </Card>
        ) : null}
        {!list && !error ? <Spinner color="$accent" /> : null}
        {theirs.map((transport) => (
          <Card key={transport.id} gap="$2">
            <XStack alignItems="center" gap="$2">
              <Icon
                name={transport.availability.ok ? 'check-circle' : 'alert-circle'}
                size={16}
                color={transport.availability.ok ? theme.success?.val : theme.warning?.val}
              />
              <Text flex={1} fontSize={15} fontWeight="700" color="$color">
                {capitalise(transport.label)}
              </Text>
            </XStack>
            <Text fontSize={12} color="$muted" lineHeight={18}>
              {transport.availability.ok ? 'Running.' : transport.availability.reason}
              {Object.keys(transport.values).length ? ` ${Object.entries(transport.values).map(([key, value]) => `${key}: ${value}`).join(' · ')}` : ''}
            </Text>
            {transport.diagnostics.length ? <Diagnostics transport={transport.id} names={transport.diagnostics} /> : null}
          </Card>
        ))}
        {list?.refused.length ? (
          <Card borderColor="$warning" gap="$1">
            {list.refused.map((refusal) => (
              <Text key={refusal.source} fontSize={12} color="$warning">
                {refusal.source}: {refusal.problems.join('; ')}
              </Text>
            ))}
          </Card>
        ) : null}
      </YStack>

      {role === 'follower' && list ? (
        <YStack gap="$2">
          <SectionLabel>This app, for your server</SectionLabel>
          <Card inset>
            {holding ? (
              <Row
                title={`Not held in ${HERE} now`}
                subtitle={holding.problem}
                accessory={
                  holding.takeOver ? (
                    <Button size="$2" onPress={holding.takeOver}>
                      Use it here
                    </Button>
                  ) : undefined
                }
              />
            ) : mine.length === 0 ? (
              <Row title={`Nothing in ${HERE}`} subtitle="This app cannot hold a way itself here" />
            ) : null}
            {holding
              ? null
              : mine.map((transport, index) => (
                  <YStack key={transport.id}>
                    {index > 0 ? <RowSeparator /> : null}
                    <Row title={capitalise(transport.label)} subtitle={transport.availability.ok ? 'Available here' : transport.availability.reason} />
                  </YStack>
                ))}
          </Card>
        </YStack>
      ) : null}
    </Screen>
  );
}
