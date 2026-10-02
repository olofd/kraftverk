import { router, useIsFocused } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useAuth } from '../../state/AuthProvider';
import { useHome } from '../../state/HomeProvider';
import { pictureFor } from '../devices/registry';

/** How often what is near is looked at again, while the home page is seen. */
const LOOK_AGAIN_MS = 10_000;

/**
 * What the home's transports can see that nothing you have is reached by:
 * a station that connected to its broker, a plug broadcasting on the network.
 * Choosing one skips straight to checking it.
 */
export function FoundNearYou() {
  const { api } = useHome();
  const theme = useTheme();
  const { allowed } = useAuth();
  // The home page stays under every page opened from it: it looks for what is near only while it is seen.
  const seen = useIsFocused();
  const found = useAnswer(() => api.nearby(), [api], { every: LOOK_AGAIN_MS, when: allowed && seen }).value ?? [];

  if (found.length === 0) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Found near you</SectionLabel>
      <Card inset>
        {found.map((entry, index) => {
          const first = entry.types[0]!;
          return (
            <YStack key={`${entry.transport}-${entry.address}`}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable
                onPress={() =>
                  router.push(
                    `/add-device?type=${encodeURIComponent(first.typeId)}&method=${encodeURIComponent(first.methodId)}&address=${encodeURIComponent(entry.address)}`
                  )
                }
              >
                <Row
                  leading={
                    // Its picture only when it is known what it is: one model's picture on "one of several plugs" would be a guess drawn as a fact.
                    entry.types.length === 1 && pictureFor(first.typeId) ? (
                      <DeviceImage typeId={first.typeId} size={36} />
                    ) : (
                      <YStack width={36} height={36} alignItems="center" justifyContent="center">
                        <Icon name="help-circle" size={20} color={theme.muted?.val} />
                      </YStack>
                    )
                  }
                  title={entry.name}
                  subtitle={`${first.name}${entry.types.length > 1 ? ` or ${entry.types.length - 1} more` : ''} · ${entry.detail ?? entry.address}`}
                  accessory={<Icon name="plus" size={16} color={theme.accent?.val} />}
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </YStack>
  );
}
