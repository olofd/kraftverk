import { router } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import { byPlatform, whereTheyRunSaid } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * Where kraftverk meets each service and platform (docs/PLAN-INTEGRATIONS.md
 * §1.1): every installed integration, with how many of your accounts and
 * devices are on it and where it runs — each a tap from its own page, where
 * its accounts are managed.
 */
export function IntegrationsScreen() {
  const { api } = useHome();
  const { devices } = useDevices();
  const theme = useTheme();
  const { value: list, error } = useAnswer(() => api.deviceTypes(), [api], { failure: 'What is installed could not be read' });
  const platforms = list ? byPlatform(list) : [];

  return (
    <Screen back="Your devices" backTo="/" title="Integrations" subtitle="Where kraftverk meets each service and platform: your accounts on it, and the devices it knows">
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Card inset>
        {platforms.map(({ integration, products, own }, index) => {
          const on = devices.filter((device) => device.integration?.id === integration.id && !device.removedAt);
          const accounts = on.filter((device) => device.kind === 'account').length;
          const devicesOn = on.length - accounts;
          const yours = [accounts ? `${accounts} account${accounts === 1 ? '' : 's'}` : null, devicesOn ? `${devicesOn} device${devicesOn === 1 ? '' : 's'}` : null].filter(Boolean);
          return (
            <YStack key={integration.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable onPress={() => router.push(`/integration/${encodeURIComponent(integration.id)}`)}>
                <Row
                  title={integration.name}
                  subtitle={[yours.length ? `${yours.join(' and ')} of yours` : null, whereTheyRunSaid([...products, ...own])].filter(Boolean).join(' · ')}
                  accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </Screen>
  );
}
