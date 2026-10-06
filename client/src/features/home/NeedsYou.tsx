import { router, useIsFocused } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useAuth } from '../../state/AuthProvider';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { accountPath } from '../integrations/IntegrationScreen';

/** How often what waits on you is looked at again, while the home page is seen. */
const LOOK_AGAIN_MS = 15_000;

/**
 * What waits on you (docs/PLAN-INTEGRATIONS.md step 8): each device or
 * account that needs signing in to again, by its own words, a tap from the
 * page that fixes it — an account's under its integration. What is found
 * behind your accounts is offered beside it, under "Found near you". Nothing
 * when nothing waits.
 */
export function NeedsYou() {
  const { api } = useHome();
  const { allowed } = useAuth();
  const { heard, devices } = useDevices();
  const theme = useTheme();
  const seen = useIsFocused();
  const items = useAnswer(() => api.needsYou(), [api, heard.count], { every: LOOK_AGAIN_MS, when: allowed && seen }).value ?? [];
  const acts = items.flatMap((item) => (item.kind === 'act' ? [item] : []));
  if (!acts.length) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>{acts.length === 1 ? 'Needs you' : `Needs you · ${acts.length}`}</SectionLabel>
      <Card inset>
        {acts.map(({ device, detail }, index) => {
          const path = device.kind === 'account' && device.integration ? accountPath(device.integration.id, device.id) : `/device/${encodeURIComponent(device.id)}`;
          const typeId = devices.find((each) => each.id === device.id)?.typeId ?? null;
          return (
            <YStack key={device.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable onPress={() => router.push(path)}>
                <Row
                  leading={<DeviceImage typeId={typeId} size={36} />}
                  title={device.name}
                  subtitle={detail}
                  accessory={<Icon name="alert-circle" size={16} color={theme.warning?.val} />}
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </YStack>
  );
}
