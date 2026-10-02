import { useEffect, useState } from 'react';
import { router, useIsFocused } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import type { FoundView } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAuth } from '../../state/AuthProvider';
import { useHome } from '../../state/HomeProvider';
import { pictureFor } from '../devices/registry';

export function FoundNearYou() {
  const { api } = useHome();
  const [found, setFound] = useState<FoundView[]>([]);
  const theme = useTheme();
  const { allowed } = useAuth();
  // The home page stays under every page opened from it: it looks for what is near only while it is seen.
  const seen = useIsFocused();

  useEffect(() => {
    if (!allowed || !seen) return;
    let live = true;
    const load = () =>
      api
        .nearby()
        .then((next) => live && setFound(next))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [allowed, api, seen]);

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
